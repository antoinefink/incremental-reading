/**
 * LineageQuery tests (T023).
 *
 * The lineage tree's read query is the seam that keeps hierarchy domain logic out
 * of React, so its behaviour is unit-tested against a temporary, fully-migrated
 * in-memory `better-sqlite3` database. The chain it builds mirrors the SHARED demo
 * collection (`source → extract → sub-extract → Q&A/cloze card`) the seed CLI +
 * the E2E flow use — built here through the repositories (rather than importing
 * `@interleave/testing`, which depends on this package) so the fixture stays
 * deterministic without a dependency cycle.
 *
 * These assert the load-bearing invariants the lineage tree surfaces:
 *  - for ANY element (source / extract / sub-extract / card) the query resolves
 *    the SAME lineage root and returns the SAME depth-ordered descendant tree;
 *  - depths are correct: source = 0, extract = 1, sub-extract + cards = 2;
 *  - the requested element is marked `active` (bidirectional navigation hinge);
 *  - sub-extracts read as `meta: "sub-extract"`; soft-deleted nodes drop out;
 *  - an unknown / soft-deleted id returns `null`.
 */

import type { BlockId } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRepositories, type Repositories } from "./index";
import { LineageQuery } from "./lineage-query";
import { createInMemoryDb } from "./test-db";

let handle: DbHandle;
let repos: Repositories;
let lineage: LineageQuery;

beforeEach(() => {
  handle = createInMemoryDb();
  repos = createRepositories(handle.db);
  lineage = new LineageQuery(repos);
});

afterEach(() => {
  handle.sqlite.close();
});

/** Build a source → extract → sub-extract → (Q&A + cloze cards) chain. */
function buildChain() {
  const source = repos.sources.create({
    title: "On the Measure of Intelligence",
    priority: 0.875,
    status: "active",
  });
  const sourceId = source.element.id;

  const extract = repos.sources.createExtract({
    sourceElementId: sourceId,
    title: "Intelligence = skill-acquisition efficiency",
    priority: 0.875,
    selectedText: "We define the intelligence of a system…",
    blockIds: ["blk_def_p1" as BlockId],
    startOffset: 0,
    endOffset: 80,
    label: "Definition · ¶1",
  });
  const extractId = extract.element.id;
  // Advance the distillation stage (matches the seed's atomic_statement extract).
  repos.elements.update(extractId, { stage: "clean_extract", status: "active" });
  repos.elements.update(extractId, { stage: "atomic_statement" });

  // Sub-extract: parent is the extract, source is still the original source.
  const subExtract = repos.sources.createExtract({
    sourceElementId: sourceId,
    parentId: extractId,
    title: "Must control for priors and experience",
    priority: 0.625,
    selectedText: "with respect to priors, experience…",
    blockIds: ["blk_def_p1" as BlockId],
    startOffset: 115,
    endOffset: 181,
    label: "Definition · ¶1 (clause)",
  });
  const subExtractId = subExtract.element.id;

  // Two cards distilled from the extract.
  const qaCard = repos.review.createCard({
    kind: "qa",
    title: "Chollet's definition of intelligence",
    priority: 0.875,
    prompt: "How does Chollet define intelligence?",
    answer: "Skill-acquisition efficiency over a scope of tasks.",
    parentId: extractId,
    sourceId,
    sourceLocationId: extract.location.id,
    stage: "active_card",
  });
  const clozeCard = repos.review.createCard({
    kind: "cloze",
    title: "Intelligence definition (cloze)",
    priority: 0.625,
    cloze: "Intelligence is a measure of {{c1::skill-acquisition efficiency}}.",
    parentId: extractId,
    sourceId,
    sourceLocationId: extract.location.id,
    stage: "card_draft",
  });

  return {
    sourceId,
    extractId,
    subExtractId,
    qaCardId: qaCard.element.id,
    clozeCardId: clozeCard.element.id,
  };
}

/** Find one node by id in a flattened lineage. */
function node(data: NonNullable<ReturnType<LineageQuery["get"]>>, id: string) {
  return data.nodes.find((n) => n.id === id);
}

describe("LineageQuery.get — the source → extract → sub-extract → card tree", () => {
  it("returns the full descendant tree rooted at the source, with correct depths", () => {
    const { sourceId, extractId, subExtractId, qaCardId, clozeCardId } = buildChain();

    const data = lineage.get(sourceId);
    expect(data).not.toBeNull();
    if (!data) return;

    expect(data.rootId).toBe(sourceId);
    expect(data.elementId).toBe(sourceId);

    // Every element in the chain appears exactly once.
    const ids = data.nodes.map((n) => n.id);
    expect(ids).toContain(sourceId);
    expect(ids).toContain(extractId);
    expect(ids).toContain(subExtractId);
    expect(ids).toContain(qaCardId);
    expect(ids).toContain(clozeCardId);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates

    // Depths: source (0) → extract (1) → sub-extract + cards (2).
    expect(node(data, sourceId)?.depth).toBe(0);
    expect(node(data, extractId)?.depth).toBe(1);
    expect(node(data, subExtractId)?.depth).toBe(2);
    expect(node(data, qaCardId)?.depth).toBe(2);
    expect(node(data, clozeCardId)?.depth).toBe(2);
  });

  it("marks the requested element active and roots every element at the same source", () => {
    const { sourceId, extractId, subExtractId, qaCardId } = buildChain();

    // The root + the flattened set are identical regardless of entry point...
    const fromSource = lineage.get(sourceId);
    const fromExtract = lineage.get(extractId);
    const fromSub = lineage.get(subExtractId);
    const fromCard = lineage.get(qaCardId);
    expect(fromSource).not.toBeNull();
    for (const data of [fromExtract, fromSub, fromCard]) {
      expect(data?.rootId).toBe(sourceId);
      expect(data?.nodes.map((n) => n.id).sort()).toEqual(
        fromSource?.nodes.map((n) => n.id).sort(),
      );
    }

    // ...but the `active` flag follows the entry point (bidirectional nav hinge).
    expect(fromExtract && node(fromExtract, extractId)?.active).toBe(true);
    expect(fromExtract && node(fromExtract, sourceId)?.active).toBe(false);
    expect(fromSub && node(fromSub, subExtractId)?.active).toBe(true);
    expect(fromCard && node(fromCard, qaCardId)?.active).toBe(true);
  });

  it("labels nodes with kit-style meta (source / stage / sub-extract / card type)", () => {
    const { sourceId, extractId, subExtractId, qaCardId } = buildChain();
    const data = lineage.get(sourceId);
    expect(data).not.toBeNull();
    if (!data) return;

    expect(node(data, sourceId)?.meta).toBe("source");
    // The extract was advanced to atomic_statement.
    expect(node(data, extractId)?.meta).toBe("atomic_statement");
    // The sub-extract reads as "sub-extract" (its parent is an extract).
    expect(node(data, subExtractId)?.meta).toBe("sub-extract");
    // Cards carry their type.
    expect(node(data, qaCardId)?.type).toBe("card");
  });

  it("returns nodes in pre-order DFS so the indented tree reads top-to-bottom", () => {
    const { sourceId, extractId, subExtractId } = buildChain();
    const data = lineage.get(sourceId);
    expect(data).not.toBeNull();
    if (!data) return;

    const order = data.nodes.map((n) => n.id);
    const sourceIdx = order.indexOf(sourceId);
    const extractIdx = order.indexOf(extractId);
    const subIdx = order.indexOf(subExtractId);
    // Source comes first; the extract precedes its own descendants.
    expect(sourceIdx).toBe(0);
    expect(extractIdx).toBeLessThan(subIdx);
  });
});

describe("LineageQuery.get — soft-delete + absence", () => {
  it("drops a soft-deleted descendant from the tree", () => {
    const { sourceId, extractId, subExtractId } = buildChain();
    repos.elements.softDelete(subExtractId);
    const data = lineage.get(sourceId);
    expect(data?.nodes.map((n) => n.id)).not.toContain(subExtractId);
    // The rest of the chain survives.
    expect(data?.nodes.map((n) => n.id)).toContain(extractId);
  });

  it("returns null for an unknown id", () => {
    expect(lineage.get("nope-not-an-id" as never)).toBeNull();
  });

  it("returns null for a soft-deleted element", () => {
    const { extractId } = buildChain();
    repos.elements.softDelete(extractId);
    expect(lineage.get(extractId)).toBeNull();
  });
});

describe("LineageQuery.get — tombstone-aware reads (includeTombstones)", () => {
  it("R1: keeps a live card under its soft-deleted parent extract, marked deleted", () => {
    const { sourceId, extractId, qaCardId } = buildChain();
    // Soft-delete the MIDDLE extract; the card below it is still live and parented.
    repos.elements.softDelete(extractId);

    // Without the flag, the live-only walk prunes the deleted middle (and so the
    // card vanishes from its own lineage) — the exact confusion this fixes.
    const liveOnly = lineage.get(qaCardId);
    expect(liveOnly?.nodes.map((n) => n.id)).not.toContain(extractId);

    // With the flag, the focused card resolves, its deleted parent appears as a
    // tombstone (deleted: true), and the card itself stays live (deleted: false).
    const data = lineage.get(qaCardId, { includeTombstones: true });
    expect(data).not.toBeNull();
    if (!data) return;
    const ids = data.nodes.map((n) => n.id);
    expect(ids).toContain(sourceId);
    expect(ids).toContain(extractId);
    expect(ids).toContain(qaCardId);
    expect(node(data, extractId)?.deleted).toBe(true);
    expect(node(data, qaCardId)?.deleted).toBe(false);
    expect(node(data, qaCardId)?.active).toBe(true);
    // Depth ordering is preserved THROUGH the tombstone: source 0 → extract 1 → card 2.
    expect(node(data, sourceId)?.depth).toBe(0);
    expect(node(data, extractId)?.depth).toBe(1);
    expect(node(data, qaCardId)?.depth).toBe(2);
  });

  it("R2: the default path is live-only — every node is deleted:false and the deleted subtree is absent", () => {
    const { sourceId, extractId, qaCardId, clozeCardId, subExtractId } = buildChain();
    repos.elements.softDelete(extractId);

    // Rooted at the still-live source, the deleted extract and everything under it
    // drop out entirely on the default path (current behavior preserved).
    const data = lineage.get(sourceId);
    expect(data).not.toBeNull();
    if (!data) return;
    const ids = data.nodes.map((n) => n.id);
    expect(ids).toContain(sourceId);
    expect(ids).not.toContain(extractId);
    expect(ids).not.toContain(subExtractId);
    expect(ids).not.toContain(qaCardId);
    expect(ids).not.toContain(clozeCardId);
    // The live-only discriminator is always false.
    expect(data.nodes.every((n) => n.deleted === false)).toBe(true);
  });

  it("two stacked deleted ancestors both render as tombstones with correct depth, resolution terminates", () => {
    const { sourceId, extractId, subExtractId } = buildChain();
    // Author a card under the sub-extract so the focus is a live leaf beneath TWO
    // deleted ancestors (the extract and the sub-extract).
    const leafCard = repos.review.createCard({
      kind: "qa",
      title: "Leaf under a doubly-deleted chain",
      priority: 0.5,
      prompt: "Q?",
      answer: "A.",
      parentId: subExtractId,
      sourceId,
      stage: "active_card",
    });
    const leafCardId = leafCard.element.id;
    repos.elements.softDelete(extractId);
    repos.elements.softDelete(subExtractId);

    const data = lineage.get(leafCardId, { includeTombstones: true });
    expect(data).not.toBeNull();
    if (!data) return;
    // Both ancestors appear as tombstones in the right order/depth.
    expect(node(data, extractId)?.deleted).toBe(true);
    expect(node(data, subExtractId)?.deleted).toBe(true);
    expect(node(data, sourceId)?.depth).toBe(0);
    expect(node(data, extractId)?.depth).toBe(1);
    expect(node(data, subExtractId)?.depth).toBe(2);
    expect(node(data, leafCardId)?.depth).toBe(3);
    expect(node(data, leafCardId)?.deleted).toBe(false);
    // No duplicates — the cycle guard kept resolution + the walk finite.
    const ids = data.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("focused node itself deleted: with the flag get returns the node (not null) as the active tombstone", () => {
    const { extractId } = buildChain();
    repos.elements.softDelete(extractId);

    // Default path still returns null for a deleted focus.
    expect(lineage.get(extractId)).toBeNull();

    // With the flag, the deleted focus resolves and is the active tombstone.
    const data = lineage.get(extractId, { includeTombstones: true });
    expect(data).not.toBeNull();
    if (!data) return;
    const focus = node(data, extractId);
    expect(focus).toBeDefined();
    expect(focus?.deleted).toBe(true);
    expect(focus?.active).toBe(true);
  });
});
