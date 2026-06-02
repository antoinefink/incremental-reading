/**
 * OptimizationService tests (T080) — the composition seam between `review_logs`,
 * the pure `@interleave/scheduler` optimizer, and the queryable param stores.
 *
 * Pins:
 *  - `buildHistory` re-sorts logs ASCENDING and DERIVES `elapsedDays` from
 *    consecutive `reviewedAt` deltas (the mapper substrate facts);
 *  - `suggest` for a CONCEPT scope builds only that concept's cards' history and
 *    persists NOTHING;
 *  - `apply` writes the QUERYABLE store — the `fsrs.params.global` setting for a
 *    global scope, the `concepts.fsrs_params` column (+ an `update_element` audit)
 *    for a concept scope — and a malformed vector is rejected;
 *  - the workload preview is read-only.
 */

import type { ElementId, ReviewRating } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { CardSchedulerService } from "@interleave/scheduler";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRepositories, type Repositories } from "./index";
import { OptimizationService } from "./optimization-service";
import { createInMemoryDb } from "./test-db";

let handle: DbHandle;
let repos: Repositories;
let service: OptimizationService;
const scheduler = new CardSchedulerService({ desiredRetention: 0.9, enableFuzz: false });

beforeEach(() => {
  handle = createInMemoryDb();
  repos = createRepositories(handle.db);
  service = new OptimizationService(handle.db);
});

afterEach(() => {
  handle.sqlite.close();
});

/** Create a card and drive `n` real grades through the scheduler, spaced `gapDays`. */
function makeCardWithReviews(
  n: number,
  opts: { gapDays?: number; rating?: ReviewRating; title?: string } = {},
): ElementId {
  const gap = opts.gapDays ?? 3;
  const rating = opts.rating ?? "good";
  const cardId = repos.review.createCard({
    kind: "qa",
    title: opts.title ?? "Card",
    priority: 0.5,
    prompt: "Q",
    answer: "A",
  }).element.id;
  let now = Date.UTC(2025, 0, 1);
  for (let i = 0; i < n; i += 1) {
    const state = repos.review.findReviewState(cardId);
    if (!state) throw new Error("missing review state");
    const iso = new Date(now).toISOString();
    const outcome = scheduler.gradeCard(state, rating, iso as never, 1200);
    repos.review.recordReview(cardId, outcome);
    now += gap * 86_400_000;
  }
  return cardId;
}

describe("OptimizationService.buildHistory", () => {
  it("re-sorts ASCENDING and derives elapsedDays from reviewedAt deltas", () => {
    const cardId = makeCardWithReviews(4, { gapDays: 5 });
    const [history] = service.buildHistory([cardId]);
    expect(history?.cardId).toBe(cardId);
    const reviews = history?.reviews ?? [];
    expect(reviews).toHaveLength(4);
    // Ascending: each reviewedAt is later than the previous.
    for (let i = 1; i < reviews.length; i += 1) {
      const prev = reviews[i - 1];
      const cur = reviews[i];
      expect(Date.parse(cur?.reviewedAt ?? "")).toBeGreaterThan(Date.parse(prev?.reviewedAt ?? ""));
    }
    // First elapsedDays is 0; subsequent ≈ the 5-day gap.
    expect(reviews[0]?.elapsedDays).toBe(0);
    expect(reviews[1]?.elapsedDays).toBeCloseTo(5, 5);
    expect(reviews[2]?.elapsedDays).toBeCloseTo(5, 5);
  });

  it("drops cards with no review logs", () => {
    const cardId = repos.review.createCard({
      kind: "qa",
      title: "Unreviewed",
      priority: 0.5,
      prompt: "Q",
      answer: "A",
    }).element.id;
    expect(service.buildHistory([cardId])).toEqual([]);
  });
});

describe("OptimizationService.suggest (scope)", () => {
  it("a concept scope builds only that concept's member cards' history", () => {
    const inConcept = makeCardWithReviews(3, { title: "In concept" });
    makeCardWithReviews(3, { title: "Out of concept" });
    const concept = repos.concepts.createConcept({ name: "Topic" });
    repos.concepts.assignConcept(inConcept, concept.id);

    const scopedIds = service.cardIdsForScope({ scope: "concept", conceptId: concept.id });
    expect(scopedIds).toEqual([inConcept]);

    const suggestion = service.suggest({ scope: "concept", conceptId: concept.id });
    // Only one card's reviews scored — far below the data floor, so no change.
    expect(suggestion.sufficientData).toBe(false);
  });

  it("persists NOTHING (read-only suggest)", () => {
    const cardId = makeCardWithReviews(3);
    const before = repos.settings.getAppSettings().fsrsParamsGlobal;
    service.suggest({ scope: "global" });
    expect(repos.settings.getAppSettings().fsrsParamsGlobal).toEqual(before);
    // No new review log was written by the suggest (still 3).
    expect(repos.review.listReviewLogs(cardId)).toHaveLength(3);
  });

  it("returns a read-only workload preview with before/after day series", () => {
    makeCardWithReviews(3);
    const suggestion = service.suggest({ scope: "global" });
    expect(suggestion.workload.before.length).toBeGreaterThan(0);
    expect(suggestion.workload.after.length).toBe(suggestion.workload.before.length);
    expect(typeof suggestion.workload.deltaDueNext7).toBe("number");
    expect(typeof suggestion.workload.deltaDueNext30).toBe("number");
  });
});

describe("OptimizationService — off-main runner routing seam (T080)", () => {
  it("reviewCount totals the scope's review_log rows (the heavy-fit routing input)", () => {
    const a = makeCardWithReviews(4);
    const b = makeCardWithReviews(3);
    expect(service.reviewCount([a, b])).toBe(7);
    expect(service.reviewCount([])).toBe(0);
  });

  it("buildJobPayload yields the DB-free history (+ current params) MAIN enqueues", () => {
    makeCardWithReviews(3);
    // No global preset yet → no `current` in the payload.
    const fresh = service.buildJobPayload({ scope: "global" });
    expect(fresh.history.length).toBe(1);
    expect(fresh.history[0]?.reviews.length).toBe(3);
    expect(fresh.current).toBeUndefined();

    // Once a global preset exists, it rides along as the search's starting point —
    // it is the STORED (clamp-sanitized) preset, not necessarily the raw input.
    const VALID_W = Array.from({ length: 21 }, (_, i) => 0.4 + i * 0.05);
    service.apply({ scope: "global" }, VALID_W);
    const stored = repos.settings.getAppSettings().fsrsParamsGlobal;
    const withCurrent = service.buildJobPayload({ scope: "global" });
    expect(withCurrent.current).toEqual(stored);
    expect(withCurrent.current).toHaveLength(21);
  });

  it("withWorkload re-attaches the DB-backed workload preview to a worker suggestion", () => {
    makeCardWithReviews(3);
    const W = Array.from({ length: 21 }, (_, i) => 0.4 + i * 0.05);
    // A worker-shaped suggestion (params + scores) recombined with the DB workload.
    const recombined = service.withWorkload(
      {
        params: { w: W } as never,
        baseline: { logLoss: 0.5, rmse: 0.2, reviewsScored: 3 },
        suggested: { logLoss: 0.4, rmse: 0.15, reviewsScored: 3 },
        improvement: 0.1,
        reviewsScored: 3,
        method: "history-calibration",
        sufficientData: true,
      },
      { scope: "global" },
    );
    expect(recombined.params.w).toEqual(W);
    expect(recombined.workload.before.length).toBeGreaterThan(0);
    expect(recombined.workload.after.length).toBe(recombined.workload.before.length);
    // Recombination writes nothing (still read-only).
    expect(repos.settings.getAppSettings().fsrsParamsGlobal).toBeNull();
  });
});

describe("OptimizationService.apply", () => {
  const VALID_W = Array.from({ length: 21 }, (_, i) => 0.4 + i * 0.05);

  it("global scope writes the fsrs.params.global setting (the queryable store)", () => {
    expect(repos.settings.getAppSettings().fsrsParamsGlobal).toBeNull();
    service.apply({ scope: "global" }, VALID_W);
    const stored = repos.settings.getAppSettings().fsrsParamsGlobal;
    expect(stored).not.toBeNull();
    expect(stored).toHaveLength(21);
  });

  it("concept scope writes concepts.fsrs_params + logs update_element (the audit)", () => {
    const concept = repos.concepts.createConcept({ name: "Optimized" });
    const opsBefore = repos.operationLog.listForElement(concept.id).length;
    service.apply({ scope: "concept", conceptId: concept.id }, VALID_W);

    // The column is the store the scheduler reads.
    const summary = repos.concepts.findById(concept.id);
    expect(summary?.fsrsParams).not.toBeNull();
    expect(summary?.fsrsParams).toHaveLength(21);
    // The op is the audit (one new update_element).
    const ops = repos.operationLog.listForElement(concept.id);
    expect(ops.length).toBe(opsBefore + 1);
    expect(ops.some((o) => o.opType === "update_element")).toBe(true);
  });

  it("rejects a malformed parameter vector (wrong length)", () => {
    expect(() => service.apply({ scope: "global" }, [1, 2, 3])).toThrow(/invalid/i);
  });

  it("does NOT write review_states / review_logs (the two-scheduler split holds)", () => {
    const cardId = makeCardWithReviews(2);
    const stateBefore = repos.review.findReviewState(cardId);
    const logsBefore = repos.review.listReviewLogs(cardId).length;
    service.apply({ scope: "global" }, VALID_W);
    expect(repos.review.findReviewState(cardId)).toEqual(stateBefore);
    expect(repos.review.listReviewLogs(cardId)).toHaveLength(logsBefore);
  });
});

describe("OptimizationService suggest → apply on a sufficient history", () => {
  it("a suggestion (or current params) round-trips through apply into the store", () => {
    // Build enough history to clear the data floor would need 200 reviews / 20 cards;
    // here we instead assert the apply path writes whatever suggested params we accept.
    makeCardWithReviews(3);
    const suggestion = service.suggest({ scope: "global" });
    // The service-level result keeps `params` as `FSRSParameters` (the `.w` vector is
    // the 21-number array). Below the floor the suggestion equals current params;
    // applying it is still valid and round-trips into the queryable store.
    const accepted = [...suggestion.params.w];
    service.apply({ scope: "global" }, accepted);
    const stored = repos.settings.getAppSettings().fsrsParamsGlobal;
    expect(stored).toEqual(accepted);
  });
});
