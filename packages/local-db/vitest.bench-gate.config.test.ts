import { describe, expect, it } from "vitest";
import config from "./vitest.bench-gate.config";

describe("local-db scale-budget Vitest config", () => {
  it("isolates the heavy scale-budget gate behind the bench command", () => {
    expect(config.root).toContain("packages/local-db");
    expect(config.test?.include).toEqual(["bench/scale-budget.test.ts"]);
    expect(config.test?.testTimeout).toBe(600_000);
    expect(config.test?.hookTimeout).toBe(600_000);
    expect(config.test?.pool).toBe("forks");
    expect(config.test?.disableConsoleIntercept).toBe(true);
  });
});
