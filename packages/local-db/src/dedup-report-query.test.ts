/**
 * DedupReportQuery tests (T099) — the collection-wide duplicate rollup.
 *
 * Against a fresh in-memory SQLite DB (this package's `createInMemoryDb` harness).
 * Covers the keeper rule (newest `accessed_at` for sources — NULL last — for BOTH the
 * canonical-URL and content-hash paths; oldest + better-lineaged for cards/extracts),
 * the conservative content key (exact-match after fold; no false positives), soft-
 * delete exclusion, the cluster cap, and the `totalDuplicates` removable-copies count.
 */

import type { DbHandle } from "@interleave/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DedupReportQuery, normalizeContentKey, pickSourceKeeper } from "./dedup-report-query";
import { createRepositories, type Repositories } from "./index";
import { createInMemoryDb } from "./test-db";

let handle: DbHandle;
let repos: Repositories;
let dedup: DedupReportQuery;

beforeEach(() => {
  handle = createInMemoryDb();
  repos = createRepositories(handle.db);
  dedup = repos.dedupReport;
});

afterEach(() => {
  handle.sqlite.close();
});

/** Create a live source with the given canonical URL + accessed timestamp. */
function makeSource(
  canonicalUrl: string | null,
  accessedAt: string | null,
  title = "Article",
): string {
  return repos.sources.create({
    title,
    priority: 0.5,
    status: "active",
    stage: "raw_source",
    url: canonicalUrl,
    canonicalUrl,
    accessedAt,
  }).element.id;
}

/** Record a `source_html` cleaned-snapshot asset (metadata only) for a source. */
function addCleanedSnapshot(sourceId: string, contentHash: string) {
  return repos.assets.create({
    owningElementId: sourceId as never,
    kind: "source_html",
    vaultRoot: "assets",
    relativePath: `sources/${sourceId}/cleaned.html`,
    contentHash,
    mime: "text/html",
    size: 100,
  });
}

describe("DedupReportQuery.duplicateSources — canonical URL", () => {
  it("clusters live sources sharing a canonical URL, keeper = newest accessed_at", () => {
    const url = "https://example.com/spacing";
    const older = makeSource(url, "2026-05-01T00:00:00.000Z");
    const newer = makeSource(url, "2026-05-10T00:00:00.000Z");

    const clusters = dedup.duplicateSources();
    expect(clusters).toHaveLength(1);
    const c = clusters[0]!;
    expect(c.matchedBy).toBe("canonicalUrl");
    expect(c.key).toBe(url);
    expect(c.canonical.id).toBe(newer);
    expect(c.duplicates.map((d) => d.id)).toEqual([older]);
  });

  it("a NULL accessed_at member is NEVER the keeper when a real-timestamp sibling exists", () => {
    const url = "https://example.com/null-test";
    const nullAccessed = makeSource(url, null);
    const real = makeSource(url, "2020-01-01T00:00:00.000Z");

    const clusters = dedup.duplicateSources();
    expect(clusters).toHaveLength(1);
    // The real timestamp wins even though it is OLDER than "now" — NULL sorts last.
    expect(clusters[0]!.canonical.id).toBe(real);
    expect(clusters[0]!.duplicates.map((d) => d.id)).toEqual([nullAccessed]);
  });

  it("excludes soft-deleted sources and ignores singletons", () => {
    const url = "https://example.com/spacing";
    const live = makeSource(url, "2026-05-01T00:00:00.000Z");
    const deleted = makeSource(url, "2026-05-10T00:00:00.000Z");
    repos.elements.softDelete(deleted as never);
    // A lone source under a unique URL is not a cluster.
    makeSource("https://example.com/unique", "2026-05-05T00:00:00.000Z");

    const clusters = dedup.duplicateSources();
    // Only one live member remains under the shared URL → no cluster.
    expect(clusters).toEqual([]);
    expect(live).toBeTruthy();
  });
});

describe("DedupReportQuery.duplicateSources — content-hash backstop", () => {
  it("clusters sources sharing a cleaned-HTML hash under DIFFERENT urls, same keeper rule", () => {
    const a = makeSource("https://a.example.com/x", "2026-05-01T00:00:00.000Z");
    const b = makeSource("https://b.example.com/y", "2026-05-09T00:00:00.000Z");
    addCleanedSnapshot(a, "sharedhash");
    addCleanedSnapshot(b, "sharedhash");

    const clusters = dedup.duplicateSources();
    expect(clusters).toHaveLength(1);
    const c = clusters[0]!;
    expect(c.matchedBy).toBe("contentHash");
    expect(c.key).toBe("sharedhash");
    // The SAME keeper rule: newest accessed_at (b is newer).
    expect(c.canonical.id).toBe(b);
    expect(c.duplicates.map((d) => d.id)).toEqual([a]);
  });

  it("a source matched by BOTH canonical URL and hash appears ONCE (URL key wins)", () => {
    const url = "https://same.example.com/page";
    const a = makeSource(url, "2026-05-01T00:00:00.000Z");
    const b = makeSource(url, "2026-05-02T00:00:00.000Z");
    addCleanedSnapshot(a, "h");
    addCleanedSnapshot(b, "h");

    const clusters = dedup.duplicateSources();
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.matchedBy).toBe("canonicalUrl");
  });

  it("NULL accessed_at never wins in the content-hash path either", () => {
    const a = makeSource("https://a.example.com/x", null);
    const b = makeSource("https://b.example.com/y", "2019-01-01T00:00:00.000Z");
    addCleanedSnapshot(a, "h2");
    addCleanedSnapshot(b, "h2");

    const clusters = dedup.duplicateSources();
    expect(clusters[0]!.canonical.id).toBe(b);
  });
});

describe("DedupReportQuery.duplicateCards / duplicateExtracts", () => {
  /** Create the source + an extract the cards/extracts hang off. */
  function seedParent() {
    const src = repos.sources.create({
      title: "Parent source",
      priority: 0.5,
      status: "active",
      stage: "raw_source",
    });
    const sourceId = src.element.id;
    const extract = repos.sources.createExtract({
      sourceElementId: sourceId,
      title: "Parent extract",
      priority: 0.5,
      selectedText: "x",
      blockIds: ["blk_1" as never],
      startOffset: 0,
      endOffset: 1,
      label: "L",
    });
    return { sourceId, extractId: extract.element.id, locationId: extract.location.id };
  }

  it("clusters two cards with the identical normalized content key; keeper = oldest", () => {
    const { sourceId, extractId, locationId } = seedParent();
    const first = repos.review.createCard({
      kind: "qa",
      title: "Capital of France",
      prompt: "What is the capital of France?",
      answer: "Paris",
      priority: 0.5,
      parentId: extractId,
      sourceId,
      sourceLocationId: locationId,
      stage: "active_card",
    });
    // A later re-creation with whitespace/case differences → same normalized key.
    const second = repos.review.createCard({
      kind: "qa",
      title: "Capital of France",
      prompt: "  What is the   CAPITAL of France?  ",
      answer: "paris",
      priority: 0.5,
      parentId: extractId,
      sourceId,
      stage: "active_card",
    });

    const clusters = dedup.duplicateCards();
    expect(clusters).toHaveLength(1);
    const c = clusters[0]!;
    // Keeper prefers the better-lineaged (has source_location_id) copy = first.
    expect(c.canonical.id).toBe(first.element.id);
    expect(c.duplicates.map((d) => d.id)).toEqual([second.element.id]);
  });

  it("does NOT cluster genuinely-different cards (no false positives)", () => {
    const { sourceId, extractId, locationId } = seedParent();
    repos.review.createCard({
      kind: "qa",
      title: "Capital of France",
      prompt: "What is the capital of France?",
      answer: "Paris",
      priority: 0.5,
      parentId: extractId,
      sourceId,
      sourceLocationId: locationId,
      stage: "active_card",
    });
    repos.review.createCard({
      kind: "qa",
      title: "Capital of Germany",
      prompt: "What is the capital of Germany?",
      answer: "Berlin",
      priority: 0.5,
      parentId: extractId,
      sourceId,
      stage: "active_card",
    });
    expect(dedup.duplicateCards()).toEqual([]);
  });

  it("the content key folds case + whitespace but is exact otherwise", () => {
    expect(normalizeContentKey("  Hello  World ", "A\n\nB")).toBe(
      normalizeContentKey("hello world", "a b"),
    );
    expect(normalizeContentKey("a", "b")).not.toBe(normalizeContentKey("a", "c"));
  });
});

describe("DedupReportQuery.report", () => {
  it("totalDuplicates counts only removable copies; respects the cluster cap", () => {
    // Three sources under one URL → 1 cluster, 2 removable.
    const url = "https://example.com/triple";
    makeSource(url, "2026-05-01T00:00:00.000Z");
    makeSource(url, "2026-05-02T00:00:00.000Z");
    makeSource(url, "2026-05-03T00:00:00.000Z");

    const report = dedup.report();
    expect(report.sourceClusters).toHaveLength(1);
    expect(report.sourceClusters[0]!.duplicates).toHaveLength(2);
    expect(report.totalDuplicates).toBe(2);

    // The cap bounds the cluster count.
    const capped = dedup.report({ limit: 0 });
    expect(capped.sourceClusters).toEqual([]);
  });

  it("pickSourceKeeper is a stable pure helper (NULL last, id tiebreak)", () => {
    const keeper = pickSourceKeeper([
      { id: "z", accessedAt: null },
      { id: "a", accessedAt: "2020-01-01T00:00:00.000Z" },
      { id: "b", accessedAt: "2020-01-01T00:00:00.000Z" },
    ]);
    // Same timestamp → id DESC tiebreak picks "b".
    expect(keeper.id).toBe("b");
  });
});
