import { afterEach, describe, expect, it } from "vitest";
import type { BenchWorld } from "./bench-harness";
import { measure, provenanceHeader, useSmokeProfile } from "./bench-harness";

const originalBenchN = process.env.INTERLEAVE_BENCH_N;

afterEach(() => {
  if (originalBenchN === undefined) {
    delete process.env.INTERLEAVE_BENCH_N;
  } else {
    process.env.INTERLEAVE_BENCH_N = originalBenchN;
  }
});

describe("scale bench harness helpers", () => {
  it("uses the smoke profile only when explicitly requested", () => {
    delete process.env.INTERLEAVE_BENCH_N;
    expect(useSmokeProfile()).toBe(false);

    process.env.INTERLEAVE_BENCH_N = "smoke";
    expect(useSmokeProfile()).toBe(true);

    process.env.INTERLEAVE_BENCH_N = "full";
    expect(useSmokeProfile()).toBe(false);
  });

  it("formats the provenance header from seeded world stats", () => {
    process.env.INTERLEAVE_BENCH_N = "smoke";
    const world = {
      vecOk: true,
      stats: {
        sources: 2,
        extracts: 3,
        cards: 4,
        reviewLogs: 5,
        embeddings: 6,
        elements: 7,
        dbSizeBytes: 1_500_000,
      },
    } as BenchWorld;

    expect(provenanceHeader(world, 42)).toBe(
      "[scale.bench] profile=smoke vec=true sources=2 extracts=3 cards=4 reviewLogs=5 " +
        "embeddings=6 elements=7 seedMs=42 dbSize=1.5MB",
    );
  });

  it("warms up before measuring the requested sample count", () => {
    let calls = 0;
    const result = measure(() => {
      calls += 1;
    }, 5);

    expect(calls).toBe(8);
    expect(result.min).toBeGreaterThanOrEqual(0);
    expect(result.p50).toBeGreaterThanOrEqual(0);
    expect(result.p95).toBeGreaterThanOrEqual(0);
  });
});
