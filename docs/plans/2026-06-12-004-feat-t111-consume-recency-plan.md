---
title: "T111 Consume Recency"
type: feat
date: 2026-06-12
task: T111
---

# T111 Consume Recency

## Summary

T111 makes `lastSeenAt` a real input to the attention scheduler without adding schema or UI surface area. The pure scheduler will apply a bounded recency credit after the existing priority/stage/action/source-processing interval is chosen, and `SchedulerService` will compute that credit from the pre-action scheduler recency while persisting the current action clock as the new `updated_at`.

## Problem Frame

`packages/scheduler/src/attention-scheduler.ts` currently documents `Schedulable.lastSeenAt` as reserved and ignores it in `nextDueAt`. `packages/local-db/src/scheduler-service.ts` already passes `element.updatedAt`, but the pure scheduler still treats an item seen yesterday and an item untouched for a month identically when computing the next return. M23's first adaptive-scheduler task closes that spec/code gap while preserving the two-scheduler split: sources, topics, extracts, tasks, and synthesis notes use the attention scheduler; cards stay on FSRS.

## Requirements

- R1. `nextDueAt` must consume `lastSeenAt` deterministically from the injected `now` clock, with no `Date.now()` inside scheduler math.
- R2. Missing, null, invalid, or future `lastSeenAt` must preserve legacy base behavior rather than creating negative or surprising intervals.
- R3. Two otherwise-identical attention items with different valid `lastSeenAt` values must produce correctly ordered next dues: recently seen items get the full base interval, while older items receive a bounded sooner return.
- R4. Recency must apply after the existing base interval sources are selected: priority bands, extract stage bands, topic `defaultTopicIntervalDays`, action overrides, and source-processing adjustments remain the source of the base interval.
- R5. `SchedulerService` must use the pre-action scheduler recency as the descriptor `lastSeenAt`, persist the current action clock as `elements.updated_at`, and compute `elements.due_at` from the same injected `now` clock in the existing transaction.
- R6. T111 must not add schema, touch `review_states`, expose new renderer authority, or collapse FSRS and attention scheduling.
- R7. Scheduler consistency diagnostics must gain a focused drift case for heuristic attention schedules whose stored due date predates the scheduler decision time, without flagging explicit manual past schedules or immediate queue-soon rows.
- R8. `docs/scheduling-and-priority.md`, `docs/tasks/M23-adaptive-scheduler.md`, and `docs/roadmap.md` must reflect the completed T111 behavior after implementation.

## Key Technical Decisions

- KTD1. Use a bounded recency-credit helper in `packages/scheduler`: compute whole-day age from `lastSeenAt` to `now`, subtract up to `Math.floor(baseIntervalDays / 2)` days from the chosen base interval, and clamp the result to at least one day. Ages below one full day apply no credit. This keeps T111 small and deterministic while making older untouched items return sooner than fresh work.
- KTD2. Treat invalid, missing, null, or future `lastSeenAt` as no recency signal. This avoids breaking imported data, manual test fixtures, and clock-skewed rows.
- KTD3. Apply recency after `adjustForSourceProcessing`. The current source-block signals already shorten high-value unresolved sources and lengthen mostly ignored no-output sources; recency is a final freshness term on the chosen interval, not a replacement for progress/yield.
- KTD4. In `SchedulerService`, distinguish pre-action scheduler recency from post-action mutation time. Use the loaded element's scheduler recency as `lastSeenAt` so older untouched rows receive credit, and pass the action `now` through persistence so the row's new `updated_at` records the touch that just happened.
- KTD5. Add the drift diagnostic in `SchedulerConsistencyQuery` by inspecting scheduler-specific `reschedule_element` payload shape. Heuristic actions will record a decision timestamp such as `scheduledAt`; diagnostics flag `due_at <= scheduledAt`, not broad `updated_at` drift. Explicit choices (`payload.choice`), `queueSoon`, and manual past schedules remain allowed.

## Scope Boundaries

- T111 does not implement T112's yield-adaptive multiplier, persistence column, adaptive-interval flag, or scheduler reason vocabulary.
- T111 does not change queue sorting, queue eligibility, renderer due labels, or inventory scheduler state semantics.
- T111 does not infer last-seen recency from read-point writes unless the existing command path also performs a scheduler action.
- T111 does not add a new operation type or durable `last_seen_at` column.

## Implementation Units

### U1. Pure Recency Math

- **Goal:** Replace the old placeholder `lastSeenAt` contract with a pure recency-credit rule in `packages/scheduler`.
- **Files:** Modify `packages/scheduler/src/attention-scheduler.ts`; modify `packages/scheduler/src/attention-scheduler.test.ts`.
- **Patterns to follow:** Existing pure helpers `postponeIntervalForPriority`, `heuristicIntervalDays`, `adjustForSourceProcessing`, and `addDays` from `packages/scheduler/src/date-util.ts`.
- **Approach:** Add a small helper that receives the adjusted base interval, `lastSeenAt`, and `now`, then returns `{ intervalDays, recencyApplied }` or just the final interval. Keep the exported `ScheduleDecision` surface unchanged for T111 unless tests need no new field. Remove the reserved comments from the descriptor and `nextDueAt` documentation.
- **Test scenarios:** 
  - Never-seen B source keeps the legacy seven-day base interval.
  - B source seen at `now` keeps the full base interval.
  - B source last seen three days ago returns in four days.
  - B source last seen thirty days ago returns in four days because whole-day credit is capped at `Math.floor(7 / 2)`.
  - B source seen 23 hours ago keeps the full seven-day interval; one seen exactly one day ago returns in six days.
  - Raw extract, topic default interval, postpone action, done action, high-value unresolved source, and mostly ignored no-output source each apply recency after their existing base interval.
  - Invalid and future `lastSeenAt` are ignored.
- **Verification:** `pnpm --filter @interleave/scheduler test -- attention-scheduler`.

### U2. SchedulerService Last-Seen Wiring

- **Goal:** Ensure local-db computes recency from the pre-action row and persists the current processing clock as the new `updated_at`.
- **Files:** Modify `packages/local-db/src/scheduler-service.ts`; modify `packages/local-db/src/scheduler-service.test.ts`; modify `packages/local-db/src/element-repository.ts`; modify `packages/local-db/src/repositories.test.ts` or focused element-repository coverage.
- **Patterns to follow:** Existing transaction flow in `rescheduleForAction`, `activateSourceWithReturnElement`, and `previewPostpone`; `ElementRepository.rescheduleWithin` for due/status/op-log writes.
- **Approach:** Update `toSchedulable` to accept an optional effective pre-action last-seen timestamp, defaulting to `element.updatedAt`. Keep heuristic computations anchored to the injected `now` argument. Add a narrow optional mutation timestamp to `ElementRepository.rescheduleWithin` / `reschedule` so scheduler actions can persist the same injected action clock as `updated_at`, while existing callers keep the `nowIso()` default. Record a scheduler-specific decision timestamp such as `scheduledAt` in heuristic `reschedule_element` payloads for diagnostics. Avoid changing explicit `scheduleAt`, because explicit choices are user-picked dates rather than heuristic recency decisions.
- **Test scenarios:**
  - Two otherwise-identical source/topic/extract rows with different pre-action `updated_at` values produce different service-level `dueAt` values under the same action clock.
  - `activateSourceWithReturn` keeps status `active`, computes the return from pre-action recency, and persists the activation clock as `updated_at`.
  - Postpone preview and apply still agree.
  - `ElementRepository.rescheduleWithin` persists an injected `updatedAt` exactly and defaults to existing `nowIso()` behavior when omitted.
  - Source/topic/extract rescheduling still creates no `review_states` row.
- **Verification:** `pnpm --filter @interleave/local-db test -- scheduler-service`.

### U3. Drift Diagnostic

- **Goal:** Add a read-only maintenance signal for stored attention schedules that contradict effective last-seen recency.
- **Files:** Modify `packages/local-db/src/scheduler-consistency-query.ts`; modify `packages/local-db/src/scheduler-consistency-query.test.ts`; update type mirrors if required in `apps/desktop/src/shared/contract.ts` and `apps/web/src/lib/appApi.ts`.
- **Patterns to follow:** Existing `SchedulerConsistencyReason` union and query methods in `packages/local-db/src/scheduler-consistency-query.ts`; existing maintenance bridge only if the union is mirrored through contract types.
- **Approach:** Add a reason such as `attention-due-before-last-seen` for live non-card rows whose latest `reschedule_element` payload is a heuristic scheduler action (`extract`, `rewrite`, `activate`, `done`, `postpone`) and whose stored `due_at` is not after the payload's scheduler decision timestamp. Exclude `payload.choice`, `payload.queueSoon === true`, and missing/invalid decision timestamps. Keep the query read-only.
- **Test scenarios:**
  - Scheduled source with `due_at <= scheduledAt` and an action-based `reschedule_element` op is reported.
  - Explicit manual past schedule is not reported.
  - Queue-soon rows are not reported.
  - Rows whose due date is after the scheduler decision timestamp are not reported, even when later non-scheduling updates advance `updated_at`.
- **Verification:** `pnpm --filter @interleave/local-db test -- scheduler-consistency-query`.

### U4. Documentation And Roadmap

- **Goal:** Align docs with the implemented scheduler behavior and mark T111 complete after verification.
- **Files:** Modify `docs/scheduling-and-priority.md`; modify `docs/tasks/M23-adaptive-scheduler.md`; modify `docs/roadmap.md`.
- **Patterns to follow:** Completion notes for T104-T110 in `docs/roadmap.md` and checked task-spec boxes in nearby task files.
- **Approach:** Replace the old "last processed date" promise with the concrete recency-credit behavior and update T111 checkboxes only after implementation and verification pass. Record the final commit reference in `docs/roadmap.md`.
- **Test scenarios:** Documentation has no executable tests; verify that live roadmap, scheduler, and M23 task docs describe `lastSeenAt` as a consumed input while intentional historical ideation notes remain clearly historical.
- **Verification:** `pnpm lint` includes doc formatting checks where applicable.

## System-Wide Impact

The change is behavior-bearing but bounded to attention scheduling. It affects any service that calls `nextDueAt`, including queue actions, inbox activation return dates, auto-postpone preview/apply, and task/source/extract scheduling. It should not change FSRS card scheduling, raw queue eligibility predicates, or renderer authority.

Queue stability must be checked with the existing M20 large-collection harness or equivalent seeded 100k queue materialization path after the recency rule lands. The expected result is no pathological first-run queue churn and no material regression against the existing harness conventions.

## Risks & Dependencies

- `elements.updated_at` is a broad activity timestamp, so drift diagnostics must not treat it as scheduler-specific after arbitrary later updates.
- Existing tests sometimes use wall-clock defaults. T111 tests should inject fixed clocks for any exact due-date expectation.
- A naive drift diagnostic can false-positive manual past schedules and queue-soon rows. The query should inspect operation payloads and exclude explicit choices and immediate queueing.
- T112 and T113 will later add learned multipliers and visible explanations; T111 should leave extension points without adding user-facing reason copy prematurely.

## Sources / Research

- `docs/tasks/M23-adaptive-scheduler.md` defines T111 and the shared M23 invariants.
- `packages/scheduler/src/attention-scheduler.ts` contains the `lastSeenAt` descriptor and pure `nextDueAt` path.
- `packages/local-db/src/scheduler-service.ts` already builds scheduler descriptors and applies transactional reschedules.
- `packages/local-db/src/scheduler-consistency-query.ts` is the existing maintenance scan for scheduler drift.
- `docs/solutions/logic-errors/queue-eligibility-inventory-scheduler-state.md` reinforces canonical backend scheduler state and drift diagnostics.
- `docs/solutions/architecture-patterns/chronic-postpone-reckoning-from-operation-log-reset-markers.md` reinforces operation-log-derived scheduler inputs.
