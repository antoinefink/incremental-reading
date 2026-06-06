/**
 * LineageGapQuery tests (T099) — the read-only lineage / value scans.
 *
 * Against this package's in-memory `createInMemoryDb` harness. Covers:
 *  - `cardsWithoutSources`: a card WITH a `source_location_id` is NOT a gap; a card
 *    with a live `source_id` is NOT a gap; a card derived (via `derived_from`) from an
 *    extract derived from a live source is NOT a gap (the lineage walk resolves the
 *    root); a hand-authored card with NONE of those IS a gap;
 *  - `brokenSourceCandidates`: a source with a snapshot asset is returned for the
 *    main-side disk join; a source with no snapshot row reports `hasSnapshotRow: false`;
 *  - `lowValueCandidates`: only low-priority (C/D) + stale items, lowest-value first.
 */

import { PRIORITY_LABEL_VALUE } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRepositories, type Repositories } from "./index";
import type { LineageGapQuery } from "./lineage-gap-query";
import { createInMemoryDb } from "./test-db";

let handle: DbHandle;
let repos: Repositories;
let gaps: LineageGapQuery;

beforeEach(() => {
  handle = createInMemoryDb();
  repos = createRepositories(handle.db);
  gaps = repos.lineageGap;
});

afterEach(() => {
  handle.sqlite.close();
});

function expectDefined<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`${label} was not found`);
  }
  return value;
}

/** A live source + an extract anchored at a source location. */
function seedSourceWithExtract() {
  const src = repos.sources.create({
    title: "Source",
    priority: PRIORITY_LABEL_VALUE.A,
    status: "active",
    stage: "raw_source",
  });
  const sourceId = src.element.id;
  const extract = repos.sources.createExtract({
    sourceElementId: sourceId,
    title: "Extract",
    priority: PRIORITY_LABEL_VALUE.A,
    selectedText: "x",
    blockIds: ["blk_1" as never],
    startOffset: 0,
    endOffset: 1,
    label: "L",
  });
  return { sourceId, extractId: extract.element.id, locationId: extract.location.id };
}

describe("LineageGapQuery.cardsWithoutSources", () => {
  it("a card WITH a source_location_id is NOT a gap", () => {
    const { sourceId, extractId, locationId } = seedSourceWithExtract();
    repos.review.createCard({
      kind: "qa",
      title: "Anchored",
      prompt: "Q",
      answer: "A",
      priority: 0.5,
      parentId: extractId,
      sourceId,
      sourceLocationId: locationId,
      stage: "active_card",
    });
    expect(gaps.cardsWithoutSources()).toEqual([]);
  });

  it("a card with a live source_id (but no location) is NOT a gap", () => {
    const { sourceId, extractId } = seedSourceWithExtract();
    repos.review.createCard({
      kind: "qa",
      title: "Source-rooted",
      prompt: "Q",
      answer: "A",
      priority: 0.5,
      parentId: extractId,
      sourceId,
      // no sourceLocationId
      stage: "active_card",
    });
    expect(gaps.cardsWithoutSources()).toEqual([]);
  });

  it("a card derived_from an extract derived_from a live source is NOT a gap", () => {
    const { sourceId, extractId } = seedSourceWithExtract();
    // The extract derives from the source.
    repos.elements.addRelation({
      fromElementId: extractId as never,
      toElementId: sourceId as never,
      relationType: "derived_from",
    });
    // A card with NO source_location_id and NO source_id, but a derived_from edge to
    // the extract → the walk resolves the live source root.
    const card = repos.review.createCard({
      kind: "qa",
      title: "Lineage-walked",
      prompt: "Q",
      answer: "A",
      priority: 0.5,
      stage: "active_card",
    });
    repos.elements.addRelation({
      fromElementId: card.element.id,
      toElementId: extractId as never,
      relationType: "derived_from",
    });
    expect(gaps.cardsWithoutSources()).toEqual([]);
  });

  it("a hand-authored card with no location, no source_id, no ancestor IS a gap", () => {
    const card = repos.review.createCard({
      kind: "qa",
      title: "Hand-authored",
      prompt: "Q",
      answer: "A",
      priority: 0.5,
      stage: "active_card",
    });
    const rows = gaps.cardsWithoutSources();
    expect(rows).toHaveLength(1);
    const row = expectDefined(rows[0], "sourceless card row");
    expect(row.card.id).toBe(card.element.id);
    expect(row.hasSourceLocation).toBe(false);
    expect(row.hasSourceAncestor).toBe(false);
  });

  it("a card whose source_id points at a SOFT-DELETED source IS a gap", () => {
    const { sourceId, extractId } = seedSourceWithExtract();
    const card = repos.review.createCard({
      kind: "qa",
      title: "Dead-source",
      prompt: "Q",
      answer: "A",
      priority: 0.5,
      parentId: extractId,
      sourceId,
      stage: "active_card",
    });
    repos.elements.softDelete(sourceId as never);
    const rows = gaps.cardsWithoutSources();
    expect(rows.map((r) => r.card.id)).toContain(card.element.id);
  });
});

describe("LineageGapQuery.brokenSourceCandidates", () => {
  it("returns a source with its snapshot asset rows for the disk join", () => {
    const { sourceId } = seedSourceWithExtract();
    const asset = repos.assets.create({
      owningElementId: sourceId as never,
      kind: "source_html",
      vaultRoot: "assets",
      relativePath: `sources/${sourceId}/cleaned.html`,
      contentHash: "h",
      mime: "text/html",
      size: 100,
    });
    const candidates = gaps.brokenSourceCandidates();
    const row = expectDefined(
      candidates.find((c) => c.source.id === sourceId),
      "broken source candidate",
    );
    expect(row.hasSnapshotRow).toBe(true);
    expect(row.snapshotAssets.map((a) => a.assetId)).toContain(asset.id);
    const snapshotAsset = expectDefined(row.snapshotAssets[0], "snapshot asset");
    expect(snapshotAsset.relativePath).toBe(`sources/${sourceId}/cleaned.html`);
  });

  it("a source with NO snapshot row reports hasSnapshotRow: false", () => {
    const { sourceId } = seedSourceWithExtract();
    const candidates = gaps.brokenSourceCandidates();
    const row = expectDefined(
      candidates.find((c) => c.source.id === sourceId),
      "source candidate",
    );
    expect(row.hasSnapshotRow).toBe(false);
    expect(row.snapshotAssets).toEqual([]);
  });

  it("a manual source (no snapshot_key) is NOT a noSnapshot candidate (expectsSnapshot: false)", () => {
    // `seedSourceWithExtract` creates a source with no `snapshot_key` — the manual case.
    const { sourceId } = seedSourceWithExtract();
    const row = expectDefined(
      gaps.brokenSourceCandidates().find((c) => c.source.id === sourceId),
      "manual source candidate",
    );
    expect(row.expectsSnapshot).toBe(false);
  });

  it("a source that RECORDED a snapshot (snapshot_key set) reports expectsSnapshot: true", () => {
    const src = repos.sources.create({
      title: "Recorded snapshot",
      priority: PRIORITY_LABEL_VALUE.A,
      status: "active",
      stage: "raw_source",
      snapshotKey: "sources/recorded/cleaned.html",
    });
    const row = expectDefined(
      gaps.brokenSourceCandidates().find((c) => c.source.id === src.element.id),
      "recorded snapshot source candidate",
    );
    expect(row.expectsSnapshot).toBe(true);
    expect(row.hasSnapshotRow).toBe(false);
  });
});

describe("LineageGapQuery.lowValueCandidates", () => {
  it("returns only low-priority (C/D), stale items, lowest-value first", () => {
    const asOf = "2026-06-01T00:00:00.000Z";
    // A high-priority stale source — excluded (not low band).
    repos.sources.create({
      title: "High value",
      priority: PRIORITY_LABEL_VALUE.A,
      status: "active",
      stage: "raw_source",
    });
    // A low-priority FRESH source — excluded (not stale; updated_at is "now").
    repos.sources.create({
      title: "Fresh low",
      priority: PRIORITY_LABEL_VALUE.D,
      status: "active",
      stage: "raw_source",
    });

    // Two low-priority STALE sources (force their updated_at into the past via a
    // priority change long ago? simpler: insert then backdate updated_at directly).
    const cSource = repos.sources.create({
      title: "C stale",
      priority: PRIORITY_LABEL_VALUE.C,
      status: "active",
      stage: "raw_source",
    });
    const dSource = repos.sources.create({
      title: "D stale",
      priority: PRIORITY_LABEL_VALUE.D,
      status: "active",
      stage: "raw_source",
    });
    backdateUpdatedAt(cSource.element.id, "2026-01-01T00:00:00.000Z");
    backdateUpdatedAt(dSource.element.id, "2026-01-02T00:00:00.000Z");

    const rows = gaps.lowValueCandidates({ asOf, staleDays: 30 });
    const ids = rows.map((r) => r.element.id);
    expect(ids).toContain(cSource.element.id);
    expect(ids).toContain(dSource.element.id);
    expect(ids).not.toContain("High value");
    // D (0.10) sorts before C (0.35) — lowest priority first.
    expect(ids[0]).toBe(dSource.element.id);
    // Every returned row is in the low band + stale.
    for (const r of rows) {
      expect(["C", "D"]).toContain(r.element.priorityLabel);
      expect(r.daysSinceActivity).toBeGreaterThanOrEqual(30);
    }
  });
});

/** Backdate an element's `updated_at` directly (test-only — simulates staleness). */
function backdateUpdatedAt(id: string, ts: string) {
  handle.sqlite.prepare("UPDATE elements SET updated_at = ? WHERE id = ?").run(ts, id);
}
