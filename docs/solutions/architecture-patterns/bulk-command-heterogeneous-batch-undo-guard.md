---
title: "Bulk command = per-item verbs in one transaction; heterogeneous batches need an op-type-agnostic undo guard"
date: 2026-06-15
category: architecture-patterns
module: packages/local-db
problem_type: architecture_pattern
component: service_object
severity: high
applies_when:
  - "Adding a bulk command that applies one action across N selected items as a single undoable batch"
  - "Per-item single-item write verbs already exist for the same action"
  - "The bulk verbs map to DIFFERENT operation_log op types, or a verb can combine with a secondary mutation in the same batch"
related_components:
  - local-db
  - operation-log
  - electron-ipc
tags:
  - bulk-command
  - transaction
  - batch-id
  - undo
  - operation-log
  - movement-guard
  - inbox-triage
---

# Bulk command = per-item verbs in one transaction; heterogeneous batches need an op-type-agnostic undo guard

## Context

A bulk inbox-triage sweep (T126) applies ONE triage verb (`accept` / `queueSoon` /
`keepForLater` / `delete` / `setPriority`), optionally combined with one priority band, to N
inbox ids at once, with a single snackbar Undo that reverses the whole sweep.

The codebase already had two batch precedents pulling in opposite directions:

- **The good precedent — `AutoPostponeService.apply`** (`packages/local-db/src/auto-postpone-service.ts`):
  mint ONE `batchId`, run every victim's existing `…Within(tx, …)` write inside ONE
  `db.transaction`, no new op type; the whole sweep commits atomically and undoes as one.
- **The anti-precedent — `BulkActionService`** (`packages/local-db/src/bulk-action-service.ts`):
  each id runs in its OWN transaction (`this.elements.softDelete(id, { batchId })` per id in a
  plain loop), so a mid-loop failure leaves a half-applied batch on disk. It shares a `batchId`
  for undo, but it is not atomic.

T126 had to pick the single-transaction shape AND solve a subtler problem the existing
batch docs do not cover: a bulk verb is **heterogeneous**. `accept`/`queueSoon` emit
`reschedule_element`, `keepForLater`/`setPriority` emit `update_element`, `delete` emits
`soft_delete_element`, and a combined verb+priority sweep mixes `update_element` with one of
the others in the same batch.

## Guidance

1. **One transaction, one `batchId`, zero new op shape.** Reuse the EXACT per-item
   `…Within(tx, …, { batchId })` writes the single-item path already uses, wrapped in one
   `db.transaction`, minting one `batchId`. Invent no new op type, no new status, no new
   mutation shape — "bulk" is just the per-item writes wrapped in a single transaction with a
   shared batch tag. (If a per-item write helper hard-codes its op extras and won't accept a
   `batchId`, add an optional `batchId`/extras parameter and thread it through — that is a
   batch *tag* on the same op, not a new mutation shape.)

2. **Skip-and-classify the ineligible; abort-and-report the genuinely errored.** Re-read each
   row inside the transaction. An ineligible/stale id (not-inbox, deleted, wrong-type,
   vanished) is SKIPPED with a classified reason — never thrown, or one stale row would abort
   the whole batch. A genuine unexpected write error on an eligible row lets the throw roll the
   whole transaction back (better-sqlite3 rolls back on throw) with zero partial application,
   reported through a DISTINCT `errored` channel. The result shape distinguishes the two:
   `{ batchId, applied, skipped[], errored[] }`. Do not collapse "stale skip" and "real error"
   into one bucket — they need different UI (silent count vs. honest failure).

3. **A heterogeneous batch needs an op-type-AGNOSTIC undo guard — do NOT reuse a single-op-type
   receipt guard.** The existing receipt guards (`requireUpdateOriginKind` via
   `isOwnedUpdateBatch`, keyed on `payload.extractAgingOrigin`; `requirePostponeOriginKind`) are
   each welded to ONE op type and silently refuse a batch containing any other op type. Author/
   use a movement guard that, per op type, checks the victim is still at the post-image the
   batch wrote, refusing cleanly if ANY victim moved since — regardless of op type — so undo
   never clobbers a later edit.

4. **Test undo SYMMETRY per verb, plus a refuse-on-moved-victim case.** An undo-immediately test
   passes with the WRONG guard (nothing has moved yet), so it cannot catch a guard that refuses
   the wrong op types — this bug reaches code review, not the suite.

## Why This Matters

The bug that code review caught (and tests missed): the bulk service initially reached for the
existing `isOwnedUpdateBatch` / `requireUpdateOriginKind` guard. That guard is update-only:

```ts
// undo-service.ts — the WRONG guard to reuse for a heterogeneous batch:
function isOwnedUpdateBatch(batch, options): boolean {
  return batch.every(
    (op) =>
      op.opType === "update_element" &&                              // ← rejects every non-update op
      updateOriginKind(op.payload) === options.requireUpdateOriginKind,
  );
}
```

It requires EVERY op in the batch to be `update_element`. For a bulk `accept`/`queueSoon`
(`reschedule_element`) or `delete` (`soft_delete_element`) batch, `batch.every(...)` is false on
the first op, so `undoBatch` returns `{ undone: false, reason: "Batch is not owned by this
receipt" }` — undo silently refuses for exactly the verbs that aren't priority/park updates.
Only `setPriority`/`keepForLater` batches would have undone. **The snackbar Undo would no-op for
3 of the 5 verbs**, and a naive undo-immediately test would not notice, because such a test
passes with almost any guard. Caught by code review.

**Prevention:** a per-verb undo-symmetry test (assert undo restores the pre-image for EACH of the
verbs, including the reschedule and soft_delete verbs) plus a refuse-on-moved-victim test (move
one victim after the batch, assert undo refuses cleanly and mutates nothing).

## When To Apply

- Any "apply ONE action to N selected items as one undoable unit" command (bulk triage, bulk
  archive, bulk reschedule, multi-select status change).
- Especially when the bulk verbs map to DIFFERENT underlying op types, or a verb can combine with
  a secondary mutation (here: priority) in the same batch.
- Whenever you are tempted to reuse an existing `requireXOriginKind` / single-op-type receipt
  guard for a batch — first check whether the batch is homogeneous. If not, you need the
  op-type-agnostic movement guard. (The homogeneous-batch docs below apply ONLY to single-op-type
  batches.)

## Examples

**Apply loop — single transaction, shared `batchId`, skip-classify, errored channel**
(`packages/local-db/src/inbox-bulk-triage-service.ts`):

```ts
const batchId = newRowId();
const skipped: InboxBulkTriageSkipped[] = [];
try {
  const applied = this.db.transaction((tx) => {
    let appliedCount = 0;
    for (const rawId of uniqueIds) {
      const id = rawId as ElementId;
      const current = tx.select().from(elements).where(eq(elements.id, id)).get();
      const reason = this.skipReason(current);   // not_inbox | deleted | wrong_type | already_acted
      if (reason) { skipped.push({ id: rawId, reason }); continue; }   // skip, never throw
      if (priority !== null) {
        this.elements.updateWithin(tx, id, { priority: priorityFromLabel(priority) }, { batchId });
      }
      this.applyVerbWithin(tx, id, action, batchId, now);  // reuses the per-item …Within writes
      appliedCount += 1;
    }
    return appliedCount;
  });
  return { batchId, applied, skipped, errored: [] };
} catch (error) {
  // The throw rolled the whole tx back: applied is 0, the skip classification is discarded too.
  const message = error instanceof Error ? error.message : String(error);
  return { batchId, applied: 0, skipped: [], errored: uniqueIds.map((id) => ({ id, error: message })) };
}
```

**The op-type-agnostic movement guard** (`packages/local-db/src/undo-service.ts`,
`currentBulkTriageStateMatchesAppliedWithin`, wired via `requireCurrentBulkTriageStateMatch` and
checked as `batch.some((op) => !match(tx, op))` BEFORE any inverse runs):

```ts
switch (op.opType) {
  case "reschedule_element":   // accept / queueSoon
    if (element.deletedAt !== null) return false;
    if ((element.dueAt ?? null) !== (op.payload.dueAt ?? null)) return false;
    return op.payload.status === undefined || element.status === op.payload.status;
  case "update_element": {     // park / setPriority
    if (element.deletedAt !== null) return false;
    const applied = op.payload.patch as Record<string, unknown>;
    // each patched field must still equal what the batch wrote (status / priority / dueAt / parkedAt)
    return everyPatchedFieldStillMatches(element, applied);
  }
  case "soft_delete_element":  // delete
    return element.deletedAt !== null;
  default:
    return false;
}
```

The service then requests this guard instead of the update-only one:

```ts
undoBatch(batchId: string): UndoResult {
  return this.undo.undoBatch(batchId, { requireCurrentBulkTriageStateMatch: true });
}
```

## Related Issues

- [Standing auto-postpone trusted current-day materialization](standing-auto-postpone-trusted-current-day-materialization.md)
  — the closest receipt/undo precedent, but a HOMOGENEOUS batch (every op a `reschedule_element`
  postpone); its origin-kind guard applies only to single-op-type batches.
- [Extract aging policy uses stagnation projection plus receipt demotion](extract-aging-policy-receipt-demotion.md)
  — uses the UPDATE-only `requireUpdateOriginKind` guard that does NOT generalize to a
  heterogeneous bulk batch.
- [Topic fallow rest operation-log preimages](topic-fallow-rest-operation-log-preimages.md)
  — shared-`batchId` scoping + preimage restoration for a single-op-type batch.
- [Inbox Queue soon schedules sources due now](../workflow-issues/inbox-triage-queue-soon-attention-scheduling.md)
  and [Save for later first-class parked state](../workflow-issues/save-for-later-first-class-parked-state.md)
  — the single-item triage write paths the bulk verbs reuse verbatim.
- [SQLite table rebuild with foreign keys on fires ON DELETE actions](../database-issues/sqlite-table-rebuild-with-foreign-keys-on-fires-on-delete-actions.md)
  — why T126's `captured_via` migration was a purely additive `ALTER TABLE ADD COLUMN` rather
  than a Drizzle table rebuild.
