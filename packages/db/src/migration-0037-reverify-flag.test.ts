/**
 * Migration `0037` test — T123 content-staleness flag + provenance.
 *
 * The migration adds `elements.needs_reverify` (+ `stale_since`),
 * `source_block_processing.pre_stale_hash`, and the `element_reverify_provenance`
 * table. It is deliberately HAND-EDITED to be purely additive (`ALTER ADD COLUMN`
 * + `CREATE TABLE`) rather than the table rebuild `drizzle-kit` wanted, because a
 * rebuild of `elements` is the exact shape that nulled lineage in the 0030 incident.
 *
 * This test seeds a linked source→extract→card lineage graph through migration 36,
 * runs to HEAD, and asserts every preserved `elements` lineage COLUMN value survives
 * (not just side-table row counts), the new columns default correctly, the
 * type-coupled CHECK behaves, and the provenance table enforces its unique triple.
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
  const dir = mkdtempSync(path.join(os.tmpdir(), "interleave-db-0037-"));
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

function withDbThrough36<T>(fn: (handle: DbHandle) => T): T {
  const staged = stageMigrationsThrough(36);
  const handle = openDatabase(":memory:");
  try {
    migrateDatabase(handle.db, staged.drizzle);
    return fn(handle);
  } finally {
    handle.sqlite.close();
    rmSync(staged.dir, { recursive: true, force: true });
  }
}

const CREATED = "2026-06-13T00:00:00.000Z";

function seedLineageGraph(handle: DbHandle): void {
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
      `INSERT INTO source_block_processing (
        id, source_element_id, stable_block_id, state, block_content_hash, created_at, updated_at
      ) VALUES (?, ?, ?, 'extracted', ?, ?, ?)`,
    )
    .run("sbp1", "src", "blk1", "hash-a", CREATED, CREATED);
}

describe("migration 0037 — content-staleness flag + provenance", () => {
  it("adds the columns/table, defaults them, and preserves lineage columns", () => {
    withDbThrough36((handle) => {
      seedLineageGraph(handle);

      migrateDatabase(handle.db, MIGRATIONS_DIR);

      // New elements columns exist with the right shape.
      const columnInfo = handle.sqlite.prepare("PRAGMA table_info('elements')").all() as {
        readonly name: string;
        readonly notnull: number;
        readonly dflt_value: string | null;
      }[];
      const needsReverify = columnInfo.find((c) => c.name === "needs_reverify");
      expect(needsReverify).toBeDefined();
      expect(needsReverify?.notnull).toBe(1);
      // The column carries a DEFAULT so the NOT NULL add backfills existing rows.
      expect(needsReverify?.dflt_value).not.toBeNull();
      const staleSince = columnInfo.find((c) => c.name === "stale_since");
      expect(staleSince).toBeDefined();
      expect(staleSince?.notnull).toBe(0);

      // Existing rows default to not-stale.
      const existing = handle.sqlite
        .prepare("SELECT needs_reverify, stale_since FROM elements WHERE id = 'card'")
        .get() as { needs_reverify: number; stale_since: string | null };
      expect(existing).toEqual({ needs_reverify: 0, stale_since: null });

      // Row-count invariance: the additive migration must not DROP any element row (a
      // table rebuild that silently lost rows would still pass the column-value checks
      // above on the surviving rows — assert the full seeded set survived).
      const elementCount = handle.sqlite.prepare("SELECT COUNT(*) AS n FROM elements").get() as {
        n: number;
      };
      expect(elementCount.n).toBe(3);

      // The 0030 regression guard: lineage COLUMNS of the elements table itself must
      // survive (a rebuild would have nulled parent_id/source_id via ON DELETE SET NULL).
      const lineage = handle.sqlite.prepare(
        "SELECT parent_id, source_id FROM elements WHERE id = ?",
      );
      expect(lineage.get("ext")).toEqual({ parent_id: "src", source_id: "src" });
      expect(lineage.get("card")).toEqual({ parent_id: "ext", source_id: "src" });

      // source_block_processing gains pre_stale_hash (nullable), preserving the seeded row.
      const sbpColumns = handle.sqlite
        .prepare("PRAGMA table_info('source_block_processing')")
        .all() as { readonly name: string }[];
      expect(sbpColumns.some((c) => c.name === "pre_stale_hash")).toBe(true);
      const sbp = handle.sqlite
        .prepare(
          "SELECT block_content_hash, pre_stale_hash FROM source_block_processing WHERE id = 'sbp1'",
        )
        .get() as { block_content_hash: string | null; pre_stale_hash: string | null };
      expect(sbp).toEqual({ block_content_hash: "hash-a", pre_stale_hash: null });

      expect(handle.sqlite.pragma("foreign_key_check")).toEqual([]);
      expect(handle.sqlite.pragma("integrity_check", { simple: true })).toBe("ok");
    });
  });

  it("enforces the type-coupled needs_reverify CHECK", () => {
    withDbThrough36((handle) => {
      seedLineageGraph(handle);
      migrateDatabase(handle.db, MIGRATIONS_DIR);

      // A derived element (extract/card/media_fragment) may be flagged.
      expect(() =>
        handle.sqlite.prepare("UPDATE elements SET needs_reverify = 1 WHERE id = 'ext'").run(),
      ).not.toThrow();
      expect(() =>
        handle.sqlite.prepare("UPDATE elements SET needs_reverify = 1 WHERE id = 'card'").run(),
      ).not.toThrow();

      // A source may NOT be content-stale (it is never the DERIVED side).
      expect(() =>
        handle.sqlite.prepare("UPDATE elements SET needs_reverify = 1 WHERE id = 'src'").run(),
      ).toThrow(/CHECK constraint failed/);
    });
  });

  it("creates element_reverify_provenance with a unique triple", () => {
    withDbThrough36((handle) => {
      seedLineageGraph(handle);
      migrateDatabase(handle.db, MIGRATIONS_DIR);

      const insert = handle.sqlite.prepare(
        `INSERT INTO element_reverify_provenance (
          id, element_id, source_element_id, stable_block_id, batch_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      expect(() => insert.run("p1", "ext", "src", "blk1", "batch1", CREATED)).not.toThrow();
      // Same (element, source, block) triple is rejected (idempotence anchor).
      expect(() => insert.run("p2", "ext", "src", "blk1", "batch2", CREATED)).toThrow(
        /UNIQUE constraint failed/,
      );
      // A different block for the same element is a distinct provenance fact.
      expect(() => insert.run("p3", "ext", "src", "blk2", "batch1", CREATED)).not.toThrow();

      // Hard-deleting the element cascades its provenance away.
      handle.sqlite.prepare("DELETE FROM elements WHERE id = 'ext'").run();
      const remaining = handle.sqlite
        .prepare("SELECT COUNT(*) AS n FROM element_reverify_provenance WHERE element_id = 'ext'")
        .get() as { n: number };
      expect(remaining.n).toBe(0);
      expect(handle.sqlite.pragma("foreign_key_check")).toEqual([]);
    });
  });
});
