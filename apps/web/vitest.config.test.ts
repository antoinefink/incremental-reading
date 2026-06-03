import { describe, expect, it } from "vitest";
import config from "./vitest.config";

describe("web Vitest config", () => {
  it("uses jsdom, Testing Library setup, and explicit renderer test includes", () => {
    expect(config.plugins).toHaveLength(1);
    expect(config.test?.name).toBe("web");
    expect(config.test?.environment).toBe("jsdom");
    expect(config.test?.globals).toBe(true);
    expect(config.test?.setupFiles).toEqual(["./vitest.setup.ts"]);
    expect(config.test?.include).toEqual([
      "src/**/*.test.{ts,tsx}",
      "vite.config.test.ts",
      "vitest.config.test.ts",
      "vitest.setup.test.ts",
    ]);
  });
});
