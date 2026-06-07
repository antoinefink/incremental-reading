import { describe, expect, it } from "vitest";
import config from "./vitest.config";

describe("site Vitest config", () => {
  it("runs explicit site and config tests without a zero-test escape hatch", () => {
    expect(config.test?.name).toBe("site");
    expect(config.test?.environment).toBe("node");
    expect(config.test?.include).toEqual([
      "src/**/*.test.ts",
      "vite.config.test.ts",
      "vitest.config.test.ts",
    ]);
    expect(config.test).not.toHaveProperty("passWithNoTests");
  });
});
