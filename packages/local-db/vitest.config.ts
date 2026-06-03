import { defineConfig } from "vitest/config";

/**
 * Vitest config for `@interleave/local-db`.
 *
 * Picked up by the root `vitest.config.ts` `projects: ["packages/*"]` glob (which
 * does NOT inherit root-level `test` options, so timeouts must live here).
 *
 * `testTimeout`/`hookTimeout` are raised above Vitest's 5s default because the
 * `*.property.test.ts` suites (concept-membership, library/queue/search drill-down
 * counts) drive `fast-check` with `numRuns: 150`, rebuilding a fresh in-memory
 * SQLite world per run — legitimately ~5–6s each. At the 5s default they tip over
 * the moment the machine is under load and flake the whole-suite-green gate. A 30s
 * ceiling gives these slow-but-correct property tests firm headroom (≈5–6× their
 * ~5–6s baseline) so the gate stays green even under concurrent CPU load, while
 * still catching a genuine hang. The project name is left to derive from
 * package.json so the reporter label stays `@interleave/local-db`.
 */
export default defineConfig({
  test: {
    include: [
      "src/**/*.test.ts",
      "bench/bench-harness.test.ts",
      "bench/scale.bench.test.ts",
      "vitest.config.test.ts",
      "vitest.bench-gate.config.test.ts",
    ],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
