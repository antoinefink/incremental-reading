#!/usr/bin/env node
/**
 * T100 scale-bench driver.
 *
 * Runs the HARD p95 budget gate (`bench:gate` → `scale-budget.test.ts`, which FAILS
 * on a regression) and then the informational comparative table (`bench:table` →
 * `scale.bench.ts`).
 *
 *   pnpm bench                     # SMOKE profile (a few thousand elements) — fast.
 *   INTERLEAVE_BENCH_N=full pnpm bench   # the FULL ~100k run — opt-in / LOCAL only
 *                                  # (minutes + ~hundreds of MB of temp disk).
 *
 * CI runs the SMOKE profile (the bounded N); the full 100k run is the documented
 * local opt-in. Default is SMOKE so an accidental `pnpm bench` never grinds for
 * minutes; pass `INTERLEAVE_BENCH_N=full` for the real scale matrix.
 */

import { spawnSync } from "node:child_process";

const isFull = process.env.INTERLEAVE_BENCH_N === "full";
const profile = isFull ? "full" : "smoke";
const env = { ...process.env, INTERLEAVE_BENCH_N: profile };

console.log(`\n=== T100 scale bench — profile: ${profile} ===`);
if (!isFull) {
  console.log("(run `INTERLEAVE_BENCH_N=full pnpm bench` for the full ~100k local run)\n");
}

function run(label, args) {
  console.log(`\n--- ${label} ---`);
  const res = spawnSync("pnpm", args, { stdio: "inherit", env });
  if (res.status !== 0) {
    console.error(`\n[bench] ${label} FAILED (exit ${res.status ?? "signal"})`);
    process.exit(res.status ?? 1);
  }
}

// 1) The hard budget gate — fails the process on a p95 regression.
run("budget gate (hard p95 assertions)", ["bench:gate"]);
// 2) The informational comparative table.
run("comparative table", ["bench:table"]);

console.log("\n[bench] all scale budgets within bounds.\n");
