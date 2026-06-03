import { describe, expect, it } from "vitest";
import { openDatabase } from "./client";
import { applyVecMigration, migrateDatabase } from "./migrator";
import { MIGRATIONS_DIR } from "./paths";

function tableNames(filename = ":memory:") {
  const handle = openDatabase(filename);
  return {
    handle,
    names: () =>
      handle.sqlite
        .prepare("select name from sqlite_master where type = 'table'")
        .all()
        .map((row) => (row as { name: string }).name),
  };
}

describe("migrateDatabase", () => {
  it("applies the generated migrations and can be called twice", () => {
    const { handle, names } = tableNames();
    try {
      migrateDatabase(handle.db);
      migrateDatabase(handle.db);
      expect(names()).toEqual(expect.arrayContaining(["elements", "sources", "operation_log"]));
    } finally {
      handle.sqlite.close();
    }
  });

  it("supports the legacy string migrations-folder argument", () => {
    const { handle, names } = tableNames();
    try {
      migrateDatabase(handle.db, MIGRATIONS_DIR);
      expect(names()).toContain("__drizzle_migrations");
    } finally {
      handle.sqlite.close();
    }
  });

  it("skips the sqlite-vec table unless vecAvailable is true", () => {
    const { handle, names } = tableNames();
    try {
      migrateDatabase(handle.db, { vecAvailable: false });
      expect(names()).not.toContain("element_vectors");
    } finally {
      handle.sqlite.close();
    }
  });
});

describe("applyVecMigration", () => {
  it("throws clearly when called without a loaded sqlite-vec extension", () => {
    const { handle } = tableNames();
    try {
      expect(() => applyVecMigration(handle.db)).toThrow(/vec0|no such module/i);
    } finally {
      handle.sqlite.close();
    }
  });
});
