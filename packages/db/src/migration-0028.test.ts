/**
 * Migration `0028` test — review-log stats snapshot columns.
 *
 * The new columns make future Anki-like review stats possible, but rows written
 * before this feature did not capture those values. The migration must therefore
 * preserve "unknown" as NULL instead of backfilling fake zeroes into immutable
 * historical review logs.
 */

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type DbHandle, MIGRATIONS_DIR, migrateDatabase, openDatabase } from "./index";

const NEW_0028_COLUMNS = [
  "prompt_ms",
  "prev_due_at",
  "prev_stability",
  "prev_difficulty",
  "prev_elapsed_days",
  "prev_scheduled_days",
  "prev_reps",
  "prev_lapses",
  "prev_learning_steps",
  "prev_last_reviewed_at",
  "next_elapsed_days",
  "next_scheduled_days",
  "next_reps",
  "next_lapses",
  "next_learning_steps",
] as const;

function stageMigrationsThrough(maxIdx: number): {
  readonly dir: string;
  readonly drizzle: string;
} {
  const dir = mkdtempSync(path.join(os.tmpdir(), "interleave-db-0028-"));
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

function withDbThrough27<T>(fn: (handle: DbHandle) => T): T {
  const staged = stageMigrationsThrough(27);
  const handle = openDatabase(":memory:");
  try {
    migrateDatabase(handle.db, staged.drizzle);
    return fn(handle);
  } finally {
    handle.sqlite.close();
    rmSync(staged.dir, { recursive: true, force: true });
  }
}

describe("migration 0028 — review-log stats snapshot", () => {
  it("keeps pre-existing review logs with NULL stats snapshot fields after upgrade", () => {
    withDbThrough27((handle) => {
      handle.sqlite
        .prepare(
          `INSERT INTO elements (
            id, type, status, stage, priority, title, created_at, updated_at
          ) VALUES (?, 'card', 'active', 'active_card', 0.875, 'Legacy card', ?, ?)`,
        )
        .run("card_legacy", "2026-05-01T00:00:00.000Z", "2026-05-01T00:00:00.000Z");
      handle.sqlite
        .prepare(
          `INSERT INTO review_logs (
            id, element_id, rating, reviewed_at, response_ms,
            prev_state, next_state, next_stability, next_difficulty, next_due_at
          ) VALUES (?, ?, 'good', ?, 1200, 'new', 'review', 4.5, 5.25, ?)`,
        )
        .run("log_legacy", "card_legacy", "2026-05-02T00:00:00.000Z", "2026-05-10T00:00:00.000Z");

      migrateDatabase(handle.db, MIGRATIONS_DIR);

      const columnInfo = handle.sqlite.prepare("PRAGMA table_info('review_logs')").all() as {
        readonly name: string;
        readonly notnull: number;
        readonly dflt_value: string | null;
      }[];
      for (const column of NEW_0028_COLUMNS) {
        const info = columnInfo.find((candidate) => candidate.name === column);
        expect(info).toBeDefined();
        expect(info?.notnull).toBe(0);
        expect(info?.dflt_value).toBeNull();
      }

      const row = handle.sqlite
        .prepare(
          `SELECT ${NEW_0028_COLUMNS.map((column) => `"${column}"`).join(", ")}
           FROM review_logs
           WHERE id = ?`,
        )
        .get("log_legacy") as Record<(typeof NEW_0028_COLUMNS)[number], unknown>;
      for (const column of NEW_0028_COLUMNS) {
        expect(row[column]).toBeNull();
      }
    });
  });
});
