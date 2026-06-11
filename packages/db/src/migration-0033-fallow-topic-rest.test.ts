/**
 * Migration `0033` test — topic fallow state.
 *
 * T107 adds nullable fallow metadata to `elements`. This proves an already-migrated
 * 0032 database keeps existing element rows intact while gaining the new nullable
 * columns used by the fallow service.
 */

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type DbHandle, MIGRATIONS_DIR, migrateDatabase, openDatabase } from "./index";

function stageMigrationsThrough(maxIdx: number): {
  readonly dir: string;
  readonly drizzle: string;
} {
  const dir = mkdtempSync(path.join(os.tmpdir(), "interleave-db-0033-"));
  const drizzle = path.join(dir, "drizzle");
  const meta = path.join(drizzle, "meta");
  mkdirSync(meta, { recursive: true });

  const journal = JSON.parse(
    readFileSync(path.join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"),
  ) as { readonly entries: readonly { readonly idx: number; readonly tag: string }[] };
  const entries = journal.entries.filter((entry) => entry.idx <= maxIdx);
  for (const entry of entries) {
    cpSync(path.join(MIGRATIONS_DIR, `${entry.tag}.sql`), path.join(drizzle, `${entry.tag}.sql`));
  }
  writeFileSync(path.join(meta, "_journal.json"), JSON.stringify({ ...journal, entries }));

  return { dir, drizzle };
}

function withDbThrough32<T>(fn: (handle: DbHandle) => T): T {
  const staged = stageMigrationsThrough(32);
  const handle = openDatabase(":memory:");
  try {
    migrateDatabase(handle.db, staged.drizzle);
    return fn(handle);
  } finally {
    handle.sqlite.close();
    rmSync(staged.dir, { recursive: true, force: true });
  }
}

describe("migration 0033 — topic fallow state", () => {
  it("adds nullable fallow columns without disturbing existing element rows", () => {
    withDbThrough32((handle) => {
      handle.sqlite
        .prepare(
          `INSERT INTO elements (
            id, type, status, stage, priority, due_at, title, parent_id, source_id, created_at, updated_at, parked_at
          ) VALUES (
            'topic_0033', 'topic', 'scheduled', 'rough_topic', 0.5,
            '2026-06-02T00:00:00.000Z', 'Topic 0033', NULL, NULL,
            '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z', NULL
          )`,
        )
        .run();
      handle.sqlite
        .prepare(
          `INSERT INTO elements (
            id, type, status, stage, priority, due_at, title, parent_id, source_id, created_at, updated_at, parked_at
          ) VALUES (
            'extract_0033', 'extract', 'scheduled', 'raw_extract', 0.5,
            '2026-06-02T00:00:00.000Z', 'Extract 0033', 'topic_0033', NULL,
            '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z', NULL
          )`,
        )
        .run();

      migrateDatabase(handle.db, MIGRATIONS_DIR);

      const columns = handle.sqlite.prepare("PRAGMA table_info(elements)").all() as {
        readonly name: string;
      }[];
      expect(columns.map((column) => column.name)).toEqual(
        expect.arrayContaining(["fallow_until", "fallow_reason", "fallow_batch_id"]),
      );
      expect(
        handle.sqlite
          .prepare(
            `SELECT fallow_until, fallow_reason, fallow_batch_id
             FROM elements WHERE id = 'topic_0033'`,
          )
          .get(),
      ).toEqual({ fallow_until: null, fallow_reason: null, fallow_batch_id: null });
      expect(
        handle.sqlite.prepare("SELECT parent_id FROM elements WHERE id = 'extract_0033'").get(),
      ).toEqual({ parent_id: "topic_0033" });
      expect(handle.sqlite.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(handle.sqlite.pragma("foreign_key_check")).toEqual([]);
    });
  });
});
