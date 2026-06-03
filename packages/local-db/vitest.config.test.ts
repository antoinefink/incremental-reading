import { describe, expect, it } from "vitest";
import config from "./vitest.config";

describe("local-db Vitest config", () => {
  it("runs source tests plus lightweight bench/config coverage, without the heavy scale gate", () => {
    expect(config.test?.include).toEqual([
      "src/**/*.test.ts",
      "bench/bench-harness.test.ts",
      "bench/scale.bench.test.ts",
      "vitest.config.test.ts",
      "vitest.bench-gate.config.test.ts",
    ]);
    expect(config.test?.include).not.toContain("bench/scale-budget.test.ts");
    expect(config.test?.testTimeout).toBe(30_000);
    expect(config.test?.hookTimeout).toBe(30_000);
  });
});
