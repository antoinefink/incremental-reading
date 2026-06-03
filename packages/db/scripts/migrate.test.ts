import { afterEach, describe, expect, it, vi } from "vitest";

const DEV_DB_PATH = "/tmp/interleave-db/dev.sqlite";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("node:fs");
  vi.doUnmock("node:path");
  vi.doUnmock("../src/index");
  vi.doUnmock("../src/paths");
});

describe("db:migrate script", () => {
  it("creates the dev DB directory, migrates it, and closes the SQLite handle", async () => {
    const mkdirSync = vi.fn();
    const dirname = vi.fn(() => "/tmp/interleave-db");
    const close = vi.fn();
    const db = { kind: "drizzle-db" };
    const openDatabase = vi.fn(() => ({ db, sqlite: { close } }));
    const migrateDatabase = vi.fn();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    vi.doMock("node:fs", () => ({ default: { mkdirSync } }));
    vi.doMock("node:path", () => ({ default: { dirname } }));
    vi.doMock("../src/index", () => ({ migrateDatabase, openDatabase }));
    vi.doMock("../src/paths", () => ({ DEV_DB_PATH }));

    await import("./migrate");

    expect(dirname).toHaveBeenCalledWith(DEV_DB_PATH);
    expect(mkdirSync).toHaveBeenCalledWith("/tmp/interleave-db", { recursive: true });
    expect(openDatabase).toHaveBeenCalledWith(DEV_DB_PATH);
    expect(migrateDatabase).toHaveBeenCalledWith(db);
    expect(close).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(`[db:migrate] migrations applied to ${DEV_DB_PATH}`);
  });
});
