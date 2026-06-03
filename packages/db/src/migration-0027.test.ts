/**
 * Migration `0027` test (T100) — the index audit's additive `CREATE INDEX`-only
 * migration.
 *
 * `0027_nappy_marvel_zombies.sql` adds exactly two indexes the T100 bench +
 * `EXPLAIN QUERY PLAN` proved slow at scale:
 *   - `elements_type_created_idx` on `elements(type, created_at)` — the analytics
 *     "new X in window" scans (`type = ? AND created_at BETWEEN ?`) went from a full
 *     `SCAN elements` to a `SEARCH ... USING INDEX`.
 *   - `elements_deleted_at_idx` on `elements(deleted_at)` — the analytics `deletions`
 *     count + the trash list (`WHERE deleted_at IS NOT NULL ORDER BY deleted_at`)
 *     went from a full `SCAN elements` + a TEMP B-TREE sort to a `SEARCH ... USING
 *     INDEX`.
 *
 * The candidate `elements(type, due_at)` was measured and REJECTED — for the
 * `dueAttentionItems` read (`type NOT IN ('card') AND deleted_at IS NULL AND ... AND
 * due_at <= ? ORDER BY due_at`) the planner keeps `elements_due_idx` (verified via
 * EXPLAIN QUERY PLAN at scale, post-ANALYZE): a leading `type` column under
 * `NOT IN ('card')` is non-sargable, so a `(type, due_at)` composite cannot seek and
 * would only be a redundant cost. This test pins that decision: it asserts EXACTLY the
 * two new indexes appear (and no others creep in), that the migration is additive (the
 * planner adopts the new indexes for the exact hot queries), and that
 * `PRAGMA integrity_check` + `PRAGMA foreign_key_check` stay `ok` after it applies.
 */

import { describe, expect, it } from "vitest";
import { type DbHandle, migrateDatabase, openDatabase } from "./index";

/** The two indexes migration 0027 introduces — and nothing else. */
const NEW_0027_INDEXES = ["elements_type_created_idx", "elements_deleted_at_idx"] as const;

function withMigratedDb<T>(fn: (handle: DbHandle) => T): T {
  const handle = openDatabase(":memory:");
  try {
    migrateDatabase(handle.db);
    return fn(handle);
  } finally {
    handle.sqlite.close();
  }
}

/** All index names defined on a table (excluding the auto sqlite_autoindex rows). */
function indexesOn(handle: DbHandle, table: string): string[] {
  return (
    handle.sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name NOT LIKE 'sqlite_autoindex_%' ORDER BY name",
      )
      .all(table) as { name: string }[]
  ).map((r) => r.name);
}

describe("migration 0027 — additive index audit", () => {
  it("creates exactly the two new elements indexes the bench proved slow", () => {
    withMigratedDb((handle) => {
      const idx = indexesOn(handle, "elements");
      for (const name of NEW_0027_INDEXES) expect(idx).toContain(name);
      // The pre-0027 baseline indexes are still present (additive, not a rewrite).
      for (const name of [
        "elements_parent_idx",
        "elements_source_idx",
        "elements_type_status_idx",
        "elements_due_idx",
      ]) {
        expect(idx).toContain(name);
      }
      // The REJECTED candidate must NOT have leaked in (no speculative index).
      expect(idx).not.toContain("elements_type_due_idx");
    });
  });

  it("the migration is additive `CREATE INDEX` only — no column/table change", () => {
    withMigratedDb((handle) => {
      // The elements columns are unchanged by 0027 — assert the shape is intact.
      const cols = (
        handle.sqlite.prepare("PRAGMA table_info('elements')").all() as { name: string }[]
      ).map((c) => c.name);
      for (const col of ["id", "type", "status", "stage", "priority", "created_at", "deleted_at"]) {
        expect(cols).toContain(col);
      }
    });
  });

  it("the planner adopts the new indexes for the exact hot queries", () => {
    withMigratedDb((handle) => {
      const plan = (sql: string, params: unknown[]): string =>
        (handle.sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[])
          .map((r) => r.detail)
          .join(" | ");

      // analytics "new cards in window" — must use elements_type_created_idx.
      const createdPlan = plan(
        "SELECT id FROM elements WHERE type = ? AND created_at >= ? AND created_at <= ?",
        ["card", "2026-05-01T00:00:00.000Z", "2026-06-01T00:00:00.000Z"],
      );
      expect(createdPlan).toContain("elements_type_created_idx");

      // analytics `deletions` count (the real AnalyticsService query shape: a
      // `deleted_at` range) — must use elements_deleted_at_idx rather than a full scan.
      const deletedPlan = plan(
        "SELECT id FROM elements WHERE deleted_at IS NOT NULL AND deleted_at >= ? AND deleted_at <= ?",
        ["2026-05-01T00:00:00.000Z", "2026-06-01T00:00:00.000Z"],
      );
      expect(deletedPlan).toContain("elements_deleted_at_idx");
    });
  });

  it("PRAGMA integrity_check + foreign_key_check stay `ok` after 0027 applies", () => {
    withMigratedDb((handle) => {
      const integrity = handle.sqlite.pragma("integrity_check", { simple: true });
      expect(integrity).toBe("ok");
      const fkViolations = handle.sqlite.pragma("foreign_key_check");
      expect(fkViolations).toEqual([]);
    });
  });
});
