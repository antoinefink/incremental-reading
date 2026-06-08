---
title: "Queue eligibility must be canonical across inventory, actions, and undo"
date: "2026-06-08"
category: "docs/solutions/logic-errors/"
module: "queue eligibility and scheduler state"
problem_type: "logic_error"
component: "service_object"
symptoms:
  - "Library and Search could show a stale actionable due label for rows absent from Queue."
  - "Mark done and dismiss could leave active scheduling state behind terminal rows."
  - "Undoing a card queue exit could restore FSRS due state without making the inverse undo clear it again."
root_cause: "logic_error"
resolution_type: "code_fix"
severity: "medium"
related_components:
  - "database"
  - "frontend_stimulus"
  - "testing_framework"
tags:
  - "queue"
  - "scheduler"
  - "inventory"
  - "undo"
  - "fsrs"
  - "maintenance"
  - "ipc"
---

# Queue eligibility must be canonical across inventory, actions, and undo

## Problem

Inventory surfaces were showing scheduler history as if it were current due queue membership. A row could say "Due today" in Library/Search while being absent from Queue because its lifecycle status or card retirement state made it ineligible.

The mutation side had the same mismatch: queue exit actions changed status but could leave active due state behind. That stale state then depended on read-side filters to stay hidden, and card undo paths could reintroduce live FSRS due state on terminal cards.

## Symptoms

- A Library/Search/Concept row with `status: done`, `dismissed`, or `suspended` could still display an actionable-looking due label if `dueAt` or `review_states.due_at` remained.
- Queue correctly excluded the row, so the user saw "due today" in inventory but nothing in `/queue`.
- `markDone`/`dismiss` removed the row by status, but did not necessarily clear the active schedule.
- Card queue exit needed to clear both `elements.due_at` and `review_states.due_at`; otherwise FSRS still considered the card scheduled.
- Global undo and snackbar undo had to be symmetric. Restoring a queue-exited card must log enough preimage data that undoing that undo clears review due again.

## What Didn't Work

- Letting React infer actionability from `dueAt` was too weak. It cannot know status exclusions, retired-card state, or whether the governing due date comes from `review_states`.
- Renaming the label in a single component would have left Search, Browse, Concept members, semantic rows, Home, and Queue with different semantics.
- Relying only on `QueueRepository` filters hid stale scheduler state but did not explain it in inventory or remove it from terminal rows.
- Clearing only `elements.due_at` for cards was incomplete because the due queue reads card due dates from `review_states.due_at`.
- Restoring card review due during undo without adding an inverse op payload made redo-style command undo recreate an inconsistent terminal card with live FSRS due.

## Solution

Make queue eligibility a domain/read-model fact, not a renderer guess.

Export the queue-excluded status rule from `QueueRepository`:

```ts
export const QUEUE_EXCLUDED_STATUSES: readonly ElementStatus[] = [
  "done",
  "dismissed",
  "suspended",
  "deleted",
];

export function isQueueActionableStatus(status: ElementStatus): boolean {
  return !QUEUE_EXCLUDED_STATUSES.includes(status);
}
```

Have `QueueQuery.summaryFor` enrich every inventory summary with:

```ts
readonly queueEligible: boolean;
readonly notInQueueReason: string | null;
```

Queue list rows are already eligible by construction. Inventory rows call the same summary builder but get honest labels:

- `Done`, `Dismissed`, `Suspended` for terminal statuses.
- `No return scheduled` when no due exists.
- `Returns Jun 13` for future schedules.
- `Due today`, `Overdue`, or `in Nd` only when the row is actually queue-eligible at the read clock.

Thread those fields through every inventory producer that displays scheduler state: Search, Semantic Search, Library Browse, and Concept members. Keep the fields required in the typed contract so all mocks and producers must opt into the canonical semantics.

On the mutation side, make queue exit remove active scheduling:

```ts
return this.elements.updateWithin(
  tx,
  element.id,
  { status, dueAt: null },
  {
    extras: {
      queueExit: true,
      ...(previousReviewDueAt !== undefined ? { prevReviewDueAt: previousReviewDueAt } : {}),
    },
  },
);
```

For cards, clear `review_states.due_at` in the same transaction. Include `previousDueAt` and `previousReviewDueAt` in the snackbar undo recipe.

Global undo must make the inverse operation symmetric. Before restoring a card's review due, read the current review due and put it into the inverse `update_element` payload:

```ts
const currentReviewDueAt = tx
  .select({ dueAt: reviewStates.dueAt })
  .from(reviewStates)
  .where(eq(reviewStates.elementId, id))
  .get()?.dueAt ?? null;

const el = this.elements.updateWithin(tx, id, prev, {
  extras: { queueExit: true, prevReviewDueAt: currentReviewDueAt },
});
```

Then set `review_states.due_at` to the restored value. Undoing that undo now has enough data to clear review due again.

Finally, add a read-only maintenance diagnostic for scheduler drift:

- terminal live elements with `elements.due_at`;
- terminal cards with `review_states.due_at`;
- retired cards with `review_states.due_at`;
- scheduled attention rows missing `elements.due_at`.

Maintenance reports the count and exposes a drill-down read. The low-value cleanup scan excludes terminal statuses so it does not propose already-finished rows as stale work.

## Why This Works

The due queue keeps its narrow meaning: currently actionable work. Inventory surfaces can still show scheduler history, but they no longer use action-colored due badges unless the item belongs in the due queue at the current clock.

The main process remains the owner of queue semantics. React receives explicit `queueEligible` and `notInQueueReason` fields rather than duplicating status, card-retirement, and scheduler-source checks.

Clearing active schedule on queue exit makes terminal rows true terminal rows instead of live scheduled rows hidden by filters. Cards need special handling because their active schedule is FSRS-backed in `review_states`, not only `elements.due_at`.

The undo fix keeps operation-log inverses coherent. Every queue-exit transition that touches review due logs the review-due preimage for the next inverse, so command undo can alternate between exit and restore without leaving stale FSRS due state behind.

## Prevention

- Treat due labels as display labels for a specific read model, not as proof of queue membership.
- Keep queue exclusion predicates in `QueueRepository` or a helper exported from it; do not rederive them in React.
- Inventory rows that display scheduler state should carry both the label and the eligibility/reason fields from the backend.
- Queue exit actions should clear active schedule as part of the status transition.
- Card queue exit must update `review_states.due_at` and `elements.due_at` in one transaction.
- Any undo path that restores card review due must log the current review due as the next inverse preimage.
- Add regression tests for direct action, snackbar undo, global undo, and undoing the undo.
- Add maintenance diagnostics for scheduler drift instead of silently relying on queue filters to hide stale data.

## Related Issues

- [Daily work read model routes inbox-only days honestly](../ui-bugs/daily-work-read-model-inbox-only-routing.md) documents the adjacent rule that Queue remains only due scheduled work.
- [Balance banner actions should stay actionable and dismissible](../ui-bugs/balance-banner-queue-inbox-action-gating.md) documents the precedent for routing UI actions from currently actionable counts rather than broader analytics.
- [Extract inspector single-responsibility layout and scheduler refresh](../ui-bugs/extract-inspector-single-responsibility-lineage-scheduler.md) documents the adjacent scheduler-boundary rule for cross-surface refresh.
- [Review analytics data capture in review logs](../architecture-patterns/review-analytics-data-capture-in-review-logs.md) documents the related FSRS preimage principle: scheduler writes need enough prior state to reject or invert stale transitions.
