---
title: "Capture review analytics facts in review logs without analytics tables"
date: 2026-06-07
category: architecture-patterns
module: review-analytics-persistence
problem_type: architecture_pattern
component: database
severity: medium
applies_when:
  - "Review analytics needs prompt timing, response timing, or FSRS transition facts from historical reviews"
  - "A review mutation already appends a durable review log inside the grading transaction"
  - "Separate analytics tables would duplicate domain state or weaken source-of-truth guarantees"
related_components:
  - service_object
  - testing_framework
  - ipc-contract
tags: [review-logs, review-analytics, fsrs, scheduler, sqlite, migration, prompt-timing, stale-outcomes]
---

# Capture review analytics facts in review logs without analytics tables

## Context

Future stats should be derived from durable domain facts, not from a separate analytics table. Daily source/extract/card creation counts already come from element timestamps, so the highest-value missing signal was review detail: prompt-side time, reveal-to-grade response time, and the FSRS transition that produced the next schedule.

The reusable pattern is: analytics are read models. Capture facts at the domain write path that owns them, then let future reporting recompute aggregates from those durable rows.

## Guidance

Store future stats signals on the domain event that already represents the user action. For active recall reviews, that is the review log. Do not create a parallel analytics table unless the domain event cannot own the fact.

Keep existing metric semantics stable. `response_ms` continues to mean reveal-to-grade time, and `prompt_ms` captures card-shown-to-reveal time. Future total review time is derived:

```sql
COALESCE(prompt_ms, 0) + response_ms
```

Make newly added historical columns nullable when old rows did not capture the fact. A migration should preserve the distinction between "unknown" and "captured as zero":

```sql
ALTER TABLE `review_logs` ADD `prompt_ms` integer;
ALTER TABLE `review_logs` ADD `prev_due_at` text;
ALTER TABLE `review_logs` ADD `next_reps` integer;
```

Write the pre-review and post-review scheduling facts in the same transaction as the grade. The repository should read the current review state, reject stale scheduler outcomes, append the review log, and then advance the state:

```ts
if (outcome.prevState !== before.fsrsState || stalePreimage) {
  throw new Error(`ReviewRepository.recordReview: stale review outcome for card ${cardElementId}`);
}

tx.insert(reviewLogs).values({
  responseMs: outcome.responseMs,
  promptMs: options?.promptMs ?? null,
  prevState: before.fsrsState,
  prevDueAt: before.dueAt,
  prevReps: before.reps,
  nextState: outcome.nextState,
  nextReps: outcome.reps,
});
```

Have scheduler outcomes carry the preimage they were computed from. A `review -> review` outcome can be stale even when the FSRS phase still matches, so phase-only checks are not enough; compare due date, stability, difficulty, counters, learning steps, and last-reviewed time.

When a request schema has defaults, split wire input from parsed output:

```ts
promptMs: ReviewTimingMsSchema.optional().default(0);

export type ReviewGradeRequestInput = z.input<typeof ReviewGradeRequestSchema>;
export type ReviewGradeRequest = z.output<typeof ReviewGradeRequestSchema>;
```

Renderer and preload callers use the input type because legacy callers may omit `promptMs`. Main-process code that receives a parsed request uses the output type, where `promptMs` has already been normalized.

Measure review timing only in UI orchestration. The renderer can capture card-shown time, freeze prompt time at reveal, and pass scalar timings to the grade command. It still performs no FSRS math and no persistence:

```ts
promptMsRef.current =
  cardShownAtRef.current == null ? 0 : Math.max(0, revealedAt - cardShownAtRef.current);

await appApi.reviewGrade({
  cardId,
  rating,
  promptMs,
  responseMs,
});
```

## Why This Matters

This preserves future analytic power without creating a second source of truth. Review stats can later be recomputed from durable domain rows, survive app restart, and stay consistent with undo, audit, backup, and scheduler expectations.

Nullable historical columns avoid lying about old behavior. `NULL` means "unknown"; `0` means "captured and zero." That distinction matters for future stats like average prompt time, total time spent reviewing, interval distributions, lapse trends, and FSRS parameter analysis.

The scheduler preimage guard protects review history from duplicate or stale writes, including same-phase FSRS transitions that a `prevState`-only check would miss.

## When to Apply

- Adding future stats or reporting support for a real domain action.
- Capturing values produced during imports, extraction, reading progress, scheduling, or reviews.
- Extending an append-only mutation log where historical rows did not capture the new fact.
- Threading optional renderer telemetry through a validated IPC boundary.

Do not use this for transient UI-only metrics or broad speculative event capture. If no future domain question is clear, leave the value out.

## Examples

This pattern showed up across the review stack:

- `packages/db/src/schema/cards.ts` keeps prompt timing and FSRS snapshot columns on review logs.
- `packages/db/drizzle/0028_review_stats_snapshot.sql` adds nullable columns so existing rows retain unknown historical values.
- `packages/local-db/src/review-repository.ts` appends the review log and advances review state in one transaction, rejecting stale scheduler outcomes before any write.
- `packages/scheduler/src/card-scheduler.ts` returns the preimage used to compute the outcome.
- `apps/desktop/src/shared/contract.ts` bounds timings and splits `ReviewGradeRequestInput` from parsed `ReviewGradeRequest`.
- `apps/web/src/review/ReviewScreen.tsx` and `apps/web/src/pages/queue/ProcessQueue.tsx` measure prompt and response time without owning persistence.

The tests should cover all layers: migration upgrade behavior, schema round-trip, repository persistence, missing-state rollback, same-phase stale outcome rejection, IPC validation, renderer timing capture, and at least one restart path.

## Related

- [Test operation-log and IPC invariants for extract to card mutation paths](./extract-card-ipc-invariant-test-hardening.md) covers the same contract-testing shape for mutation boundaries.
- [Battle-testing matrix and test-hardening execution for core app surfaces](./test-audit-driven-battle-testing.md) explains why persistence and restart seams get explicit tests.
- [Balance banner should not route fresh imports to an empty queue](../ui-bugs/balance-banner-queue-inbox-action-gating.md) is the closest analytics precedent: truthful analytics can differ from actionable UI state.
- [Extract inspector single-responsibility layout and scheduler refresh](../ui-bugs/extract-inspector-single-responsibility-lineage-scheduler.md) covers scheduler-boundary discipline for queue and inspector surfaces.
- Plan artifact: [Review Stats Data Capture Hardening](../../plans/2026-06-07-004-feat-review-stats-data-capture-plan.md).
