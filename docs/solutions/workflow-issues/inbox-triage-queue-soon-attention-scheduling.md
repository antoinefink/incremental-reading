---
title: "Inbox Queue soon schedules sources due now without opening the reader"
date: "2026-06-08"
category: "docs/solutions/workflow-issues/"
module: "inbox-triage-attention-queue"
problem_type: "workflow_issue"
component: "service_object"
severity: "medium"
applies_when:
  - "Adding inbox triage actions that change scheduling state without opening the reader"
  - "Routing sources into the attention queue while preserving priority and scored ordering"
  - "Persisting queue transitions through SQLite and app restart"
related_components:
  - "frontend_stimulus"
  - "database"
  - "testing_framework"
tags:
  - "inbox-triage"
  - "attention-queue"
  - "queue-soon"
  - "reschedule-element"
  - "sqlite-persistence"
  - "fsrs-boundary"
---

# Inbox Queue soon schedules sources due now without opening the reader

## Context

Gold-standard incremental reading triage needs more than "open it" or "park it".
Inbox sources need four distinct outcomes:

- `Read now`: accept the source and open active reading.
- `Queue soon`: accept the source and make it due attention work now.
- `Save for later`: set it aside without scheduling it.
- `Delete`: remove it through the normal destructive path.

The important distinction is that `Queue soon` is an explicit user decision to put
the source into the processing pipeline without interrupting triage by opening the
reader.

## Guidance

Implement `Queue soon` as an Inbox triage action, not as reader navigation and not
as passive parking.

The durable mutation should:

- extend the typed triage union with `{ kind: "queueSoon" }`;
- stay behind Electron main and validated IPC;
- reuse the live inbox-source guard: not deleted, `type: "source"`, `status: "inbox"`;
- run in one transaction;
- persist `status: "scheduled"` and `dueAt = now`;
- append one `reschedule_element` op with `{ action: "queueSoon", queueSoon: true }`;
- avoid `review_states`, because sources are attention-scheduled, not FSRS-scheduled;
- let `QueueQuery` / `listQueue` apply normal priority and queue scoring.

`Queue soon` means "eligible now"; it must not mean "force to the top". An already
due A-priority source can still sort ahead of a B-priority source that was just
queued soon.

## Why This Matters

Without `Queue soon`, users have to choose between reading a source immediately or
dismissing it into passive storage. That is the wrong tradeoff for incremental
reading: valuable material may deserve near-term attention without deserving the
current moment.

This preserves the product boundaries:

- Inbox answers whether the user has decided what the capture is.
- Reader answers whether the user is actively reading the source.
- Queue answers what attention work is due now.

`Queue soon` moves a source from undecided capture into due attention work without
pretending the user started reading it.

## When to Apply

Use this pattern when an Inbox source is accepted into the processing pipeline but
should not open the primary work surface immediately.

Do not use it for:

- automatic scheduling of every import;
- `Save for later`;
- reader resume behavior;
- generic scheduling menus;
- priority bypasses;
- FSRS/card scheduling.

The helper for this seam should reject non-source elements. Extracts and cards have
their own scheduling and review paths.

## Examples

Contract shape:

```ts
{ kind: "queueSoon" }
```

Persistence effect:

```ts
status = "scheduled";
dueAt = now;
opType = "reschedule_element";
payload includes { action: "queueSoon", queueSoon: true };
```

User-facing behavior:

- Clicking `Queue soon` removes the row from Inbox.
- Shortcut `2` performs the same action.
- The app stays on Inbox.
- The source appears in Queue as normal attention work.
- Existing higher-priority due work can still sort ahead of it.

Relevant seams:

- `apps/desktop/src/shared/contract.ts`
- `apps/desktop/src/main/db-service.ts`
- `packages/local-db/src/scheduler-service.ts`
- `packages/local-db/src/queue-query.ts`
- `apps/web/src/pages/inbox/InboxScreen.tsx`

## Prevention

- Test the shared contract accepts `{ kind: "queueSoon" }`.
- Test Electron main rejects stale, deleted, non-source, or non-inbox rows before mutating.
- Test the scheduler helper rejects non-source elements and appends no op on rejection.
- Test the mutation writes `status: "scheduled"`, `dueAt = now`, and exactly one `reschedule_element` op with the queue-soon marker.
- Test no `review_states` row is created.
- Test `listQueue` includes the source through normal attention eligibility and preserves priority/scored ordering.
- Test UI click and shortcut `2` call `{ kind: "queueSoon" }`, refresh Inbox, and do not navigate.
- Test async refresh/selection races: a reload failure should keep the error visible, and a newer selected row should not be cleared by an older mutation.
- Test Electron restart persistence: the source should remain out of Inbox and visible in Queue after relaunch.

## Related

- [Daily work read model routes inbox-only days honestly](../ui-bugs/daily-work-read-model-inbox-only-routing.md) documents the broader invariant that Inbox work is not Queue work until an explicit action accepts or schedules it.
- [Queue eligibility must be canonical across inventory, actions, and undo](../logic-errors/queue-eligibility-inventory-scheduler-state.md) documents the backend-owned queue membership rule this action relies on.
- [Balance banner actions should stay actionable and dismissible](../ui-bugs/balance-banner-queue-inbox-action-gating.md) documents why advisory UI should not auto-schedule fresh imports; Queue soon is valid because it is a direct triage command.
- [URL and browser-captured articles should open as internal readable sources](../ui-bugs/url-imported-articles-inbox-processing.md) documents the contrasting `Read now` path that accepts an inbox source and opens the reader.
