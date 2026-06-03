import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Dedicated Vitest config for the SCALE BUDGET GATE (T100).
 *
 * The hard p95 budget assertions live in `bench/scale-budget.test.ts` as a REAL
 * `*.test.ts` (so `expect` failures propagate + a regression FAILS the process) —
 * NOT a `*.bench.ts` (Vitest's `bench` mode ignores `it`/`expect` and a throwing
 * `bench` body does not fail the run). This config includes ONLY that file so the
 * gate is run on demand via `pnpm bench` and is NEVER collected by the normal
 * `pnpm test` (whose local-db project `include` is `src/**` — the gate lives under
 * `bench/`, outside it, so it does not bloat the normal test run).
 *
 * The full-scale gate seeds ~100k elements + ~1M review_logs into a throwaway temp
 * DB, so the timeout is generous.
 */
export default defineConfig({
  // Pin the root to THIS package so the relative `bench/...` include resolves
  // regardless of the cwd the script runs from (the repo root).
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    include: ["bench/scale-budget.test.ts"],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    // The seed + the measurement loops are heavy; one fork, no isolation churn.
    pool: "forks",
    // The provenance header + the p95/budget table ARE the deliverable, so don't
    // swallow them — pass `console.log` straight through to stdout.
    disableConsoleIntercept: true,
  },
});
