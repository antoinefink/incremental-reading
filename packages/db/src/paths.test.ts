import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEV_DB_PATH, MIGRATIONS_DIR, PACKAGE_ROOT } from "./paths";

describe("db package paths", () => {
  it("points migration and dev DB paths inside packages/db", () => {
    expect(path.basename(PACKAGE_ROOT)).toBe("db");
    expect(MIGRATIONS_DIR).toBe(path.join(PACKAGE_ROOT, "drizzle"));
    expect(DEV_DB_PATH).toBe(path.join(PACKAGE_ROOT, ".dev", "dev.sqlite"));
    expect(fs.existsSync(MIGRATIONS_DIR)).toBe(true);
  });
});
