---
title: "Extract aging policy uses stagnation projection plus receipt demotion"
date: 2026-06-13
category: architecture-patterns
module: extract-aging-policy
problem_type: architecture_pattern
component: service_object
severity: medium
applies_when:
  - "A local-first reading app needs to move unproductive extracts out of the due queue without deleting them"
  - "A policy reuses a read-only stagnation signal but must write auditable fate transitions"
  - "Automatic extract maintenance needs durable receipts and targeted undo"
related_components:
  - local-db
  - electron-ipc
  - renderer-settings
  - e2e-testing
tags:
  - extract-aging
  - stagnation
  - receipt-undo
  - operation-log
  - extract-fates
  - queue-eligibility
  - daily-work
---

# Extract aging policy uses stagnation projection plus receipt demotion

## Context

T121 turned extract stagnation from a read-only warning into an opt-in policy: extracts that keep returning without progress can be moved to an honorable reference state, with a visible receipt and undo. The feature crosses the same trust boundary as standing auto-postpone, but its eligibility is different: it depends on extract stage, terminal fates, children, synthesis references, due state, and the stagnation signal's age/return thresholds.

The risky implementation would have reused the visible stagnant-extract maintenance list as the sweep source. That list is a UI projection with suggestions, not the complete policy universe. A policy needs a backend-owned candidate scan, a threshold snapshot, and a transaction that revalidates every selected id at apply time.

## Guidance

Keep the extract-aging projection separate from the mutation service. Queue, Home, and maintenance surfaces can render the same age/return band without importing policy mutation code:

```ts
export function projectExtractAging(
  daysSinceProgress: number,
  postponeCount: number,
  thresholds: ExtractAgingThresholdSnapshot,
): ExtractAgingProjection {
  return {
    daysSinceProgress,
    postponeCount,
    band: bandFor(daysSinceProgress, postponeCount, thresholds),
    thresholdSnapshot: thresholds,
  };
}
```

Drive candidates from the full stagnation signal universe, not from a rendered maintenance page. The policy service should ask the stagnation query for signal rows at the trusted read clock, filter by the policy thresholds, then apply extract-aging-specific guards:

- terminal extract fates are not candidates;
- `atomic_statement` extracts stay available for conversion instead of aging out;
- rows must still be queue-actionable and due at the policy clock;
- extracts with live children are productive lineage, not graveyard material;
- extracts referenced by synthesis notes are already contributing yield.

At apply time, revalidate each requested id inside the transaction and return explicit skip reasons. This matters for suggest-mode previews: the renderer can hold a stale candidate list, and the backend must skip stale or newly ineligible rows rather than trusting the old preview.

Write the demotion as an existing `update_element` operation with a policy origin, not as a special operation-log type:

```ts
elements.updateWithin(
  tx,
  id,
  { status: "done", dueAt: null, parkedAt: null, extractFate: "reference" },
  {
    batchId,
    extras: {
      extractAgingOrigin: {
        kind: "extractAgingPolicy",
        policy,
        localDay,
        thresholds,
      },
    },
  },
);
```

That keeps undo preimages on the existing element-update path while making the batch attributable to extract aging. The receipt state can live with settings/control state as long as the domain mutation itself is in `operation_log` and the receipt is keyed by `batchId`, not just by day. Suggest-mode users may run multiple sweeps on one day, and each needs an independent undo target.

Automatic materialization should run only at trusted current-day boundaries, before standing auto-postpone. A historical `asOf` queue read should not demote today's extracts, while a live current-day Queue, Home, or weekly review read can converge the policy once for the local day.

Receipt undo must be stricter than generic undo:

- the receipt must still be actionable;
- the batch operations must carry `extractAgingOrigin.kind === "extractAgingPolicy"`;
- each current row must still match the system-written reference demotion;
- restore operations should be marked as receipt restores so generic undo cannot partially reverse a restored receipt batch later.

## Why This Matters

Extract aging is a pressure valve, not data loss. The user should see that the app moved stale work aside, know the thresholds that triggered it, and be able to restore the exact batch if the policy was too aggressive.

The split between read projection and mutation service keeps every surface honest. Queue chips, maintenance previews, and automatic sweeps use the same age/return math, but only the service can mutate rows. That prevents React from reconstructing queue eligibility or accidentally converting a UI list into the policy source of truth.

Origin metadata preserves provenance. Analytics and future maintenance workflows can distinguish user-authored reference fates from policy-authored demotions, and receipt undo can refuse conflicts instead of clobbering later user action.

## When to Apply

- A policy promotes a read-only advisory signal into an opt-in mutation.
- The mutation should be recoverable, attributable, and batch-undoable.
- UI surfaces need to show pressure bands before the policy fires.
- The policy has automatic and suggest modes that share candidate logic.
- Renderer previews can go stale before the user applies them.

Do not use this pattern for one-off user commands that already operate on the currently opened item. Those commands can rely on their own command validation and do not need daily receipt state.

## Examples

Candidate tests should cover both signal thresholds and extract-specific exclusions:

```ts
expect(preview.candidates.map((c) => c.id)).toEqual([agingRawExtractId]);
expect(preview.candidates).not.toContainEqual(
  expect.objectContaining({ id: synthesizedExtractId }),
);
expect(preview.candidates).not.toContainEqual(
  expect.objectContaining({ id: childBearingExtractId }),
);
```

Apply tests should prove stale preview handling:

```ts
const result = service.applyPreview({
  ids: [eligibleId, alreadyReferencedId, futureDueId],
});

expect(result.demoted).toBe(1);
expect(result.skipped).toEqual([
  { id: alreadyReferencedId, reason: "terminal-fate" },
  { id: futureDueId, reason: "not-due" },
]);
```

Receipt undo tests should prove conflict refusal and global-undo isolation:

```ts
const applied = service.applyPreview();
repos.elements.update(applied.receipt!.batchId, { title: "later user edit" });

expect(service.undoReceipt(applied.receipt!.batchId).undo.undone).toBe(false);
```

Electron coverage should exercise the real loop: seed an old repeatedly returned extract, set `extractAgingPolicy` to `automatic`, open Queue without `asOf`, assert the receipt appears and the extract becomes a reference, restart on the same data dir, assert the receipt and fate persist, then undo through the receipt and confirm the extract returns to the due queue.

## Related

- [Standing auto-postpone uses trusted current-day materialization](./standing-auto-postpone-trusted-current-day-materialization.md) — the closest receipt, trusted-clock, and targeted-undo pattern.
- [Model honorable non-card extract fates as first-class value output](./extract-fates-value-model-v2-source-yield-stagnation.md) — terminal extract fate semantics and source-yield implications.
- [Chronic postpone reckoning from operation-log reset markers](./chronic-postpone-reckoning-from-operation-log-reset-markers.md) — effective postpone debt and durable operation-log evidence.
- [Protected distillation quota daily workload share](./protected-distillation-quota-daily-workload-share.md) — extract pipeline pressure that T121 complements rather than replaces.
- [Queue time cost read model](./queue-time-cost-read-model.md) — backend-owned queue projection boundaries that keep renderer surfaces display-only.
- [Bulk command = per-item verbs in one transaction; heterogeneous batches need an op-type-agnostic undo guard](./bulk-command-heterogeneous-batch-undo-guard.md) — this doc's `requireUpdateOriginKind` guard is UPDATE-only; do not reuse it for a bulk batch whose verbs emit different op types (it silently refuses the non-update verbs) — use the op-type-agnostic movement guard there.
