---
title: "Model priority integrity as read-only analytics over durable logs"
date: 2026-06-11
category: architecture-patterns
module: priority-integrity
problem_type: architecture_pattern
component: database
severity: medium
related_components:
  - "service_object"
  - "testing_framework"
  - "development_workflow"
applies_when:
  - "A user-facing warning or analytics panel needs to explain priority drift from durable review and mutation history."
  - "A read model spans operation_log, review_logs, elements, and cards without creating new mutable analytics state."
  - "The renderer needs a typed analytics surface without raw database access."
tags: [priority-integrity, analytics, read-model, operation-log, review-logs, ipc, notice-dismissals]
---

# Model priority integrity as read-only analytics over durable logs

## Context

Interleave needed a priority-integrity receipt: a calm way to explain whether executed work matched declared priority, whether high-priority material was deferred, and which topics accumulated postpone debt. The feature crossed `operation_log`, `review_logs`, live element state, retired-card state, Electron IPC, Analytics, and Queue.

The reusable pattern is that priority integrity is a read-only receipt over durable facts already written by command paths. It is not a new analytics table, not a renderer aggregation, and not a scheduling command.

## Guidance

Model this kind of analytics as a trusted read model over existing facts. The local database query should read durable command evidence, compute the receipt, and return a stable payload to the renderer:

```ts
{
  priorityAttribution: "current",
  bands: [{ band: "A", attentionServiced, fsrsServiced, deferred, postponeDebtDays }],
  topics: [{ anchorId, title, band, deferred, postponeDebtDays }],
  sacrificed: [{ id, title, scheduler: "attention" | "fsrs", postponeCount }],
  thresholdFlags: { aBandInflation, aBandDeferredRecently, postponeDebtHigh },
}
```

Make attribution semantics explicit. T105 groups historical service and defer events under an element's current priority band, then suppresses the strong A-band defer warning when that element had an in-window priority edit. That lets recently promoted work count as current-A debt without over-claiming that it was sacrificed while already A.

Keep eligibility backend-owned:

- Live inventory counts only non-deleted, queue-actionable, non-retired rows.
- Historical service can count for items that are now done, because the service event is the reason they left the live queue.
- Parked, deleted, retired, and future-due deferrals stay out of the receipt.
- Initial scheduling is not service; due attention reschedules can be service.

Expose the read through the analytics bridge namespace, not a parallel surface:

- `PriorityIntegrityGetRequestSchema` validates clocks and bounded limits.
- `analytics:priorityIntegrity` is the fixed IPC channel.
- `window.appApi.analytics.priorityIntegrity()` is the preload surface.
- `appApi.getPriorityIntegrity()` is only a renderer convenience wrapper.

Drive warning UI from backend flags. Queue should not recompute priority drift locally; it should show a quiet advisory only when `thresholdFlags` says the backend receipt crossed a threshold:

```ts
const show =
  (flags.aBandInflation || flags.aBandDeferredRecently || flags.postponeDebtHigh) &&
  !isNoticeDismissed(dismissals, "priorityIntegrity.queue");
```

Persist advisory dismissals through the shared settings-backed notice-dismissal shape. Hide only after persistence succeeds; if persistence fails, keep the warning visible and show a small inline error.

## Why This Matters

Priority integrity is accountability, not scheduling. If analytics mutates state, keeps shadow aggregates, or recomputes business semantics in React, the app can no longer explain whether priority drift came from real user/system actions or from analytics artifacts.

The receipt pattern preserves provenance: every number traces back to durable logs and current durable rows, while the renderer receives only a typed summary. It also keeps advisory UI honest. Analytics can say "priority drift is happening" without silently rescheduling, demoting, or hiding work.

## When to Apply

- Analytics answers "what actually happened?" over already-logged behavior.
- Facts already exist in `operation_log`, domain tables, review logs, or similar durable stores.
- The result may drive a warning, trust indicator, or product ritual.
- Attribution semantics are subtle enough that React must not recreate them.
- The renderer needs a typed, narrow read across the Electron boundary.
- Warnings are advisory and dismissible rather than commands.

## Examples

A local-db receipt should pin read-only behavior in tests:

```ts
const before = db.select().from(operationLog).all().length;
const summary = new PriorityIntegrityQuery(db).compute(asOf);

expect(summary.priorityAttribution).toBe("current");
expect(db.select().from(operationLog).all()).toHaveLength(before);
```

Separate live accountability from historical event eligibility:

```ts
accountable: notDeleted && queueActionable && notRetired,
eventEligible: notDeleted && notRetired && (queueActionable || status === "done"),
```

Keep the IPC boundary narrow and validated:

```ts
export const PriorityIntegrityGetRequestSchema = z
  .object({
    asOf: IsoTimestampInputSchema.optional(),
    windowDays: z.number().int().min(1).max(365).optional(),
    sacrificedLimit: z.number().int().min(1).max(50).optional(),
    topicLimit: z.number().int().min(1).max(50).optional(),
  })
  .optional();
```

## Test Guardrails

- Unit seed durable rows directly: `operation_log`, `review_logs`, `elements`, `cards`, and review state.
- Assert the query appends no `operation_log` rows.
- Cover empty four-band output.
- Cover attention service, FSRS service, deferrals, topic anchors, debt accumulation, and sacrificed rows.
- Cover ineligible exclusions: future-due, parked, deleted, and retired.
- Cover done items: historical service counts, live count does not.
- Cover current-priority attribution plus A-warning suppression after priority edits.
- Contract, channel, IPC, preload, and renderer-wrapper tests must prove the typed `analytics:priorityIntegrity` path is wired and validates input.
- UI tests must prove backend flags drive warnings, dismissals persist and expire, persistence failure keeps the warning visible, and receipt load failure does not break Queue or Analytics.

## Related

- [Build review activity heatmaps as trusted analytics read models](./review-activity-heatmap-read-model.md) is the closest read-model precedent for trusted Analytics aggregation across local-db, Electron IPC, preload, and React.
- [Capture review analytics facts in review logs without analytics tables](./review-analytics-data-capture-in-review-logs.md) documents the write-side complement: capture analytics facts on the durable domain event, not in a shadow analytics table.
- [Balance banner actions should stay actionable and dismissible](../ui-bugs/balance-banner-queue-inbox-action-gating.md) documents the advisory-warning and durable-dismissal precedent.
- [Daily work read model routes inbox-only days honestly](../ui-bugs/daily-work-read-model-inbox-only-routing.md) documents the adjacent rule that trusted-side read models should own actionability predicates.
- [Signal-hash advisory nudges](../design-patterns/signal-hash-advisory-nudges.md) documents backend-owned advisory signals and durable dismissals keyed to evidence.
- [Block processing list tolerates stale missing-source reads](../runtime-errors/block-processing-stale-source-ids-zero-summary.md) documents stable empty read models across IPC.
