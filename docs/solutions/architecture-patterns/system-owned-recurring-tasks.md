---
title: "Model recurring rituals as system-owned tasks with dedicated lifecycle services"
date: 2026-06-12
category: architecture-patterns
module: "tasks/weekly-review"
problem_type: architecture_pattern
component: service_object
severity: high
applies_when:
  - "A recurring product ritual should arrive through the attention queue without becoming a normal user-created task."
  - "The task has mirror rows or singleton invariants that generic queue actions cannot safely maintain."
  - "A read surface composes durable receipts but still needs audited progress and lifecycle writes."
related_components:
  - database
  - testing_framework
  - development_workflow
tags:
  - system-tasks
  - weekly-review
  - operation-log
  - queue
  - ipc
  - lifecycle
---

# Model recurring rituals as system-owned tasks with dedicated lifecycle services

## Context

T110 introduced a weekly ledger and integrity session that should arrive like attention work, but it is not a normal verification task. It has a recurring lifecycle, one-open-session invariant, progress state, and a `tasks` mirror row that must stay aligned with the `elements` row.

The reusable pattern is to model the ritual as a normal `task` element for discovery, then make the task type system-owned for creation, mutation, and process-loop handling.

## Guidance

Add a task type, not a new element type, when the ritual should participate in queue discovery:

```ts
export const SYSTEM_TASK_TYPES = ["weekly_review"] as const;
export function isSystemTaskType(value: unknown): value is SystemTaskType {
  return SYSTEM_TASK_TYPES.includes(value as SystemTaskType);
}
```

Then keep generic task services from creating or mutating that type. The dedicated lifecycle service should own every state transition that can affect the task and its mirror row:

- startup or settings enablement initializes the singleton session;
- settings disablement dismisses live weekly sessions;
- dismiss snoozes the same task and preserves progress;
- complete closes the current task and creates the next cadence task;
- soft-deleted mirror drift is repaired before singleton creation.

Back the invariant with database shape, not only service code. For `weekly_review`, the schema adds a partial unique index over open weekly tasks while allowing historical completed sessions:

```sql
CREATE UNIQUE INDEX tasks_open_weekly_review_uq
ON tasks (task_type)
WHERE task_type = 'weekly_review'
  AND status NOT IN ('done', 'parked', 'dismissed', 'deleted');
```

Keep read-side routing explicit. Queue rows can expose `taskType` so the renderer opens `/weekly`, but the one-at-a-time `/process` deck should filter system task types. Generic queue actions should reject system-owned tasks rather than trying to approximate the lifecycle:

```ts
if (task && isSystemTaskType(task.taskType)) {
  throw new Error(`${task.taskType} is system-owned; use its dedicated service`);
}
```

Progress writes should be transactional and auditable. If progress is settings-backed workflow state, write it in the same transaction as an `operation_log` marker so restart and audit behavior are explainable. Completion should clear that progress only after the current task is closed and the next task is created.

## Why This Matters

Recurring rituals sit between read models and commands. If they are treated as normal tasks, generic actions can leave `elements` and `tasks` out of sync, reschedule the wrong row, or let a system task block process-loop completion. If they are treated as dashboards, they no longer arrive where the user already works.

The system-owned task pattern preserves both sides: queue discoverability through the universal element model, and safe lifecycle semantics through a narrow service that owns the recurring invariant.

## When to Apply

- A recurring workflow should appear in the due queue or daily work summary.
- The workflow has a singleton, cadence, or mirror-table invariant.
- Generic row actions cannot preserve the domain semantics.
- A dedicated route or IPC namespace already exists or should exist.
- Progress is resumable workflow state, while decisions inside the workflow still use existing domain commands.

## Examples

Initialize from a lifecycle boundary, not from ordinary queue reads:

```ts
await repositories.weeklyReviewService.initializeSession(nowIso());
```

Do not make `queue.list` or `dailyWork.summary` create weekly sessions as a read side effect. Those reads may run for badges, tests, or route previews and must not unexpectedly mutate state.

Create next cadence on completion instead of rescheduling the same completed task:

```ts
tx.update(elementsTable).set({ status: "done", dueAt: null }).where(eq(elementsTable.id, taskId));
tx.update(tasksTable).set({ status: "done", dueAt: null }).where(eq(tasksTable.elementId, taskId));
return createSessionWithin(tx, dueAt, dueAt);
```

Route and process differently:

```ts
if (item.type === "task" && item.taskType === "weekly_review") {
  navigate({ to: "/weekly" });
}

const processDeck = queue.items.filter((item) => item.taskType !== "weekly_review");
```

## Test Guardrails

- Migration tests must prove existing task rows survive, invalid task types still fail, and only one open system task is allowed.
- Local-db tests should cover empty-vault scheduling, non-empty-vault arrival, disablement, dismiss, complete, soft-delete repair, and progress audit markers.
- Queue action tests should prove generic row actions reject system-owned task types.
- Renderer tests should prove queue opening routes to the dedicated screen and `/process` excludes system tasks.
- E2E tests should include queue discovery, dedicated session decisions, dismiss/resume, complete/reschedule, and restart persistence.

## Related

- [Model priority integrity as read-only analytics over durable logs](./priority-integrity-read-model.md) — the receipt side of the weekly ledger should remain a trusted read model.
- [Chronic postpone reckoning from operation-log reset markers](./chronic-postpone-reckoning-from-operation-log-reset-markers.md) — weekly decisions compose existing command surfaces instead of duplicating them.
- [Topic fallow rest operation-log preimages](./topic-fallow-rest-operation-log-preimages.md) — topic rest decisions inside weekly review must use the same reversible command semantics.
- [Save for later as a first-class parked state](../workflow-issues/save-for-later-first-class-parked-state.md) — parked resurfacing remains a standalone workflow that the weekly review hosts.
