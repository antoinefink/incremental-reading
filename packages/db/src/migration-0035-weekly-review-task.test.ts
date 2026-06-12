/**
 * Migration `0035` test — weekly review task kind + singleton guard.
 *
 * T110 adds `weekly_review` to the closed task-kind CHECK and a partial unique index
 * that permits only one open weekly review session. The migration rebuilds `tasks`,
 * so this test stages a pre-0035 database with an existing task row, migrates to
 * HEAD, and verifies both preservation and the new constraint.
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
  const dir = mkdtempSync(path.join(os.tmpdir(), "interleave-db-0035-"));
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

function withDbThrough34<T>(fn: (handle: DbHandle) => T): T {
  const staged = stageMigrationsThrough(34);
  const handle = openDatabase(":memory:");
  try {
    migrateDatabase(handle.db, staged.drizzle);
    return fn(handle);
  } finally {
    handle.sqlite.close();
    rmSync(staged.dir, { recursive: true, force: true });
  }
}

function insertTaskElement(handle: DbHandle, id: string): void {
  handle.sqlite
    .prepare(
      `INSERT INTO elements (
        id, type, status, stage, priority, title, created_at, updated_at
      ) VALUES (?, 'task', 'scheduled', 'rough_topic', 0.5, ?, '2026-06-12T00:00:00.000Z', '2026-06-12T00:00:00.000Z')`,
    )
    .run(id, `Task ${id}`);
}

function insertTaskRow(handle: DbHandle, id: string, taskType: string, status = "scheduled"): void {
  handle.sqlite
    .prepare(
      `INSERT INTO tasks (element_id, task_type, due_at, status, linked_element_id, note)
       VALUES (?, ?, '2026-06-12T00:00:00.000Z', ?, NULL, NULL)`,
    )
    .run(id, taskType, status);
}

describe("migration 0035 — weekly review task kind", () => {
  it("preserves existing task rows and enforces one open weekly review", () => {
    withDbThrough34((handle) => {
      insertTaskElement(handle, "old-custom");
      insertTaskRow(handle, "old-custom", "custom");

      migrateDatabase(handle.db, MIGRATIONS_DIR);

      expect(
        handle.sqlite.prepare("SELECT task_type FROM tasks WHERE element_id = 'old-custom'").get(),
      ).toEqual({ task_type: "custom" });

      insertTaskElement(handle, "weekly-1");
      insertTaskRow(handle, "weekly-1", "weekly_review");
      insertTaskElement(handle, "weekly-done");
      insertTaskRow(handle, "weekly-done", "weekly_review", "done");
      expect(handle.sqlite.prepare("SELECT COUNT(*) AS n FROM tasks").get()).toMatchObject({
        n: 3,
      });
      insertTaskElement(handle, "weekly-2");

      expect(() => insertTaskRow(handle, "weekly-2", "weekly_review")).toThrow(
        /tasks_open_weekly_review_uq|UNIQUE constraint failed/,
      );
      insertTaskElement(handle, "bad-kind");
      expect(() => insertTaskRow(handle, "bad-kind", "not_a_task_type")).toThrow(
        /CHECK constraint failed/,
      );
      expect(handle.sqlite.pragma("foreign_key_check")).toEqual([]);
    });
  });
});
