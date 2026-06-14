---
title: "Library 'Open task' opened a Q&A card because the LibraryItem read model dropped taskType"
date: "2026-06-14"
category: "docs/solutions/ui-bugs/"
module: "apps/web library routing + apps/desktop IPC browse read model"
problem_type: "ui_bug"
component: "frontend_stimulus"
severity: "medium"
symptoms:
  - "Clicking 'Open task' on the system Weekly review task in /library opened a Q&A reveal-answer card instead of the weekly review surface."
  - "The weekly-review task (SCHEDULED, OVERDUE, no linked element) fell through openQueueItem to /process, which then surfaced the next due card."
  - "No error surfaced — the renderer silently received taskType as undefined across the IPC boundary."
root_cause: "missing_workflow_step"
resolution_type: "code_fix"
related_components:
  - "routing"
  - "database"
  - "testing_framework"
tags:
  - "ipc"
  - "read-model"
  - "library-browse"
  - "task-routing"
  - "weekly-review"
  - "tasktype"
  - "openqueueitem"
  - "electron"
---

# Library "Open task" opened a Q&A card because the LibraryItem read model dropped taskType

## Problem

In the Library browse screen (`/library` -> `BrowseScreen.tsx`), clicking **Open task** on the
system "Weekly review" task opened a Q&A review card (a reveal-answer prompt) instead of the
weekly review surface. The renderer's central routing helper `openQueueItem` was correct; the
`LibraryItem` IPC read-model contract simply never carried the `taskType` field the helper needs.

## Symptoms

- The detail panel showed a "Weekly review" task — `type: task`, attention/"Topic" scheduler, D
  priority, SCHEDULED, OVERDUE, "No Source", "Not in queue: summary unavailable".
- Clicking **Open task** rendered a Q&A card (e.g. "What is BA +B?", "Reveal answer") with FSRS
  recall/stability chips — the tell-tale of landing in the `/process` queue loop on an item with
  no linked element, which surfaces whatever card is next due.
- No error was thrown; the field was silently `undefined` on the deserialized renderer object.

## What Didn't Work

Trusting the green unit test. `apps/web/src/pages/queue/openQueueItem.test.ts:136` already asserted
`{ type: "task", taskType: "weekly_review" } -> /weekly` and passed the whole time — because it
fed the helper a **hand-built** object that already included `taskType`. The routing logic was
never the bug. A helper unit test that builds its own fixture bypasses the real
`db row -> mapper -> IPC serialize -> renderer deserialize -> helper` chain, so it cannot catch a
field that is simply absent from the wire object.

## Solution

The weekly-review task is created with `taskType: "weekly_review"` and `linkedElementId: null`
(`packages/local-db/src/weekly-review-service.ts`). `openQueueItem` routes it to `/weekly` only
when `item.taskType === "weekly_review"` (`apps/web/src/pages/queue/openQueueItem.ts:56`). With
`taskType` undefined and the link null, both task branches missed and control fell to
`routeToProcess` -> `/process`.

**1. Populate `taskType` in the backend browse mapper** (`apps/desktop/src/main/db-service.ts`,
`libraryItemFor`) by reusing the existing `findTask` lookup:

```ts
// before
const linked =
  element.type === "task"
    ? (this.repos.tasks.findTask(element.id)?.linkedElement ?? null)
    : null;

// after
const task = element.type === "task" ? this.repos.tasks.findTask(element.id) : null;
const linked = task?.linkedElement ?? null;
// ...and in the returned LibraryItem literal:
taskType: task?.taskType ?? null,   // was absent — the root cause
```

**2. Add the field to BOTH `LibraryItem` mirror declarations** (they are parallel copies, not a
shared import) — `apps/desktop/src/shared/contract.ts` and `apps/web/src/lib/appApi.ts`:

```ts
readonly linkedElementType: string | null;
/** For a `task` row, its task type (e.g. `"weekly_review"`); `null` for non-task rows. */
readonly taskType: TaskType | null;
```

No routing logic changed.

## Why This Works

The defect was a read-model contract gap at the IPC boundary, not faulty branching. Once the
mapper emits `taskType` and both mirrors declare it, the serialized browse row carries the field
across the renderer<->main boundary, `openQueueItem`'s `weekly_review -> /weekly` branch matches,
and the task opens its dedicated surface. Non-task rows get `taskType: null`, so nothing else
changes. The queue/home surfaces were already correct because their read model
(`packages/local-db/src/queue-query.ts`) had always populated `taskType` — only the Library browse
mapper omitted it.

## Prevention

**1. Test the producer, not just the helper.** `apps/desktop/src/main/db-service.test.ts` now
asserts on the real deserialized browse row, and uses `toBeNull()` (not `toBeFalsy()`) so a
dropped field — which reads as `undefined`, falsy but not null — fails the test:

```ts
expect(row?.taskType).toBe("find_better_source"); // task row carries its type
expect(card?.taskType).toBeNull();                // non-task row is explicit null
// weekly-review task is tagged so it routes to /weekly, not /process:
svc.updateAppSettings({ weeklyReviewEnabled: true });
const weekly = svc.libraryBrowse({ types: ["task"] })
  .items.find((i) => i.taskType === "weekly_review");
expect(weekly).toBeDefined();
expect(weekly?.linkedElementId).toBeNull(); // routing relies solely on taskType
```

**2. Add an E2E that exercises the real IPC round-trip.** Only an end-to-end test catches a
producer that serializes without a field even when both interfaces declare it, or drift between
the two mirrors. `tests/electron/weekly-open-routing.spec.ts` drives the built app:

```ts
await enableWeeklyReview(page);          // typed settings bridge creates the task
await page.goto(`${baseUrl}/library`);
await page.getByTestId("library-group-task").getByTestId("library-result")
  .filter({ hasText: "Weekly review" }).click();
await page.getByTestId("library-detail-open").click();
await expect(page.getByTestId("weekly-review")).toBeVisible();
expect(page.url()).toContain("/weekly");
```

**3. Keep the two `LibraryItem` mirrors in lock-step.** TypeScript validates the producer's return
against `contract.ts`, but the renderer mirror in `appApi.ts` is not structurally connected to
that check — adding a field to one and forgetting the other yields no type error and a runtime
routing failure. Add the field to both in the same commit.

**4. Don't test a routing helper only with hand-built fixtures.** The correct pyramid: (a) mapper
unit test asserts the field is emitted, (b) component test passes a fixture through the real
`openQueueItem`, (c) E2E validates the full stack.

## Related Learnings

- [system-owned-recurring-tasks](../architecture-patterns/system-owned-recurring-tasks.md) — the
  canonical pattern this bug violated: queue/read-model rows must expose `taskType` so the renderer
  routes system tasks to `/weekly`. This is the concrete instance of that read-model field being
  missing from `LibraryItem`.
- [active-card-rows-open-card-detail-surface](active-card-rows-open-card-detail-surface.md) — sibling
  `openQueueItem` fallthrough opening the wrong surface; same prevention lesson (centralize
  row-open routing), different root-cause layer (missing branch vs. missing contract field).
- [queue-eligibility-inventory-scheduler-state](../logic-errors/queue-eligibility-inventory-scheduler-state.md)
  — same class of bug: a field omitted from an IPC read-model contract makes the renderer fall
  through to incorrect behavior; push typed decisions to the trusted side.
- [daily-work-read-model-inbox-only-routing](daily-work-read-model-inbox-only-routing.md) — keep
  routing decisions behind a typed main-side read model rather than inferring them in React.
