/**
 * Scale benchmark (T100) — the INFORMATIONAL comparative table for the hot READ
 * paths (Vitest `bench` mode, p50/p75/p99 + relative speedups).
 *
 * The HARD p95 budget GATE lives in `scale-budget.test.ts` (a real `*.test.ts` so
 * `expect` failures propagate — Vitest's `bench` mode ignores `it`/`expect` and a
 * throwing `bench` body does NOT fail the run). `pnpm bench` runs BOTH: the gate
 * first (fails on regression), then this comparative table.
 *
 * ============================================================================
 * HOW TO RUN
 * ----------------------------------------------------------------------------
 *   pnpm bench                       # the gate (smoke profile by default) + this table
 *   INTERLEAVE_BENCH_N=full pnpm bench   # the FULL ~100k run — opt-in / LOCAL only.
 *                                    # ~100k cards / ~100k extracts / ~1M review_logs;
 *                                    # minutes + ~hundreds of MB of temp disk.
 *
 * `vitest bench` runs ONE pass and exits (not a watcher), and is NOT collected by
 * `pnpm test`, so the normal test run is never bloated. Budgets + the throwaway
 * bench-DB builder live in `bench-harness.ts`. Everything runs behind the local-db
 * boundary — NO renderer, NO `window.appApi`, NO generic `db.query`; the bench DB is
 * a throwaway temp file, never the user/dev DB.
 */

import { EMBEDDING_DIM, embedTextLocal } from "@interleave/core";
import { afterAll, beforeAll, bench, describe } from "vitest";
import { QueueQuery } from "../src/queue-query";
import { ReviewSessionService } from "../src/review-session-service";
import { BENCH_AS_OF, type BenchWorld, buildBenchWorld, provenanceHeader } from "./bench-harness";

const BENCH_TIME_MS = 1000; // per-path sampling window.

let world: BenchWorld;
let queryVector: number[];
let conceptName: string | undefined;

beforeAll(() => {
  const t0 = Date.now();
  world = buildBenchWorld();
  // eslint-disable-next-line no-console
  console.log(`\n${provenanceHeader(world, Date.now() - t0)}\n`);
  queryVector = embedTextLocal("spaced repetition intervals memory", EMBEDDING_DIM);
  const row = world.handle.sqlite.prepare("SELECT name FROM concepts LIMIT 1").get() as
    | { name?: string }
    | undefined;
  conceptName = row?.name;
});

afterAll(() => {
  world?.cleanup();
});

describe("scale.bench — hot read paths (informational comparative table)", () => {
  bench(
    "QueueQuery.list (daily queue, full mode)",
    () => {
      void new QueueQuery(world.repos).list({ asOf: BENCH_AS_OF, limit: 50 });
    },
    { time: BENCH_TIME_MS },
  );

  bench(
    "QueueQuery.list (concept-filtered — N+1 seam)",
    () => {
      void new QueueQuery(world.repos).list({
        asOf: BENCH_AS_OF,
        limit: 50,
        ...(conceptName ? { filters: { concept: conceptName } } : {}),
      });
    },
    { time: BENCH_TIME_MS },
  );

  bench(
    "SearchRepository.search (multi-term FTS)",
    () => {
      void world.repos.search.search("intelligence efficiency memory", { limit: 30 });
    },
    { time: BENCH_TIME_MS },
  );

  bench(
    "EmbeddingRepository.knn (vec0 KNN)",
    () => {
      if (!world.vecOk) return;
      void world.repos.embeddings.knn(queryVector, { limit: 20 });
    },
    { time: BENCH_TIME_MS },
  );

  bench(
    "ReviewSessionService.nextReviewCard (FSRS next-pick + bury)",
    () => {
      void new ReviewSessionService(world.handle.db).nextReviewCard({
        asOf: BENCH_AS_OF,
        limit: 50,
      });
    },
    { time: BENCH_TIME_MS },
  );

  bench(
    "AnalyticsService.computeAnalytics (window over review history)",
    () => {
      void world.repos.analytics.computeAnalytics(BENCH_AS_OF);
    },
    { time: BENCH_TIME_MS },
  );

  bench(
    "MaintenanceQuery.report (dedup + lineage-gap scans)",
    () => {
      void world.repos.dedupReport.duplicateSources();
      void world.repos.lineageGap.cardsWithoutSources();
      void world.repos.lineageGap.brokenSourceCandidates();
      void world.repos.lineageGap.lowValueCandidates({ asOf: BENCH_AS_OF });
    },
    { time: BENCH_TIME_MS },
  );
});
