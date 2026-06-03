import { getTableColumns, getTableName } from "drizzle-orm";
import { check, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import { inList } from "./_shared";

describe("schema shared helpers", () => {
  it("builds CHECK expressions that can be attached to SQLite tables", () => {
    const probe = sqliteTable("enum_probe", { value: text("value").notNull() }, (table) => [
      check("enum_probe_value_check", inList(table.value, ["alpha", "bob's"])),
    ]);

    expect(getTableName(probe)).toBe("enum_probe");
    expect(Object.keys(getTableColumns(probe))).toEqual(["value"]);
  });
});
