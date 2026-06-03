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

describe("db:reset:dev script", () => {
  it("removes only the dev DB siblings before re-migrating", async () => {
    const rmSync = vi.fn();
    const mkdirSync = vi.fn();
    const dirname = vi.fn(() => "/tmp/interleave-db");
    const close = vi.fn();
    const db = { kind: "drizzle-db" };
    const openDatabase = vi.fn(() => ({ db, sqlite: { close } }));
    const migrateDatabase = vi.fn();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    vi.doMock("node:fs", () => ({ default: { mkdirSync, rmSync } }));
    vi.doMock("node:path", () => ({ default: { dirname } }));
    vi.doMock("../src/index", () => ({ migrateDatabase, openDatabase }));
    vi.doMock("../src/paths", () => ({ DEV_DB_PATH }));

    await import("./reset-dev");

    expect(rmSync.mock.calls).toEqual([
      [DEV_DB_PATH, { force: true }],
      [`${DEV_DB_PATH}-wal`, { force: true }],
      [`${DEV_DB_PATH}-shm`, { force: true }],
    ]);
    expect(mkdirSync).toHaveBeenCalledWith("/tmp/interleave-db", { recursive: true });
    expect(openDatabase).toHaveBeenCalledWith(DEV_DB_PATH);
    expect(migrateDatabase).toHaveBeenCalledWith(db);
    expect(close).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(`[db:reset:dev] reset and re-migrated ${DEV_DB_PATH}`);
  });
});
