/**
 * Migration `0039` test — T125 card-edit write-barrier marker columns.
 *
 * The migration adds three nullable columns to `review_logs`
 * (`edit_marker_at`/`edit_class`/`edit_choice`). It is deliberately HAND-EDITED to be
 * purely additive (`ALTER ADD COLUMN`) rather than the `review_logs` table rebuild
 * `drizzle-kit` wanted, because a copy/drop/rename rebuild of an FK-bearing review table
 * is the exact shape that nulled lineage in the 0030 incident.
 *
 * This test seeds a linked source→extract→card lineage graph plus a `review_states` row
 * and a `review_logs` grade through migration 38, runs to HEAD, and asserts the new
 * columns default NULL on existing rows, every preserved lineage + FSRS COLUMN value
 * survives (not just row counts), row counts are invariant, and the nullable-domain
 * CHECKs accept NULL / valid values and reject out-of-domain ones.
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
  const dir = mkdtempSync(path.join(os.tmpdir(), "interleave-db-0039-"));
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

function withDbThrough38<T>(fn: (handle: DbHandle) => T): T {
  const staged = stageMigrationsThrough(38);
  const handle = openDatabase(":memory:");
  try {
    migrateDatabase(handle.db, staged.drizzle);
    return fn(handle);
  } finally {
    handle.sqlite.close();
    rmSync(staged.dir, { recursive: true, force: true });
  }
}

const CREATED = "2026-06-14T00:00:00.000Z";

function seedGraphWithReview(handle: DbHandle): void {
  const insertElement = handle.sqlite.prepare(
    `INSERT INTO elements (
      id, type, status, stage, priority, title, parent_id, source_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 0.5, ?, ?, ?, ?, ?)`,
  );
  insertElement.run(
    "src",
    "source",
    "active",
    "raw_source",
    "Source",
    null,
    null,
    CREATED,
    CREATED,
  );
  insertElement.run(
    "ext",
    "extract",
    "active",
    "raw_extract",
    "Extract",
    "src",
    "src",
    CREATED,
    CREATED,
  );
  insertElement.run(
    "card",
    "card",
    "scheduled",
    "active_card",
    "Card",
    "ext",
    "src",
    CREATED,
    CREATED,
  );

  handle.sqlite
    .prepare(
      `INSERT INTO review_states (
        element_id, due_at, stability, difficulty, elapsed_days, scheduled_days,
        reps, lapses, fsrs_state, learning_steps, last_reviewed_at
      ) VALUES ('card', ?, 42.5, 6.1, 3, 40, 5, 1, 'review', 0, ?)`,
    )
    .run("2026-09-01T00:00:00.000Z", CREATED);

  handle.sqlite
    .prepare(
      `INSERT INTO review_logs (
        id, element_id, rating, reviewed_at, response_ms, prev_state, next_state,
        next_stability, next_difficulty, next_due_at
      ) VALUES ('log1', 'card', 'good', ?, 2500, 'review', 'review', 42.5, 6.1, ?)`,
    )
    .run(CREATED, "2026-09-01T00:00:00.000Z");
}

describe("migration 0039 — card-edit write-barrier marker columns", () => {
  it("adds the nullable columns, defaults them NULL, and preserves lineage + FSRS columns", () => {
    withDbThrough38((handle) => {
      seedGraphWithReview(handle);

      migrateDatabase(handle.db, MIGRATIONS_DIR);

      // The three new review_logs columns exist and are nullable.
      const columnInfo = handle.sqlite.prepare("PRAGMA table_info('review_logs')").all() as {
        readonly name: string;
        readonly notnull: number;
      }[];
      for (const name of ["edit_marker_at", "edit_class", "edit_choice"]) {
        const col = columnInfo.find((c) => c.name === name);
        expect(col, name).toBeDefined();
        expect(col?.notnull, name).toBe(0);
      }

      // The pre-existing grade row defaults all three new columns to NULL.
      const existing = handle.sqlite
        .prepare(
          "SELECT edit_marker_at, edit_class, edit_choice FROM review_logs WHERE id = 'log1'",
        )
        .get() as {
        edit_marker_at: string | null;
        edit_class: string | null;
        edit_choice: string | null;
      };
      expect(existing).toEqual({ edit_marker_at: null, edit_class: null, edit_choice: null });

      // Row-count invariance: an additive ALTER never copies/drops review rows.
      const counts = handle.sqlite
        .prepare(
          "SELECT (SELECT COUNT(*) FROM review_logs) AS logs, (SELECT COUNT(*) FROM review_states) AS states, (SELECT COUNT(*) FROM elements) AS els",
        )
        .get() as { logs: number; states: number; els: number };
      expect(counts).toEqual({ logs: 1, states: 1, els: 3 });

      // 0030 regression guard: lineage columns survive the migration.
      const lineage = handle.sqlite.prepare(
        "SELECT parent_id, source_id FROM elements WHERE id = ?",
      );
      expect(lineage.get("ext")).toEqual({ parent_id: "src", source_id: "src" });
      expect(lineage.get("card")).toEqual({ parent_id: "ext", source_id: "src" });

      // FSRS state columns survive value-for-value (a rebuild that mis-copied would lose these).
      const state = handle.sqlite
        .prepare(
          "SELECT stability, difficulty, reps, lapses, fsrs_state, due_at FROM review_states WHERE element_id = 'card'",
        )
        .get() as Record<string, unknown>;
      expect(state).toEqual({
        stability: 42.5,
        difficulty: 6.1,
        reps: 5,
        lapses: 1,
        fsrs_state: "review",
        due_at: "2026-09-01T00:00:00.000Z",
      });

      expect(handle.sqlite.pragma("foreign_key_check")).toEqual([]);
      expect(handle.sqlite.pragma("integrity_check", { simple: true })).toBe("ok");
    });
  });

  it("enforces the nullable-domain CHECKs on edit_class / edit_choice", () => {
    withDbThrough38((handle) => {
      seedGraphWithReview(handle);
      migrateDatabase(handle.db, MIGRATIONS_DIR);

      const insertMarker = (id: string, cls: string | null, choice: string | null) =>
        handle.sqlite
          .prepare(
            `INSERT INTO review_logs (
              id, element_id, rating, reviewed_at, response_ms, prev_state, next_state,
              next_stability, next_difficulty, next_due_at, edit_marker_at, edit_class, edit_choice
            ) VALUES (?, 'card', 'good', ?, 0, 'review', 'review', 1, 6.1, ?, ?, ?, ?)`,
          )
          .run(id, CREATED, "2026-06-15T00:00:00.000Z", CREATED, cls, choice);

      // A valid marker row (substantive + re_stabilize) is accepted.
      expect(() => insertMarker("m1", "substantive", "re_stabilize")).not.toThrow();
      // NULL class/choice (a normal grade) is accepted.
      expect(() => insertMarker("m2", null, null)).not.toThrow();
      // Out-of-domain values are rejected by the CHECKs.
      expect(() => insertMarker("m3", "bogus", "re_stabilize")).toThrow(/CHECK constraint failed/);
      expect(() => insertMarker("m4", "substantive", "nope")).toThrow(/CHECK constraint failed/);
    });
  });
});
