import { describe, expect, it } from "vitest";
import { createInMemoryDb } from "./db";

describe("createInMemoryDb", () => {
  it("opens a migrated SQLite database with foreign keys enabled", () => {
    const handle = createInMemoryDb();
    try {
      const foreignKeys = handle.sqlite.prepare("PRAGMA foreign_keys").get() as {
        foreign_keys: 0 | 1;
      };
      const tables = handle.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as { name: string }[];

      expect(foreignKeys.foreign_keys).toBe(1);
      expect(tables.map((row) => row.name)).toEqual(
        expect.arrayContaining(["elements", "documents", "operation_log"]),
      );
    } finally {
      handle.sqlite.close();
    }
  });
});
