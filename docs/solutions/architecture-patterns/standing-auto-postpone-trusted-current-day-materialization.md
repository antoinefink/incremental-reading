---
title: "Standing auto-postpone uses trusted current-day materialization"
date: 2026-06-12
category: architecture-patterns
module: queue-overload-policy
problem_type: architecture_pattern
component: service_object
severity: medium
applies_when:
  - "A local-first Electron app needs automatic maintenance that depends on the user's current local day"
  - "Renderer-provided clocks or wall-clock jobs would make scheduling state non-deterministic or hard to audit"
  - "Automatic schedule mutations need durable receipts, targeted undo, and origin attribution"
related_components:
  - local-db
  - electron-ipc
  - renderer-settings
  - e2e-testing
tags:
  - auto-postpone
  - daily-budget
  - due-queue
  - trusted-clock
  - receipt-undo
  - operation-log
  - priority-integrity
---

# Standing auto-postpone uses trusted current-day materialization

## Context

T117 made auto-postpone ambient: when the policy is `automatic`, the user should open the app onto a day that already fits the Daily budget, with a receipt that explains what moved and lets them undo it.

The tempting implementations were both wrong for a local-first desktop app. A renderer `asOf` query can be historical, stale, or user-controlled, so it cannot own a real scheduling mutation. A wall-clock background job can be missed when the app is closed or suspended. The durable pattern is to converge at trusted main-process read boundaries.

## Guidance

Materialize standing automatic policy before trusted current-day queue and daily-work reads, inside the main process. The materialization service should own the current clock, derive the local day, check a persisted day marker, and mutate only when the policy is `automatic`.

```ts
listQueue(request) {
  this.materializeStandingAutoPostponeToday();
  return this.queueQuery.list(request);
}

getDailyWorkSummary(request) {
  this.materializeStandingAutoPostponeToday();
  return this.dailyWork.summary(request);
}
```

Do not use renderer-supplied `asOf` to create markers or batches. Historical queue reads can still ask "what was due at this time", but the standing policy should only decide whether today's trusted local day has already been evaluated.

Persist one receipt per evaluated local day. The receipt should include the `batchId`, local day, status, affected count, estimated minutes moved, remaining budget, affected priority bands, and creation time. Store it alongside the day marker so opening Home, Queue, or Daily Work shows the same explanation instead of a transient toast.

Apply the existing planner in one transaction with the marker and receipt. In T117, `AutoPostponeService.planSnapshot()` captures the due universe, then `applySnapshotWithin(tx, snapshot, ...)` writes every victim under one `batchId` and the standing service writes the marker/receipt in the same transaction.

Stamp operation-log payloads with origin metadata rather than creating a parallel analytics table:

```ts
postponeOrigin: {
  kind: "standingAutoPostpone",
  localDay,
  overloadPolicy: "automatic",
}
```

Use the same shape for adjacent origins such as manual queue postpone, manual auto-postpone, catch-up, vacation, and recovery. Priority-integrity can then explain which actor deferred work by reading durable command evidence.

Receipt undo must be receipt-scoped, not a renderer-facing generic batch undo. Validate all of these before restoring:

- the receipt exists and is still actionable;
- every operation in the batch is a `reschedule_element` postpone;
- every operation carries the required standing auto-postpone origin;
- every victim is still live and still at the due/status written by the automatic batch.

If any victim was manually rescheduled, deleted, or otherwise moved after the automatic batch, refuse the receipt undo instead of clobbering later user action. Mark receipt-restore rows as non-global-undoable so command-level undo cannot partially reverse one restored victim after the receipt state has already become `undone`.

Finally, make the API comments honest. Queue and daily-work reads are no longer pure reads when `overloadPolicy` is `automatic`; they may first materialize the trusted current-day policy.

## Why This Matters

Standing policy is a trust feature. Users need to know that automatic postponement ran once, ran for today, used the same protection rules as the manual planner, and can be undone without disturbing later work.

Trusted read-boundary materialization gives local-first apps a reliable convergence point. The app can be closed overnight and still catch up when the user next opens Queue or Home. The main process keeps authority over the clock, SQLite transaction, and operation log, while React only renders the receipt and sends a targeted undo intent.

The receipt and origin metadata preserve provenance. Analytics can fold restored batches out of active sacrifice counts, distinguish manual choices from policy actions, and avoid a second mutable analytics store that can drift from `operation_log`.

## When to Apply

- A local-first app has a standing policy that mutates canonical local state.
- The policy boundary is a local day, session, or other trusted runtime concept.
- The app may be closed or suspended when a wall-clock job would otherwise run.
- The renderer can query historical or simulated clocks.
- The mutation must be explainable, attributable, and undoable as a specific batch.
- Analytics should report policy effects from durable command evidence.

Do not use this pattern for read-only forecasts. If a feature only previews future load, keep it a pure read model and avoid writing a marker.

## Examples

Tests should prove idempotence and trust boundaries at the service level:

```ts
const first = standingAutoPostpone.materializeToday();
const second = standingAutoPostpone.materializeToday();

expect(first.receipt?.batchId).toBe(second.receipt?.batchId);
expect(payloadsForBatch(first.receipt?.batchId ?? "")).toHaveLength(first.receipt?.postponed);
```

Targeted undo tests should cover later-command conflicts, not only the happy path:

```ts
new ElementRepository(db).reschedule(victimId, laterDue);

const result = standingAutoPostpone.undoReceipt(batchId);

expect(result.undo).toMatchObject({
  undone: false,
  reason: "Batch no longer matches current schedule",
});
expect(new ElementRepository(db).findById(victimId)?.dueAt).toBe(laterDue);
```

Renderer tests should assert that a resolved API refusal is not treated as success:

```tsx
undoDailyWorkAutoPostponeReceipt.mockResolvedValue({
  undone: false,
  reason: "Batch no longer matches current schedule",
});

fireEvent.click(screen.getByTestId("auto-postpone-receipt-undo"));

expect(screen.getByTestId("auto-postpone-receipt-undo")).toHaveTextContent("Retry");
expect(screen.getByTestId("auto-postpone-receipt")).toHaveTextContent("items slipped");
```

Electron coverage should exercise the real loop: set policy to `automatic`, create a current-day overload, open Queue without `asOf`, assert a receipt appears and due minutes drop, restart on the same data dir, assert the receipt persists, and undo through the receipt.

## Related

- [Minute-denominated overload budgets should price the full due universe](./minute-denominated-overload-budget.md) — the minute-pricing and planner scope T117 reuses.
- [Model priority integrity as read-only analytics over durable logs](./priority-integrity-read-model.md) — the analytics receipt that consumes T117 origin metadata.
- [Chronic postpone reckoning from operation-log reset markers](./chronic-postpone-reckoning-from-operation-log-reset-markers.md) — append-only operation-log evidence and undo semantics for postpone-related workflows.
- [Queue eligibility must be canonical across inventory, actions, and undo](../logic-errors/queue-eligibility-inventory-scheduler-state.md) — backend-owned queue state and undo preimage discipline.
- [Bulk command = per-item verbs in one transaction; heterogeneous batches need an op-type-agnostic undo guard](./bulk-command-heterogeneous-batch-undo-guard.md) — this doc's batch + origin-kind guard is for a HOMOGENEOUS single-op-type batch; a bulk command whose verbs emit different op types needs the op-type-agnostic movement guard described there.
