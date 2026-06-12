/**
 * Migration `0036` test — per-element attention interval multiplier.
 *
 * Existing elements receive the neutral `1.0` multiplier, and the database owns
 * the valid range so every writer path is bounded even before domain validation.
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
  const dir = mkdtempSync(path.join(os.tmpdir(), "interleave-db-0036-"));
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

function withDbThrough35<T>(fn: (handle: DbHandle) => T): T {
  const staged = stageMigrationsThrough(35);
  const handle = openDatabase(":memory:");
  try {
    migrateDatabase(handle.db, staged.drizzle);
    return fn(handle);
  } finally {
    handle.sqlite.close();
    rmSync(staged.dir, { recursive: true, force: true });
  }
}

function insertTopicElement(handle: DbHandle, id: string): void {
  handle.sqlite
    .prepare(
      `INSERT INTO elements (
        id, type, status, stage, priority, title, created_at, updated_at
      ) VALUES (?, 'topic', 'active', 'rough_topic', 0.5, ?, '2026-06-12T00:00:00.000Z', '2026-06-12T00:00:00.000Z')`,
    )
    .run(id, `Topic ${id}`);
}

describe("migration 0036 — attention interval multiplier", () => {
  it("backfills the neutral multiplier and enforces the bounded range", () => {
    withDbThrough35((handle) => {
      insertTopicElement(handle, "existing-topic");

      migrateDatabase(handle.db, MIGRATIONS_DIR);

      expect(
        handle.sqlite
          .prepare("SELECT attention_interval_multiplier FROM elements WHERE id = 'existing-topic'")
          .get(),
      ).toEqual({ attention_interval_multiplier: 1 });

      expect(() =>
        handle.sqlite
          .prepare(
            "UPDATE elements SET attention_interval_multiplier = 0.49 WHERE id = 'existing-topic'",
          )
          .run(),
      ).toThrow(/CHECK constraint failed/);
      expect(() =>
        handle.sqlite
          .prepare(
            `INSERT INTO elements (
              id, type, status, stage, priority, attention_interval_multiplier, title, created_at, updated_at
            ) VALUES (
              'bad-topic', 'topic', 'active', 'rough_topic', 0.5, 4.01, 'Bad', '2026-06-12T00:00:00.000Z', '2026-06-12T00:00:00.000Z'
            )`,
          )
          .run(),
      ).toThrow(/CHECK constraint failed/);
      expect(handle.sqlite.pragma("foreign_key_check")).toEqual([]);
    });
  });
});
