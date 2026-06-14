---
title: "Card-edit write barrier: re-stabilize persisted FSRS state via a non-grade marker + receipt-only undo"
date: "2026-06-14"
category: "architecture-patterns"
module: "review-scheduling/card-edit-barrier"
problem_type: "architecture_pattern"
component: "database"
severity: "high"
related_components:
  - "scheduler"
  - "service_object"
  - "frontend_react"
  - "testing_framework"
applies_when:
  - "An edit to a spaced-repetition card's answer must demote the PERSISTED FSRS schedule (so the new wording is re-verified soon) without corrupting the in-flight review the user is grading."
  - "A reversible scheduling mutation needs an exact preimage and a guarded undo, but the global command-undo stack cannot own the inverse (a compound mutation it would only partially reverse)."
  - "You must record a non-grade event in an append-only review-log table whose rows every analytics/optimizer reader treats as real reviews."
  - "A heuristic decides whether a mutation fires, the decision is the user's, and the same heuristic must be callable by an agent (not buried in a UI component)."
tags:
  - "fsrs"
  - "spaced-repetition"
  - "review-logs"
  - "non-grade-marker"
  - "receipt-only-undo"
  - "operation-log"
  - "preimage"
  - "additive-migration"
  - "reader-exclusion-invariant"
related_solutions:
  - "docs/solutions/architecture-patterns/detach-tombstone-receipt-only-undo-and-per-triple-fingerprint-for-flag-resolution.md"
  - "docs/solutions/architecture-patterns/review-analytics-data-capture-in-review-logs.md"
  - "docs/solutions/architecture-patterns/topic-fallow-rest-operation-log-preimages.md"
  - "docs/solutions/logic-errors/queue-eligibility-inventory-scheduler-state.md"
  - "docs/solutions/database-issues/sqlite-table-rebuild-with-foreign-keys-on-fires-on-delete-actions.md"
  - "docs/solutions/database-issues/drizzle-migrator-high-water-mark-skips-out-of-order-migrations.md"
---

# Card-edit write barrier: re-stabilize persisted FSRS state via a non-grade marker + receipt-only undo

## Context

FSRS stability is a memory-strength estimate for one *specific* prompt→answer mapping. When a
user substantively rewrites a card's answer (T125, most often through T085 leech remediation), the
card keeps the stability its OLD formulation earned, so the new wording resurfaces months out and
fails as "user error". The M7 rule "an edit never touches `review_states`" was written to protect
*in-flight* session state, but it over-applied to mean *an edit never changes scheduling at all*.

T125 is the "write barrier" that closes the gap: a substantive edit may re-stabilize the
**persisted** FSRS state (demote to a short confirmation interval) while leaving the in-flight grade
uncorrupted. Building it surfaced five reusable sub-problems that recur in any "mutate a
spaced-repetition schedule out-of-band, reversibly, without polluting analytics" design.

## Guidance

### 1. Keep the fuzzy decision pure, in the domain layer — and let the backend stay choice-explicit

The substantive-vs-typo judgment is a pure `classifyCardEdit(kind, before, after)` in
`packages/core` (a normalized edit-distance on the *answer-bearing* side only — the Q&A answer or
the cloze deletion answers, never the prompt), table-tested, with a conservative bias toward `typo`
(a missed demotion self-heals on the next real lapse; a spurious one annoys the user).

The backend is **choice-explicit**: `cards.update` demotes ONLY when the renderer sends an explicit
`editChoice: "re_stabilize"`. There is no server-side "default to demote", and the demotion math is
recomputed server-side through the scheduler service against the persisted `review_states` — never
from renderer-supplied numbers. Because the classifier lives in core (not a React component) and is
exported from the package index, an agent calls the identical function the UI does; the renderer's
pre-selection is convenience UX, not a privileged path. This is the "decision stays with the
caller, atomic mutation stays in the tool" split.

### 2. The demotion mechanic is a bespoke scheduler method, not ts-fsrs `forget()`

`forget()` zeroes *difficulty* and resets to New — wrong when the card is reformulated, not brand
new. The right mechanic is a new pure `CardSchedulerService.reStabilize(state, now)` that:

- **preserves** difficulty, reps, lapses, learning steps, and — critically — does **not advance
  `lastReviewedAt`** (a re-stabilization is not a review; advancing it would corrupt the elapsed
  days of a subsequently-landing in-flight grade);
- **collapses** stability (only ever down) and pulls the due date in to a short confirmation
  interval **floor-only** (never pushes an already-sooner due out);
- returns `null` for a new / never-reviewed card (`reps <= 0`): nothing to demote.

Keep all ts-fsrs vocabulary behind the scheduler adapter; the method returns the project's own
`{ prev, next }` `ReviewState` snapshots so the caller persists `next` and logs `prev` as the exact
undo preimage.

### 3. Record the non-grade event as an additive marker on `review_logs` — and exclude it in EVERY reader

Follow the review-analytics pattern: add nullable columns to the existing domain row rather than a
parallel table. T125 adds `edit_marker_at` / `edit_class` / `edit_choice` to `review_logs`
(additive migration, hand-edited to `ALTER ADD COLUMN` to dodge the migration-0030 table-rebuild
lineage wipe; journal `when` strictly monotonic to avoid the high-water-mark skip). The marker row
carries the **full FSRS preimage** in its `prev*` columns and a CHECK-valid placeholder `rating`
(`good`) whose value is semantically meaningless.

**The load-bearing invariant:** a fabricated marker row is indistinguishable from a real grade to
any reader that does not filter it. EVERY `review_logs` reader must exclude markers via
`edit_marker_at IS NULL` — the T080 optimizer cut AND all aggregate readers (analytics
reviews/retention/streak, weekly-maturity `countMaturedCards`, priority-integrity servicing,
source-yield, time-cost medians, dedup/descendant "reviewed" membership, inspector log counts). A
reader that excludes markers only "by construction" (e.g. descendant-health's `nextLapses >
prevLapses`, which a lapse-preserving marker fails) should still carry the explicit filter so the
invariant is local and grep-able. A single missed reader silently inflates a user-visible number.

### 4. One owning undo path: receipt-scoped restore, guarded; global ⌘Z is inert

The re-stabilization is a *compound* mutation (body edit + FSRS demotion + marker row). Per the
T124 precedent, a compound mutation must have exactly one undo owner. The demotion op
(`reschedule_element` carrying a `cardReStabilize` marker) is marked non-invertible
(`UndoService.isInvertible` returns false), so global ⌘Z does nothing; the body edit is already
non-invertible (no preimage). The sole reversal is a guarded receipt undo
(`undoReStabilize(cardId, reviewLogId)`, "Keep schedule instead") that restores the full prior FSRS
tuple from the marker's `prev*` and mirrors **both** stores (`review_states.due_at` AND
`elements.due_at` — the two-store inverse). Its guards:

- **liveness** — never restore a schedule onto a soft-deleted / non-card element;
- **newer-marker** — refuse if a later `re_stabilize` marker exists (back-to-back demotions
  converge to an identical next-state, so the four-part state guard would otherwise PASS for an old
  marker and revert past *both* demotions to the genuine original schedule);
- **four-part current-state** — the live FSRS state must still equal what the demotion wrote, so a
  card reviewed since the edit is never clobbered (newer FSRS intent wins);
- **already-restored vs reviewed-since** — distinguish the two so a repeated undo reports the honest
  reason.

The marker row stays append-only on undo (the optimizer cut reflects a permanent fact — the text
changed — so excluding pre-edit grades stays correct regardless of the schedule choice).

### 5. The choice is a commit-time decision; autosave never demotes; coordinate "busy" with the owning surface

Both edit surfaces (review repair bar, leech rewrite) autosave the body every ~600ms. Autosave
stays body-only — the demotion fires only at the explicit commit (Done / Resolve). Two coordination
traps the review caught:

- **The choice panel is a modal decision point the keyboard owner doesn't know about.** Once the
  body autosave settles, the repair bar's "busy" goes false, so grade keys/buttons stay live; a
  reflexive grade advances the deck and silently discards the pending re-verify decision. Fix:
  report `busy = true` to the parent while the choice is open so grades are refused.
- **A failed demotion must not silently fall back to "keep schedule."** The user asked to
  re-verify; on failure, surface the error and keep the choice open — never pretend the schedule was
  kept on purpose.

## Why This Matters

- **Correctness of the headline behavior:** without re-stabilization a rewritten card is *quietly
  wrong* for months (FSRS faithfully strengthens a fact the user can no longer recall as written).
- **Analytics integrity:** the marker-in-a-source-of-truth-table design is only safe because every
  reader filters it. Miss one and re-stabilizing a card inflates streaks/retention/maturity/yield —
  a silent, hard-to-trace corruption.
- **Undo coherence:** a compound mutation with two undo paths desyncs the FSRS state from the
  marker. One owner + guards (liveness, newer-marker, four-part, already-restored) is what keeps
  ⌘Z, the receipt, and the persisted state consistent.
- **In-flight safety is a real invariant, not a slogan:** not advancing `lastReviewedAt`, and
  reporting busy during the choice, are the two non-obvious pieces that keep a mid-review edit from
  corrupting the grade the user is about to land.

## When to Apply

Reach for this pattern when you need to mutate spaced-repetition / scheduling state out-of-band
(not via a normal grade), reversibly, and your review-log table is the analytics source of truth.
The reusable shape is: pure heuristic in the domain layer → choice-explicit backend recomputing the
mutation server-side → additive non-grade marker carrying the full preimage → universal
reader-exclusion invariant → single guarded receipt undo with global-undo deferral → commit-time
(not autosave) UI that coordinates "busy" with whatever owns the keyboard.

It is the FSRS-card-state instance of the receipt-only-undo + non-invertible-marker discipline that
T123/T124 established for lineage flags and standing-auto-postpone established for daily batches.

## Examples

**The demotion + marker, in one transaction** (`CardEditService.applyReStabilizeWithin`):

```text
tx: insert review_logs marker { prev* = pre-demotion FSRS, next* = demoted FSRS,
                                rating: "good" (placeholder), edit_marker_at, edit_class:
                                "substantive", edit_choice: "re_stabilize" }
    update review_states  -> demoted tuple (lastReviewedAt PRESERVED)
    update elements.due_at -> mirror the FSRS due
    op-log reschedule_element { dueAt, prevDueAt, cardReStabilize: true, reviewLogId }
```

**Every reader excludes the marker** — the one-line invariant repeated across ~9 readers:

```ts
.where(and(/* existing predicates */, isNull(reviewLogs.editMarkerAt)))
```

```ts
// optimizer cut (buildHistory): drop markers AND grades before the latest marker, THEN
// derive elapsed-days deltas so the first post-edit review resets to 0.
const cutMs = max(reviewedAt where editMarkerAt != null);
const grades = logs.filter((l) => l.editMarkerAt == null && (cutMs == null || parse(l.reviewedAt) >= cutMs));
```

**The undo guard cascade** (`undoReStabilize`): marker exists + belongs to card + is a
`re_stabilize` marker → card is live (not trashed) → no newer `re_stabilize` marker →
`matchesDemotedState` (else `matchesRestoredState` ? "already restored" : "reviewed since") → restore
the full `prev*` tuple in both stores, append a `receiptRestore` op (inert to global ⌘Z).

**Verification:** `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm e2e
tests/electron/card-edit-write-barrier.spec.ts tests/electron/review-edit.spec.ts
tests/electron/leech-remediation.spec.ts`. The e2e matures a card to a far-future due, re-stabilizes
it through the real IPC, asserts it surfaces within the confirmation window, that the marker is
invisible to the inspector review count, survives restart, and that the receipt undo restores the
exact prior schedule.
