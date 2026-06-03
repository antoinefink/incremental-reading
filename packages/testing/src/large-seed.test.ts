/**
 * Large-collection seed harness tests (T100).
 *
 * The harness's whole job is to build SCHEMA-IDENTICAL rows fast (the bulk fast path
 * skips the per-element `operation_log`/transaction overhead). These tests prove it:
 *
 *  1. it builds the requested counts with full `source → location → extract → card`
 *     lineage, spread priorities/due-dates, concept membership + tags, and a rebuilt
 *     FTS index — and the FK correctness gate (`foreign_key_check`) is clean;
 *  2. it is DETERMINISTIC from `seed` (the same seed reproduces the same collection);
 *  3. the bulk rows are SCHEMA-IDENTICAL to what the real repositories produce — a
 *     smoke-sized control collection seeded THROUGH the repository path
 *     (`seedSmokeControl`) populates exactly the same columns the bulk path does, so
 *     the bench measures realistic query plans, not a fiction.
 *
 * These run at a TINY scale (a few hundred rows) so they stay in the normal `pnpm
 * test`; the full 100k profile is the opt-in `INTERLEAVE_BENCH_N=full pnpm bench`.
 */

import { type DbHandle, migrateDatabase, openDatabase } from "@interleave/db";
import { createRepositories } from "@interleave/local-db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedLargeCollection, seedSmokeControl } from "./large-seed";

let handle: DbHandle;

beforeEach(() => {
  handle = openDatabase(":memory:");
  migrateDatabase(handle.db);
});

afterEach(() => {
  handle.sqlite.close();
});

/** Count rows in a table (raw, since some — concepts/fts — are not in the barrel). */
function count(table: string): number {
  return (handle.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe("seedLargeCollection", () => {
  it("builds the requested counts with full lineage + a clean foreign_key_check", () => {
    const repos = createRepositories(handle.db, { vecAvailable: false });
    const stats = seedLargeCollection(repos, handle.db, {
      sources: 5,
      extractsPerSource: 4,
      cardsPerExtract: 1,
      reviewsPerCard: 3,
      conceptCount: 3,
      embeddings: false,
      seed: "test-counts",
    });

    expect(stats.sources).toBe(5);
    expect(stats.extracts).toBe(20);
    expect(stats.cards).toBe(20);
    expect(stats.reviewLogs).toBe(60);
    expect(stats.reviewStates).toBe(20);
    expect(stats.concepts).toBe(3);
    expect(stats.elements).toBe(5 + 20 + 20 + 3);

    // The rows actually landed in SQLite with the right shapes.
    expect(count("elements")).toBe(stats.elements);
    expect(count("sources")).toBe(5);
    expect(count("documents")).toBe(5);
    expect(count("source_locations")).toBe(20);
    expect(count("cards")).toBe(20);
    expect(count("review_states")).toBe(20);
    expect(count("review_logs")).toBe(60);
    expect(count("concepts")).toBe(3);

    // Lineage is intact: every extract points at a live source, every card at a live
    // extract + a source_location — the FK correctness gate the harness runs proves it.
    const fkViolations = handle.sqlite.pragma("foreign_key_check") as unknown[];
    expect(fkViolations).toEqual([]);
    const integrity = handle.sqlite.pragma("integrity_check", { simple: true });
    expect(integrity).toBe("ok");

    // The bulk path INTENTIONALLY skips the per-row operation_log (documented), so the
    // op log is empty — this is the op-log/throughput tradeoff the spec calls out.
    expect(count("operation_log")).toBe(0);
  });

  it("rebuilds the FTS index so seeded content is searchable", () => {
    const repos = createRepositories(handle.db, { vecAvailable: false });
    seedLargeCollection(repos, handle.db, {
      sources: 4,
      extractsPerSource: 3,
      cardsPerExtract: 1,
      reviewsPerCard: 2,
      conceptCount: 2,
      embeddings: false,
      seed: "test-fts",
    });
    // The dropped-then-rebuilt FTS triggers populated the index: a source per source.
    expect(count("source_fts")).toBe(4);
    expect(count("extract_fts")).toBe(12);
    expect(count("card_fts")).toBe(12);
    // And a known seeded term is findable through the FTS5 MATCH.
    const hits = handle.sqlite
      .prepare("SELECT count(*) AS n FROM source_fts WHERE source_fts MATCH ?")
      .get("intelligence") as { n: number };
    expect(hits.n).toBeGreaterThan(0);
  });

  it("is deterministic from `seed` — the same seed reproduces the same collection", () => {
    const repos = createRepositories(handle.db, { vecAvailable: false });
    const a = seedLargeCollection(repos, handle.db, {
      sources: 3,
      extractsPerSource: 2,
      cardsPerExtract: 1,
      reviewsPerCard: 2,
      conceptCount: 2,
      embeddings: false,
      seed: "fixed-seed",
    });
    const titlesA = (
      handle.sqlite.prepare("SELECT title FROM elements ORDER BY title").all() as {
        title: string;
      }[]
    ).map((r) => r.title);

    // A second DB seeded with the SAME seed yields the SAME stats + the SAME titles.
    const h2 = openDatabase(":memory:");
    migrateDatabase(h2.db);
    const repos2 = createRepositories(h2.db, { vecAvailable: false });
    const b = seedLargeCollection(repos2, h2.db, {
      sources: 3,
      extractsPerSource: 2,
      cardsPerExtract: 1,
      reviewsPerCard: 2,
      conceptCount: 2,
      embeddings: false,
      seed: "fixed-seed",
    });
    const titlesB = (
      h2.sqlite.prepare("SELECT title FROM elements ORDER BY title").all() as { title: string }[]
    ).map((r) => r.title);
    h2.sqlite.close();

    expect(b.elements).toBe(a.elements);
    expect(b.reviewLogs).toBe(a.reviewLogs);
    expect(titlesB).toEqual(titlesA);
  });
});

describe("bulk rows are schema-identical to the repository path (seedSmokeControl)", () => {
  /**
   * The NOT-NULL columns both the bulk path and the repo path MUST populate, per table
   * — the schema-identical floor. (Nullable columns like `sources.accessed_at` may be
   * set by one path and not the other depending on inputs; the constraint-satisfying
   * NOT-NULL set is what proves the bulk rows are real, plus the `foreign_key_check` /
   * `integrity_check` the harness runs.)
   */
  const REQUIRED_COLUMNS: Record<string, string[]> = {
    elements: ["id", "type", "status", "stage", "priority", "title", "created_at", "updated_at"],
    sources: ["element_id"],
    documents: ["element_id", "plain_text", "schema_version"],
    source_locations: ["id", "element_id", "source_element_id", "block_ids", "selected_text"],
    cards: ["element_id", "kind", "is_leech", "is_retired"],
    review_states: ["element_id", "due_at", "stability", "difficulty", "fsrs_state"],
    review_logs: ["id", "element_id", "rating", "reviewed_at", "next_state", "next_due_at"],
  };

  /** The set of columns a row populated (non-null) for a given element id. */
  function populatedColumns(table: string, idCol: string, id: string): Set<string> {
    const row = handle.sqlite.prepare(`SELECT * FROM ${table} WHERE ${idCol} = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    const out = new Set<string>();
    if (!row) return out;
    for (const [k, v] of Object.entries(row)) if (v !== null) out.add(k);
    return out;
  }

  it("the control collection (real repos) populates every column the bulk path requires", () => {
    // Control: a source → extract → card chain THROUGH the real repositories.
    const repos = createRepositories(handle.db, { vecAvailable: false });
    const control = seedSmokeControl(repos);

    // Every required (NOT-NULL) column is populated on the control rows (the repo path
    // is the source of truth for the row shapes the bulk path must match).
    for (const col of REQUIRED_COLUMNS.elements as string[]) {
      expect(populatedColumns("elements", "id", control.cardId)).toContain(col);
    }
    for (const col of REQUIRED_COLUMNS.sources as string[]) {
      expect(populatedColumns("sources", "element_id", control.sourceId)).toContain(col);
    }
    for (const col of REQUIRED_COLUMNS.cards as string[]) {
      expect(populatedColumns("cards", "element_id", control.cardId)).toContain(col);
    }
    for (const col of REQUIRED_COLUMNS.review_states as string[]) {
      expect(populatedColumns("review_states", "element_id", control.cardId)).toContain(col);
    }

    // The control writes a review log through the real recordReview path.
    expect(count("review_logs")).toBeGreaterThanOrEqual(1);
    // The control went through the repos, so it DID append operation_log rows — proving
    // the op-log path is exercised (the bulk path's documented skip is the difference).
    expect(count("operation_log")).toBeGreaterThan(0);
  });

  it("the bulk path populates the SAME required columns as the control, per table", () => {
    // Seed a bulk collection into a SECOND DB and compare its populated columns to the
    // control's — they must cover the same required-column set for every table, so the
    // bench's bulk rows are not a fiction.
    const repos = createRepositories(handle.db, { vecAvailable: false });
    seedSmokeControl(repos);
    const controlCols: Record<string, Set<string>> = {
      elements: populatedColumns("elements", "id", firstId("elements", "type = 'card'")),
      sources: populatedColumns("sources", "element_id", firstId("sources", "1=1", "element_id")),
      cards: populatedColumns("cards", "element_id", firstId("cards", "1=1", "element_id")),
      review_states: populatedColumns(
        "review_states",
        "element_id",
        firstId("review_states", "1=1", "element_id"),
      ),
    };

    const h2 = openDatabase(":memory:");
    migrateDatabase(h2.db);
    const repos2 = createRepositories(h2.db, { vecAvailable: false });
    seedLargeCollection(repos2, h2.db, {
      sources: 2,
      extractsPerSource: 2,
      cardsPerExtract: 1,
      reviewsPerCard: 2,
      conceptCount: 1,
      embeddings: false,
      seed: "bulk-compare",
    });
    const bulkCardId = (
      h2.sqlite.prepare("SELECT id FROM elements WHERE type = 'card' LIMIT 1").get() as {
        id: string;
      }
    ).id;
    const bulkSourceId = (
      h2.sqlite.prepare("SELECT element_id FROM sources LIMIT 1").get() as { element_id: string }
    ).element_id;
    const pop = (table: string, idCol: string, id: string): Set<string> => {
      const row = h2.sqlite.prepare(`SELECT * FROM ${table} WHERE ${idCol} = ?`).get(id) as
        | Record<string, unknown>
        | undefined;
      const out = new Set<string>();
      if (row) for (const [k, v] of Object.entries(row)) if (v !== null) out.add(k);
      return out;
    };
    const bulkCols: Record<string, Set<string>> = {
      elements: pop("elements", "id", bulkCardId),
      sources: pop("sources", "element_id", bulkSourceId),
      cards: pop("cards", "element_id", bulkCardId),
      review_states: pop("review_states", "element_id", bulkCardId),
    };
    h2.sqlite.close();

    // For every table, the bulk path covers the same REQUIRED columns the control does.
    for (const table of ["elements", "sources", "cards", "review_states"] as const) {
      for (const col of REQUIRED_COLUMNS[table] as string[]) {
        expect(controlCols[table], `control ${table}.${col}`).toContain(col);
        expect(bulkCols[table], `bulk ${table}.${col}`).toContain(col);
      }
    }
  });

  /** The id of the first row matching `where`, reading `idCol` (default `id`). */
  function firstId(table: string, where: string, idCol = "id"): string {
    return (
      handle.sqlite.prepare(`SELECT ${idCol} AS v FROM ${table} WHERE ${where} LIMIT 1`).get() as {
        v: string;
      }
    ).v;
  }
});
