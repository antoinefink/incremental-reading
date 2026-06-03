import { describe, expect, it } from "vitest";
import config from "./drizzle.config";

describe("drizzle config", () => {
  it("targets the SQLite schema barrel and package-local dev database", () => {
    expect(config.dialect).toBe("sqlite");
    expect(config.schema).toBe("./src/schema/index.ts");
    expect(config.out).toBe("./drizzle");
    expect(config.dbCredentials).toEqual({ url: "./.dev/dev.sqlite" });
    expect(config.strict).toBe(true);
    expect(config.verbose).toBe(true);
  });
});
