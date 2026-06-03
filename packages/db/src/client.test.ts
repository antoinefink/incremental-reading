import { describe, expect, it } from "vitest";
import { applyPragmas, openDatabase } from "./client";

describe("SQLite client", () => {
  it("opens an in-memory database with required pragmas applied", () => {
    const handle = openDatabase(":memory:");
    try {
      expect(handle.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(handle.sqlite.pragma("busy_timeout", { simple: true })).toBe(5000);
      expect(handle.db).toBeDefined();
    } finally {
      handle.sqlite.close();
    }
  });

  it("can re-apply pragmas idempotently", () => {
    const handle = openDatabase(":memory:");
    try {
      applyPragmas(handle.sqlite);
      expect(handle.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(handle.sqlite.pragma("busy_timeout", { simple: true })).toBe(5000);
    } finally {
      handle.sqlite.close();
    }
  });
});
