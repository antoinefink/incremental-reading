---
title: Queue Eligibility Language
status: active
date: 2026-06-08
origin: user request
execution: code
---

# Queue Eligibility Language

## Problem Frame

`Due today` currently leaks from raw scheduler fields into inventory surfaces. A completed
extract can keep an old `elements.due_at` and still look due in Library/Search even though
the Queue correctly excludes it. In a gold-standard incremental reading workflow, due
language must mean an item is actionable in today's queue; inventory surfaces may show
history and lifecycle state, but must not borrow queue obligation language for inactive
items.

## Scope

In scope:

- Introduce one reusable queue-eligibility/read-model rule for cards and attention items.
- Use that rule when enriching Library/Search rows and inspector-adjacent detail panels.
- Keep Queue behavior aligned with the existing two-scheduler split.
- Make queue-exit actions remove active queue scheduling while preserving undo.
- Add a Maintenance report for scheduler-state inconsistencies.
- Fix Library browse selection so it synchronizes with the universal inspector.
- Add regression tests for due labels, queue absence explanations, state transitions,
  undo, and maintenance detection.

Out of scope:

- Adding schema columns such as `completed_at` or `last_due_at` unless implementation proves
  they are required. The first pass should preserve history through `operation_log` and avoid
  a migration if possible.
- Changing FSRS grading behavior.
- Changing the core attention scheduling intervals.

## Requirements Trace

- `Due today` means queue-actionable, not merely `due_at <= now`.
- Queue eligibility is: live row, actionable lifecycle status, scheduler due at or before
  `asOf`, and not suspended/dismissed/done/deleted/retired.
- Done/dismissed/suspended/deleted rows must not display actionable due badges outside Queue.
- Mark Done must set status `done` and remove active queue scheduling.
- Postpone/schedule is the "return later" action; `done` is not "done for now".
- Library/Search detail panels must explain why a scheduled-history row is not in Queue.
- Library row click must update the universal inspector selection.
- Maintenance must surface inactive rows with scheduler dates, non-reviewable cards with
  stale review due dates, and active rows missing expected schedules.

## Existing Patterns

- `packages/local-db/src/queue-repository.ts` already encodes queue exclusion predicates for
  cards and attention items.
- `packages/local-db/src/queue-query.ts` builds the due Queue read and `summaryFor`.
- `apps/desktop/src/main/db-service.ts` enriches Library/Search rows through `queueQuery` and
  inspector helpers.
- `apps/web/src/library/BrowseScreen.tsx` and `apps/web/src/library/LibraryScreen.tsx` render
  due labels/badges.
- `packages/local-db/src/queue-action-service.ts` owns Queue exit actions and undo recipes.
- `apps/desktop/src/main/maintenance-service.ts` composes Maintenance reports; local-db owns
  read-only report queries.

## Implementation Units

### U1: Canonical Queue Eligibility Read Model

Files:

- Modify: `packages/local-db/src/queue-repository.ts`
- Modify: `packages/local-db/src/queue-query.ts`
- Modify: `packages/local-db/src/index.ts`
- Test: `packages/local-db/src/queue-query.test.ts`
- Test: `packages/local-db/src/queue-repository.test.ts`

Approach:

- Extract explicit `isQueueActionableStatus` / `isQueueEligibleElement` helpers or a small
  `QueueEligibilityQuery` near the existing Queue read layer.
- Keep cards and attention items separate: cards use `review_states.due_at`; attention items
  use `elements.due_at`.
- Make `summaryFor` state-aware so non-eligible rows can return neutral inventory labels and
  a reason instead of `Due today`.

Test scenarios:

- Scheduled extract due today is queue eligible and returns `Due today`.
- Done/dismissed/suspended extract with `due_at` today is not queue eligible and does not
  return actionable due language.
- Due card whose element status is suspended/done is not queue eligible.
- Retired card is not queue eligible.

### U2: Inventory Surface Labels and Selection

Files:

- Modify: `apps/desktop/src/shared/contract.ts`
- Modify: `apps/web/src/lib/appApi.ts`
- Modify: `apps/desktop/src/main/db-service.ts`
- Modify: `apps/web/src/library/BrowseScreen.tsx`
- Modify: `apps/web/src/library/LibraryScreen.tsx`
- Test: `apps/desktop/src/main/db-service.test.ts`
- Test: `apps/web/src/library/BrowseScreen.test.tsx`
- Test: `apps/web/src/library/LibraryScreen.test.tsx`

Approach:

- Extend Library/Search row contracts with queue eligibility and a short `queueReason` /
  `notInQueueReason`.
- Render actionable badge colors only when the row is queue eligible.
- Render state-aware inventory labels: `Done`, `Suspended`, `Dismissed`, `Inbox`,
  `No return scheduled`, or `Returns <date>` for future scheduled work.
- Keep row meta concise; detail panels can include the explanatory reason.
- On Library browse row click, call both local `setSelId` and universal `select`.
- Ensure Search results follow the same selection behavior.

Test scenarios:

- Done extract with `due_at` today renders `Done`, not `Due today`, in Library browse.
- Detail panel shows `Not in queue: status is Done`.
- Scheduled future attention row renders `Returns <date>`.
- Clicking a Library browse row calls the universal selection hook.
- Search row click also synchronizes inspector selection.

### U3: Queue Exit State and Maintenance Diagnostics

Files:

- Modify: `packages/local-db/src/queue-action-service.ts`
- Modify: `packages/local-db/src/undo-service.ts`
- Modify: `packages/local-db/src/lineage-gap-query.ts` or add a focused report query
- Modify: `apps/desktop/src/main/maintenance-service.ts`
- Modify: `apps/desktop/src/shared/contract.ts`
- Modify: `apps/web/src/lib/appApi.ts`
- Modify: `apps/web/src/maintenance/MaintenanceScreen.tsx`
- Test: `packages/local-db/src/queue-action-service.test.ts`
- Test: `packages/local-db/src/undo-service.test.ts`
- Test: `apps/desktop/src/main/maintenance-service.test.ts`
- Test: `apps/web/src/maintenance/MaintenanceScreen.test.tsx`

Approach:

- For `markDone` and `dismiss`, clear the active scheduler field that drives queue entry
  (`elements.due_at`; for cards also `review_states.due_at` if relevant) while capturing the
  prior due values in the existing operation-log preimage/payload so undo restores them.
- Leave postpone/schedule as the explicit "return later" path.
- Add a read-only scheduler consistency report:
  inactive rows with scheduler dates, non-reviewable cards with stale review due, and active
  attention rows that are expected to be scheduled but lack `due_at`.
- Surface the report as a count and expandable list in Maintenance.

Test scenarios:

- Mark Done removes an extract from Queue and clears active `due_at`.
- Dismiss clears active `due_at`.
- Delete removes from Queue through soft delete.
- Postpone preserves queue semantics by moving due into the future.
- Undo restores status and the prior scheduler values for done/dismiss/postpone/delete.
- Maintenance reports seeded inconsistent scheduler rows and ignores healthy rows.

## Verification

- `pnpm --filter @interleave/local-db test`
- `pnpm --filter @interleave/desktop test`
- `pnpm --filter @interleave/web test`
- `pnpm typecheck`
- `pnpm test`

## Risks

- Clearing `due_at` can break undo if preimages are incomplete. Verify operation-log undo
  restores both lifecycle and scheduler state.
- Library/Search contracts are broad IPC surfaces. Update shared contract, web mirror types,
  and tests together.
- Maintenance report scope can grow. Keep it read-only and focused on scheduler consistency.
