---
title: Review Stats Data Capture Hardening
type: feat
status: completed
date: 2026-06-07
---

# Review Stats Data Capture Hardening

## Summary

Interleave already stores the main analytics substrate: element creation/update/delete timestamps, source lineage, read-points, review states, review logs, and operation-log entries. This plan hardens the highest-value missing durable signal for future Anki-like stats: each card review should preserve both prompt-side time and a fuller FSRS before/after transition in `review_logs`, without adding a generic analytics table or building UI.

---

## Problem Frame

The user wants future stats to be possible from domain data that is already persisted. Existing code can count new sources/extracts/cards per day through `elements.created_at`, and can compute source yield from descendant lineage plus `review_logs.response_ms`. The gap is that `review_logs.response_ms` currently means reveal-to-grade time only, while the renderer discards the time spent looking at the prompt before reveal. The immutable log also omits several FSRS transition fields that are already written to `review_states`, making historical review analytics more dependent on current state or inference.

---

## Requirements

- R1. Daily creation counts for sources, extracts, and cards must remain derivable from existing `elements.type` plus `elements.created_at`.
- R2. Each graded card review must durably store prompt-side time, answer-side time, and enough fields to derive total review time per item.
- R3. Each graded card review must preserve a fuller FSRS transition snapshot so future stats can analyze reps, lapses, intervals, learning steps, and prior due state from immutable rows.
- R4. The change must not introduce a dedicated analytics/event table or move analytics logic into React.
- R5. The review grading IPC path must stay narrow and validated; malformed timings must be rejected at the boundary.
- R6. Existing review analytics must keep working with `response_ms` semantics preserved for reveal-to-grade time.
- R7. Existing database rows must migrate safely with defaults or nullable fields, with no backfill that invents user behavior.

---

## Key Technical Decisions

- **Keep `response_ms` as answer-side time:** Existing analytics and tests treat `response_ms` as reveal-to-grade. Renaming it would create avoidable churn; adding `prompt_ms` makes total time derivable as `prompt_ms + response_ms`.
- **Store FSRS transition columns on `review_logs`:** A review log is already the durable event for a grade. Adding columns there follows the user's "store it somewhere" constraint without a separate analytics table.
- **Use nullable migration semantics:** Historical logs did not capture prompt time or transition snapshot fields. Newly added columns stay nullable so old rows preserve the distinction between "unknown" and "captured as zero"; request validation normalizes omitted prompt timing to `0` only for new reviews.
- **Measure prompt time in the renderer only as a UI timer:** The renderer may measure elapsed wall-clock time, but it still sends only a validated scalar through `review.grade`; all FSRS math and persistence remain main-side.
- **Do not implement review sessions today:** Persisted sessions, import events, and reading/process timers are valid future work, but they would add broader event infrastructure. This task is scoped to the card-review event already present.

---

## Implementation Units

### U1. Extend Review Log Schema And Types

- **Goal:** Add durable review timing and FSRS transition columns to `review_logs`.
- **Files:** Modify `packages/db/src/schema/cards.ts`, `packages/core/src/review.ts`, `packages/local-db/src/mappers.ts`; add migration `packages/db/drizzle/0028_*.sql`; update `packages/db/drizzle/meta/_journal.json`.
- **Approach:** Add `prompt_ms`, pre-review fields (`prev_due_at`, `prev_stability`, `prev_difficulty`, `prev_elapsed_days`, `prev_scheduled_days`, `prev_reps`, `prev_lapses`, `prev_learning_steps`, `prev_last_reviewed_at`) and missing post-review fields (`next_elapsed_days`, `next_scheduled_days`, `next_reps`, `next_lapses`, `next_learning_steps`). Keep existing columns and `response_ms`.
- **Test Scenarios:** Schema round-trip inserts a row with prompt time and transition values; legacy-style inserts still succeed through migration defaults where applicable.
- **Verification:** `pnpm test --filter @interleave/db` or the relevant schema tests pass.

### U2. Persist Prompt Time And Full Transition On Grade

- **Goal:** Make `ReviewRepository.recordReview` write the new columns atomically with the existing review log and state update.
- **Files:** Modify `packages/local-db/src/review-repository.ts`, `apps/desktop/src/main/db-service.ts`, and relevant local-db/desktop tests.
- **Approach:** Capture the pre-review `review_states` row before mutation; pass `promptMs` from `DbService.gradeCard` into `recordReview`; write both pre-state and next-state values into the `review_logs` row. Preserve the existing `add_review_log` operation-log behavior.
- **Test Scenarios:** A grade persists `promptMs`; a grade persists previous due/stability/reps/lapses/learning steps and next elapsed/scheduled/reps/lapses/learning steps; exactly one `review_logs` row and one `add_review_log` op are still written.
- **Verification:** Focused local-db and desktop db-service tests pass.

### U3. Carry Prompt Timing Through The Typed Review IPC

- **Goal:** Validate and send prompt-side timing through the existing `review.grade` surface.
- **Files:** Modify `apps/desktop/src/shared/contract.ts`, `apps/desktop/src/shared/contract.test.ts`, `apps/desktop/src/preload/index.ts` if needed, `apps/web/src/lib/appApi.ts`, and `apps/web/src/review/ReviewScreen.tsx`.
- **Approach:** Add optional bounded `promptMs` to `ReviewGradeRequestSchema`; default missing values to `0` main-side for compatibility. Track the time from card display to reveal in the review screen, store it in a ref when revealing, and include it in `reviewGrade`.
- **Test Scenarios:** Contract accepts non-negative `promptMs`, rejects negative/non-finite prompt time, and remains compatible with callers that omit it; renderer passes prompt time when grading.
- **Verification:** Contract tests and review screen tests pass.

---

## Scope Boundaries

- No stats UI is built.
- No dedicated analytics, activity, import-event, or review-session table is added.
- No historical prompt time is fabricated for existing rows.
- No change is made to FSRS scheduling behavior or review ordering.
- No direct SQLite/filesystem access is exposed to the renderer.

---

## Risks & Dependencies

- **Migration drift:** The Drizzle schema, SQL migration, and schema round-trip tests must agree on the new columns.
- **Semantic drift:** Existing `response_ms` must keep its reveal-to-grade meaning so current source-yield and analytics queries remain valid.
- **Timer trust:** Renderer-provided timing is inherently client-measured. The main process should validate bounds, not treat the value as security-sensitive.

---

## Sources / Research

- `packages/db/src/schema/cards.ts` currently defines `review_logs.response_ms` as reveal-to-grade time.
- `apps/web/src/review/ReviewScreen.tsx` currently starts timing at reveal and discards prompt-reading time.
- `packages/local-db/src/analytics-query.ts` and `packages/local-db/src/source-yield-query.ts` already compute daily reviews, retention, creation counts, and review-time rollups from durable tables.
- Planning subagents independently flagged missing full review timing and fuller review transition snapshots as the highest-value data-capture gaps.
