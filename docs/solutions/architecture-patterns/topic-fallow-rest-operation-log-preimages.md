---
title: "Topic fallow rest with operation-log preimages"
date: 2026-06-11
category: architecture-patterns
module: "topic-fallow-scheduling"
problem_type: architecture_pattern
component: service_object
severity: high
applies_when:
  - "A deliberate rest state must reschedule attention work without touching FSRS card review"
  - "Batch mutations need undo/refallow behavior from durable operation_log preimages"
  - "IPC and service boundaries must agree on canonical UTC ISO scheduling inputs"
  - "Queue, review, analytics, and maintenance surfaces need one backend-owned scheduling truth"
related_components:
  - database
  - testing_framework
  - development_workflow
tags:
  - fallow
  - topic-rest
  - operation-log
  - undo
  - scheduler
  - ipc
  - restart-e2e
---

# Topic fallow rest with operation-log preimages

## Context

T107 introduced "topic rest" as attention-scheduler state on `elements`, not FSRS or card state. The universal element row now carries nullable `fallowUntil`, `fallowReason`, and `fallowBatchId`; the migration keeps existing topic/extract lineage intact while adding the new nullable columns.

The durable distinction is product-facing and technical: a fallowed topic deliberately rests its attention work until a chosen return date, while cards beneath it continue reviewing because memory still decays.

## Guidance

Model fallow as a transactional attention command owned by local-db:

- `FallowService` shifts the topic plus live non-card, non-concept attention descendants to `fallowUntil`.
- Descendant cards keep their element due date and FSRS `review_states` due date untouched.
- Every fallow reschedule is command-shaped and operation-logged with `fallow: true`, `topicId`, `fallowUntil`, and a shared `batchId`.
- Direct unfallow restores only rows from the topic's active `fallowBatchId`, and only when the row's current `dueAt` still equals the fallow return date.
- Newer manual schedule intent is skipped instead of overwritten.

Refallow needs one extra guardrail: preserve the original pre-rest schedule across fallow batches. If a topic is first rested to July 1 and later shortened to June 20, the second batch's raw `prevDueAt` is July 1. Store `fallowOriginalDueAt` / `fallowOriginalStatus` on the later fallow op so manual unfallow can clear rest all the way back to the pre-rest schedule instead of restoring the prior rest date.

```ts
this.elements.rescheduleWithin(tx, id, fallowUntil, undefined, {
  batchId,
  action: "fallow:reschedule",
  fallow: true,
  topicId,
  fallowUntil,
  fallowOriginalDueAt: original.prevDueAt,
  fallowOriginalStatus: original.prevStatus,
});
```

Keep operation-log scans scoped. A chronic-postpone apply can fallow multiple topics with one shared batch id, so unfallow lookups must filter by both `batchId` and `topicId` before restoring schedules.

Keep timestamp validation at both boundaries. The Electron IPC schemas reject non-canonical UTC timestamps, and `FallowService` repeats that validation because chronic-postpone and tests can call it inside local-db without IPC.

## Why This Matters

Fallow is deliberate rest, not procrastination and not forgetting. If it were modeled as a normal postpone, priority-integrity and chronic-postpone debt would become dishonest. If it touched FSRS, active-recall card scheduling would be corrupted. If it were only a renderer filter, queue behavior would diverge from persisted scheduling state and app restart would expose the mismatch.

The read models make the distinction explicit:

- Queue inventory exposes active/returned fallow context and uses `notInQueueReason: "fallow"` when a row is hidden by active rest.
- Review cards can show ancestor fallow context while remaining reviewable.
- Priority integrity ignores fallow-marked reschedules for service/defer accounting and reports resting topics separately.
- Chronic-postpone can offer Rest as a topic-only fifth decision that resets effective postpone debt in the same undoable batch.

## When To Apply

Use this pattern for intentional, scheduled rest of topic-owned attention work.

Do not use it for active-recall cards, terminal abandonment, parking sources, or generic postpone/defer actions. Those states answer different product questions and have different scheduler/accounting effects.

Apply it when a feature needs reversible attention scheduling, auditability through `operation_log`, backend-owned queue semantics, and clear UI messaging that card review continues.

## Examples

Fallowing a topic:

```ts
repos.fallow.fallowTopic({
  topicId,
  fallowUntil: "2026-07-01T00:00:00.000Z",
  fallowReason: "Seasonal pause",
});
```

Expected effects:

- The topic and eligible attention descendants move to the return date.
- Descendant cards keep their review due dates.
- Fallow reschedules use one `batchId`.
- The topic stores `fallowUntil`, `fallowReason`, and `fallowBatchId`.

Unfallowing:

```ts
repos.fallow.unfallowTopic({ topicId });
```

Expected effects:

- Schedules still owned by the active fallow batch restore.
- Topic fallow metadata clears.
- Descendants with newer manual schedule intent return `schedule-changed` skips.
- Re-fallowed rows restore to the original pre-rest schedule, not the previous fallow date.

## Test Guardrails

- Migration adds nullable fallow columns without disturbing parent/source links.
- Fallow does not touch descendant card FSRS review state.
- Refallow preserves original pre-rest schedules.
- Unfallow scopes restoration by both topic id and batch id.
- Unfallow skips newer manual schedule intent.
- Chronic fallow is topic-only, resets effective postpone count, and rejects non-canonical dates.
- Queue read models expose active and returned fallow context.
- Priority integrity excludes fallow reschedules from service/defer debt and reports resting topics separately.
- IPC and service-level tests reject malformed or non-canonical timestamps such as `2027-02-31T00:00:00.000Z`.
- Electron E2E proves the typed app API surface, queue removal/return, review-card continuity, restart persistence, and clear-rest behavior.

## Related

- [Queue eligibility must be canonical across inventory, actions, and undo](../logic-errors/queue-eligibility-inventory-scheduler-state.md) — backend-owned eligibility, scheduler drift diagnostics, and undo preimage symmetry.
- [Chronic postpone reckoning from operation-log reset markers](./chronic-postpone-reckoning-from-operation-log-reset-markers.md) — append-only reset markers and effective-count folding.
- [Model priority integrity as read-only analytics over durable logs](./priority-integrity-read-model.md) — durable-log read models and advisory UI boundaries.
- [Save for later as a first-class parked state](../workflow-issues/save-for-later-first-class-parked-state.md) — the adjacent reversible "not now" state for sources rather than topic subtrees.
- [Inbox triage Queue soon must schedule through attention scheduling](../workflow-issues/inbox-triage-queue-soon-attention-scheduling.md) — the contrast case: explicit scheduling now, not resting.
- [Daily work read model routes inbox-only days honestly](../ui-bugs/daily-work-read-model-inbox-only-routing.md) — keeping Queue, Inbox, Daily Work, and active reading distinct.
