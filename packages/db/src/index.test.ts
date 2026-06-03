import { describe, expect, it } from "vitest";
import {
  cards,
  DB_PACKAGE,
  DEV_DB_PATH,
  elements,
  MIGRATIONS_DIR,
  migrateDatabase,
  openDatabase,
  settings,
} from "./index";

describe("db barrel", () => {
  it("exports the package marker, client/migrator helpers, paths, and core tables", () => {
    expect(DB_PACKAGE).toBe("@interleave/db");
    expect(typeof openDatabase).toBe("function");
    expect(typeof migrateDatabase).toBe("function");
    expect(MIGRATIONS_DIR).toContain("drizzle");
    expect(DEV_DB_PATH).toContain("dev.sqlite");
    expect(elements).toBeDefined();
    expect(cards).toBeDefined();
    expect(settings).toBeDefined();
  });
});
