---
title: "Attention scheduler recency needs separate last-seen and action clocks"
date: "2026-06-12"
category: "docs/solutions/logic-errors"
module: "attention-scheduler"
problem_type: "logic_error"
component: "service_object"
symptoms:
  - "Otherwise-identical attention items with different lastSeenAt values received identical next due dates."
  - "Scheduler writes risked overwriting the pre-action updatedAt before it could be used as recency input."
  - "Manual or malformed date inputs could reach scheduling paths without canonical UTC validation."
root_cause: "logic_error"
resolution_type: "code_fix"
severity: "medium"
related_components:
  - "database"
  - "testing_framework"
tags:
  - "attention-scheduler"
  - "last-seen-at"
  - "clock-semantics"
  - "operation-log"
  - "manual-date-validation"
---

# Attention scheduler recency needs separate last-seen and action clocks

## Problem

The attention scheduler carried `lastSeenAt` on its descriptor but did not consume it, so work touched yesterday and work ignored for a month could receive identical next due dates.

Making recency real exposed a clock-semantics trap: the scheduler needs the pre-action row timestamp as input, the injected action clock as the scheduling anchor, and a scheduler-specific decision timestamp for diagnostics. Treating every timestamp as interchangeable either erases recency or creates false drift.

## Symptoms

- Two non-card elements with the same priority, type, and action but different `lastSeenAt` values produced the same `dueAt`.
- Updating `elements.updated_at` too early would make every heuristic action look freshly seen before recency was computed.
- Broad `updated_at` drift checks could false-positive after unrelated edits.
- Explicit manual dates and `queueSoon` commands could be mistaken for heuristic scheduler decisions.
- Loose manual-date parsing could normalize invalid-looking input into a real persisted due date.

## What Didn't Work

- Leaving `lastSeenAt` as a reserved descriptor field preserved deterministic behavior, but contradicted the M23 scheduler contract and made adaptive scheduling impossible.
- Reading broad `elements.updated_at` for diagnostics was too imprecise because later non-scheduling edits can advance it.
- Persisting the caller's planner clock from explicit `scheduleAt` as `updated_at` polluted future recency. Recovery-mode and queue flows can pass `asOf` clocks that are useful for planning but not trustworthy evidence that the element was heuristically processed at that instant.
- Letting JavaScript `Date.parse` accept non-canonical manual strings made impossible dates and loose ISO forms silently normalize.

## Solution

Keep heuristic scheduling, explicit scheduling, and diagnostics on separate timestamp channels.

For heuristic actions such as `extract`, `rewrite`, `activate`, `done`, and `postpone`, build the descriptor from the pre-action row, compute from the injected `now`, then persist the action clock and a scheduler decision marker in the same reschedule transaction:

```ts
const decision = nextDueAt(this.toSchedulable(element, action), now);

this.elements.rescheduleWithin(
  tx,
  id,
  decision.dueAt,
  "scheduled",
  { action, scheduledAt: now },
  { updatedAt: now },
);
```

In the pure scheduler, apply recency only after the base interval has been chosen and source-processing adjustments have run:

```ts
const override = actionOverrideIntervalDays(input);
const baseIntervalDays = override ?? heuristicIntervalDays(input);
const adjusted = adjustForSourceProcessing(input, baseIntervalDays);
const intervalDays = applyRecencyCredit(adjusted.intervalDays, input.lastSeenAt, now);
```

Keep the recency helper conservative:

- missing, null, invalid, or future `lastSeenAt` preserves the base interval;
- sub-day age preserves the base interval;
- whole-day age subtracts bounded credit;
- credit is capped at half the base interval;
- the final interval is clamped to at least one day.

Keep explicit scheduling outside heuristic recency. `scheduleAt()` should write a `choice` payload and should not persist the planner `now` as `updated_at`:

```ts
this.elements.rescheduleWithin(tx, id, decision.dueAt, "scheduled", {
  choice: typeof choice === "string" ? choice : "manual",
  ...(batchId ? { batchId } : {}),
});
```

Use `operation_log` payloads for scheduler-specific diagnostics. The drift scan should inspect the latest `reschedule_element` payload, exclude explicit choices and `queueSoon`, and only flag heuristic rows whose stored due date is not after the scheduler decision timestamp:

```sql
json_type(lr.payload, '$.choice') IS NULL
AND COALESCE(json_extract(lr.payload, '$.queueSoon'), 0) != 1
AND json_extract(lr.payload, '$.action') IN (...)
AND julianday(e.due_at) <= julianday(json_extract(lr.payload, '$.scheduledAt'))
```

Batch the diagnostic in SQL rather than performing one `operation_log` lookup per candidate element. Pass the remaining caller limit into the heavier query so `SchedulerConsistencyQuery.list(limit)` can stop work before scanning everything.

Validate manual dates at both boundaries:

- IPC/request schemas reuse the canonical UTC `IsoTimestampInputSchema`;
- `scheduleManual()` rejects non-canonical strings and impossible dates;
- trusted internal `Date` objects may still be normalized.

## Why This Works

The scheduler now consumes historical recency without letting the mutation itself erase the signal. The descriptor's `lastSeenAt` comes from the row before the action, while the returned due date is still anchored to the injected action clock.

The operation log now distinguishes "the scheduler made this heuristic decision at time X" from generic row activity. That lets diagnostics detect impossible heuristic schedules without false-positiveing manual past dates, immediate queueing, or unrelated later edits.

Explicit user choices stay explicit. Tomorrow, next week, next month, manual date, and queue-soon commands are scheduling intents, not inferred evidence that the heuristic scheduler processed the item.

Canonical date validation prevents a caller from accidentally persisting a due date the user did not specify, such as JavaScript's normalized version of an impossible calendar date.

## Prevention

- Use separate names and payload fields for scheduler input time, action clock, and diagnostic decision time.
- Compute heuristic recency from the pre-action row before mutating `updated_at`.
- Add `scheduledAt` only to heuristic reschedule payloads, not to explicit choices.
- Exclude `payload.choice`, `queueSoon`, cards, terminal statuses, and missing/invalid decision timestamps from heuristic drift diagnostics.
- Keep maintenance diagnostics batched and limit-aware; do not add per-row log probes inside a broad `.all().filter(...)` scan.
- Reuse canonical timestamp schemas at IPC boundaries and repeat defensive validation in pure scheduler helpers.
- Test both sides of each boundary: pure scheduler edge cases, service-level timestamp persistence, operation-log diagnostic exclusions, contract validation, and Electron queue/scale coverage.

## Related Issues

- [Queue eligibility must be canonical across inventory, actions, and undo](./queue-eligibility-inventory-scheduler-state.md) documents backend-owned scheduler semantics and the maintenance diagnostic precedent this extends.
- [Chronic postpone reckoning from operation-log reset markers](../architecture-patterns/chronic-postpone-reckoning-from-operation-log-reset-markers.md) documents operation-log-derived scheduler inputs and effective scheduler state.
- [Inbox Queue soon schedules sources due now without opening the reader](../workflow-issues/inbox-triage-queue-soon-attention-scheduling.md) is the explicit-command contrast case; `queueSoon` should be excluded from heuristic recency drift checks.
- [Daily work read model routes inbox-only days honestly](../ui-bugs/daily-work-read-model-inbox-only-routing.md) covers the adjacent rule that active sources need scheduler-owned return dates rather than renderer inference.
- [Track source block processing as durable source-scoped state](../architecture-patterns/durable-source-block-processing-state.md) is the related source-processing input seam for future adaptive scheduler work.
