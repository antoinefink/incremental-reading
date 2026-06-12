/**
 * TrashRepository tests (T044 — the Trash read + terminal hard-delete).
 *
 * Run against a TEMPORARY, fully-migrated in-memory `better-sqlite3` DB. They pin:
 *  - `listTrash` returns ONLY `deletedAt != null` rows, newest-deleted first, with
 *    the correct `originStatus` (the status before delete) + owning-source title;
 *  - restoring a row removes it from the trash;
 *  - `purge`/`emptyTrash` HARD-delete and CASCADE (no orphan cards/review_states).
 */

import type { BlockId, ElementId, IsoTimestamp } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { cards, elements, reviewStates } from "@interleave/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardService } from "./card-service";
import { DocumentRepository } from "./document-repository";
import { ElementRepository } from "./element-repository";
import { ExtractService } from "./extract-service";
import { ExtractionService } from "./extraction-service";
import { createRepositories, type Repositories } from "./index";
import { ReviewRepository } from "./review-repository";
import { SourceRepository } from "./source-repository";
import { SynthesisService } from "./synthesis-service";
import { createInMemoryDb } from "./test-db";
import { PurgeBlockedByLiveDescendantsError, TrashRepository } from "./trash-query";
import { UndoService } from "./undo-service";

/** Rows returned by `PRAGMA foreign_key_check` (empty ⇒ no dangling FK links). */
function foreignKeyViolations(handle: DbHandle): unknown[] {
  return handle.sqlite.prepare("PRAGMA foreign_key_check").all();
}

/** A `source → extract → sub-extract → card` chain via the repositories. */
function seedChain(repos: Repositories): {
  sourceId: ElementId;
  extractId: ElementId;
  subExtractId: ElementId;
  cardId: ElementId;
  reviewDue: string;
} {
  const sourceId = repos.sources.create({ title: "On Memory", priority: 0.875, status: "active" })
    .element.id;
  const extractId = repos.sources.createExtract({
    sourceElementId: sourceId,
    title: "Extract",
    priority: 0.625,
    selectedText: "…",
    blockIds: ["blk" as BlockId],
    startOffset: 0,
    endOffset: 10,
    label: "¶1",
  }).element.id;
  const subExtractId = repos.sources.createExtract({
    sourceElementId: sourceId,
    parentId: extractId,
    title: "Sub-extract",
    priority: 0.625,
    selectedText: "…",
    blockIds: ["blk" as BlockId],
    startOffset: 0,
    endOffset: 10,
    label: "¶1",
  }).element.id;
  const reviewDue = "2026-06-15T00:00:00.000Z";
  const cardId = repos.review.createCard({
    kind: "qa",
    title: "Card",
    priority: 0.625,
    prompt: "Q?",
    answer: "A.",
    parentId: subExtractId,
    sourceId,
    stage: "active_card",
    firstScheduledAt: reviewDue as IsoTimestamp,
  }).element.id;
  return { sourceId, extractId, subExtractId, cardId, reviewDue };
}

let handle: DbHandle;

function seedSource(handle: DbHandle): ElementId {
  const sources = new SourceRepository(handle.db);
  const { element } = sources.createWithDocument({
    title: "On Memory",
    priority: 0.625,
    status: "active",
    stage: "raw_source",
    body: "Para one.\n\nThe key idea is spacing.\n\nPara three.",
  });
  return element.id;
}

function seedExtract(handle: DbHandle, sourceId: ElementId): ElementId {
  const blocks = new DocumentRepository(handle.db)
    .listBlocks(sourceId)
    .map((b) => b.stableBlockId as BlockId);
  const { element } = new ExtractionService(handle.db).createExtraction({
    sourceElementId: sourceId,
    selectedText: "The key idea is spacing.",
    blockIds: [blocks[1] as BlockId],
    startOffset: 0,
    endOffset: 24,
    priority: 0.625,
  });
  return element.id;
}

beforeEach(() => {
  handle = createInMemoryDb();
});

afterEach(() => {
  handle.sqlite.close();
});

describe("TrashRepository.listTrash", () => {
  it("returns only soft-deleted rows, newest-deleted first, with origin status + source title", () => {
    const repo = new ElementRepository(handle.db);
    const trash = new TrashRepository(handle.db);
    const sourceId = seedSource(handle);
    const extractId = seedExtract(handle, sourceId);

    // An untouched live element is NOT in the trash.
    expect(trash.listTrash()).toHaveLength(0);

    // Suspend the extract first, THEN delete it — origin status should be `suspended`.
    repo.update(extractId, { status: "suspended" });
    repo.softDelete(extractId);
    // Delete the source too (later → should sort first).
    repo.softDelete(sourceId);

    const items = trash.listTrash();
    expect(items).toHaveLength(2);
    // Both soft-deleted rows are present (ordering is by deletedAt desc; same-ms
    // ties are best-effort, so assert membership rather than exact tie order).
    expect(items.map((i) => i.element.id).sort()).toEqual([sourceId, extractId].sort());

    const extractItem = items.find((i) => i.element.id === extractId);
    expect(extractItem?.originStatus).toBe("suspended"); // prior status preserved
    expect(extractItem?.sourceTitle).toBe("On Memory"); // owning source's title

    const sourceItem = items.find((i) => i.element.id === sourceId);
    expect(sourceItem?.sourceTitle).toBe("On Memory"); // a source's own title
    expect(sourceItem?.deletedAt).toBeTruthy();
  });

  it("drops a row from the trash after it is restored", () => {
    const repo = new ElementRepository(handle.db);
    const trash = new TrashRepository(handle.db);
    const sourceId = seedSource(handle);
    repo.softDelete(sourceId);
    expect(trash.listTrash()).toHaveLength(1);

    repo.restore(sourceId, "active");
    expect(trash.listTrash()).toHaveLength(0);
  });

  it("T135/U8: surfaces the delete batchId so the Trash view can group a branch (null for a single delete)", () => {
    const repo = new ElementRepository(handle.db);
    const trash = new TrashRepository(handle.db);
    const sourceId = seedSource(handle);
    const branchRoot = seedExtract(handle, sourceId);

    // A branch delete: every soft-deleted node shares ONE batchId.
    const { batchId } = new ExtractService(handle.db).deleteSubtree(branchRoot, {
      includeSubtree: true,
    });
    const branchRows = trash.listTrash();
    expect(branchRows.length).toBeGreaterThanOrEqual(1);
    for (const r of branchRows) {
      expect(r.deleteBatchId).toBe(batchId);
    }

    // A plain single-row soft-delete (no subtree) carries its own batchId, distinct from
    // the branch (so the two never group together); a legacy `softDelete` path carries one too.
    const lone = seedExtract(handle, sourceId);
    repo.softDelete(lone);
    const loneRow = trash.listTrash().find((r) => r.element.id === lone);
    expect(loneRow?.deleteBatchId === batchId).toBe(false);
  });
});

describe("TrashRepository.purge / emptyTrash", () => {
  it("hard-deletes one element and CASCADES its card + review_states (no orphans)", () => {
    const repo = new ElementRepository(handle.db);
    const trash = new TrashRepository(handle.db);
    const sourceId = seedSource(handle);
    const extractId = seedExtract(handle, sourceId);
    const cardService = new CardService(handle.db);
    const created = cardService.createFromExtract({
      extractId,
      kind: "qa",
      prompt: "What is the key idea?",
      answer: "Spacing.",
    });
    const cardId = created.element.id;
    // The card has a review_states row (created un-due by CardService).
    expect(
      handle.db.select().from(reviewStates).where(eq(reviewStates.elementId, cardId)).all(),
    ).toHaveLength(1);

    repo.softDelete(cardId);
    expect(trash.listTrash().map((i) => i.element.id)).toContain(cardId);

    const purged = trash.purge(cardId);
    expect(purged).toBe(true);

    // The element row, its cards row, and its review_states row are all gone.
    expect(handle.db.select().from(elements).where(eq(elements.id, cardId)).all()).toHaveLength(0);
    expect(handle.db.select().from(cards).where(eq(cards.elementId, cardId)).all()).toHaveLength(0);
    expect(
      handle.db.select().from(reviewStates).where(eq(reviewStates.elementId, cardId)).all(),
    ).toHaveLength(0);
    // It is no longer in the trash.
    expect(trash.listTrash().map((i) => i.element.id)).not.toContain(cardId);
  });

  it("purge returns false for an unknown id", () => {
    const trash = new TrashRepository(handle.db);
    expect(trash.purge("nope_does_not_exist" as ElementId)).toBe(false);
  });

  it("emptyTrash hard-deletes every trashed element and returns the count", () => {
    const repo = new ElementRepository(handle.db);
    const trash = new TrashRepository(handle.db);
    const sourceId = seedSource(handle);
    const extractId = seedExtract(handle, sourceId);
    repo.softDelete(extractId);
    repo.softDelete(sourceId);
    expect(trash.listTrash()).toHaveLength(2);

    const { purged } = trash.emptyTrash();
    expect(purged).toBe(2);
    expect(trash.listTrash()).toHaveLength(0);
    // The rows are truly gone (hard delete).
    expect(handle.db.select().from(elements).all()).toHaveLength(0);
  });
});

describe("TrashRepository.restoreBatch / restoreOne (T135/U5)", () => {
  let repos: Repositories;
  beforeEach(() => {
    repos = createRepositories(handle.db);
  });

  it("R10/R11: branch restore returns every node to prior status + restores the card's review_states.due_at", () => {
    const { extractId, subExtractId, cardId, reviewDue } = seedChain(repos);
    const trash = repos.trash;
    const review = new ReviewRepository(handle.db);
    const extractStatusBefore = repos.elements.findById(extractId)?.status;
    const cardStatusBefore = repos.elements.findById(cardId)?.status;

    const { batchId } = new ExtractService(handle.db).deleteSubtree(extractId, {
      includeSubtree: true,
    });
    expect(review.findReviewState(cardId)?.dueAt).toBeNull();

    const result = trash.restoreBatch(batchId);
    expect(result.rootRestored).toBe(true);
    expect(result.restored).toEqual([extractId, subExtractId, cardId]); // root-first
    expect(result.skipped).toHaveLength(0);

    // Every node live again at its EXACT prior status.
    expect(repos.elements.findById(extractId)?.status).toBe(extractStatusBefore);
    expect(repos.elements.findById(subExtractId)?.deletedAt).toBeNull();
    expect(repos.elements.findById(cardId)?.status).toBe(cardStatusBefore);
    // The card's FSRS due is re-established EXACTLY (back in the due queue).
    expect(review.findReviewState(cardId)?.dueAt).toBe(reviewDue);
    expect(foreignKeyViolations(handle)).toHaveLength(0);
  });

  it("root-skip: a root with newer intent is skipped and its descendants are NOT silently restored", () => {
    const { extractId, subExtractId, cardId } = seedChain(repos);
    const trash = repos.trash;

    const { batchId } = new ExtractService(handle.db).deleteSubtree(extractId, {
      includeSubtree: true,
    });
    // Newer manual intent on the ROOT: re-delete it under a DIFFERENT batch.
    handle.db.transaction((tx) =>
      repos.elements.softDeleteWithin(tx, extractId, { batchId: "newer-batch" }),
    );

    const result = trash.restoreBatch(batchId);
    // The root is skipped (newer intent) → the WHOLE branch stays down (no orphan).
    expect(result.rootRestored).toBe(false);
    expect(result.restored).toHaveLength(0);
    const reasons = new Map(result.skipped.map((s) => [s.id, s.reason]));
    expect(reasons.get(extractId)).toBe("newer-intent");
    expect(reasons.get(subExtractId)).toBe("ancestor-skipped");
    expect(reasons.get(cardId)).toBe("ancestor-skipped");
    // Nothing was restored.
    for (const id of [extractId, subExtractId, cardId]) {
      expect(repos.elements.findById(id)?.deletedAt).toBeTruthy();
    }
  });

  it("R11: restoreOne re-establishes a single tombstone's schedule (no past-due phantom)", () => {
    const { cardId, reviewDue } = seedChain(repos);
    const trash = repos.trash;
    const review = new ReviewRepository(handle.db);
    const cardStatusBefore = repos.elements.findById(cardId)?.status;

    // Single-node lineage delete of the card clears both due stores.
    new ExtractService(handle.db).deleteSubtree(cardId, { includeSubtree: false });
    expect(review.findReviewState(cardId)?.dueAt).toBeNull();

    const restored = trash.restoreOne(cardId);
    expect(restored?.status).toBe(cardStatusBefore);
    expect(restored?.deletedAt).toBeNull();
    // The FSRS due is re-established from the preimage (not left cleared).
    expect(review.findReviewState(cardId)?.dueAt).toBe(reviewDue);
    expect(foreignKeyViolations(handle)).toHaveLength(0);
  });

  it("restoreOne returns null for an id that is not in the trash", () => {
    const { cardId } = seedChain(repos);
    expect(repos.trash.restoreOne(cardId)).toBeNull(); // live, not trashed
    expect(repos.trash.restoreOne("nope" as ElementId)).toBeNull();
  });
});

describe("TrashRepository purge guard (T135/U5, KTD9)", () => {
  let repos: Repositories;
  beforeEach(() => {
    repos = createRepositories(handle.db);
  });

  it("R12: purge of a tombstone anchoring a LIVE descendant throws the guard error and nulls nothing", () => {
    const { extractId, subExtractId, cardId } = seedChain(repos);
    const trash = repos.trash;

    // Keep-descendants: tombstone the extract; sub-extract + card stay LIVE under it.
    new ExtractService(handle.db).deleteSubtree(extractId, { includeSubtree: false });
    expect(repos.elements.findById(subExtractId)?.deletedAt).toBeNull();

    // Purging the tombstone would null the live sub-extract's parent_id — BLOCKED.
    expect(() => trash.purge(extractId)).toThrow(PurgeBlockedByLiveDescendantsError);

    // The tombstone is still present and NOTHING was nulled (lineage intact).
    expect(repos.elements.findById(extractId)?.deletedAt).toBeTruthy();
    expect(repos.elements.findById(subExtractId)?.parentId).toBe(extractId);
    expect(repos.elements.findById(cardId)?.parentId).toBe(subExtractId);
    expect(foreignKeyViolations(handle)).toHaveLength(0);
  });

  it("R12: also blocks purge of a source whose live cards link by sourceId only", () => {
    const { sourceId, cardId } = seedChain(repos);
    const trash = repos.trash;
    // Tombstone the source while its descendants stay live (keep-descendants).
    new ExtractService(handle.db).deleteSubtree(sourceId, { includeSubtree: false });

    expect(() => trash.purge(sourceId)).toThrow(PurgeBlockedByLiveDescendantsError);
    // The live card's sourceId is NOT nulled.
    expect(repos.elements.findById(cardId)?.sourceId).toBe(sourceId);
    expect(foreignKeyViolations(handle)).toHaveLength(0);
  });

  it("purge of a tombstone with NO live descendants still succeeds", () => {
    const { extractId, subExtractId, cardId } = seedChain(repos);
    const trash = repos.trash;
    // Delete the WHOLE branch (everything tombstoned) — the extract has no LIVE
    // descendants now, so purging it is safe.
    new ExtractService(handle.db).deleteSubtree(extractId, { includeSubtree: true });

    // Purge leaf-up so each node has no live (or any) descendants when purged.
    expect(trash.purge(cardId)).toBe(true);
    expect(trash.purge(subExtractId)).toBe(true);
    expect(trash.purge(extractId)).toBe(true);
    expect(repos.elements.findById(extractId)).toBeNull();
    expect(foreignKeyViolations(handle)).toHaveLength(0);
  });

  it("R12: emptyTrash purges safe rows, SKIPS the live-anchoring tombstone, and reports the count", () => {
    const { extractId, subExtractId } = seedChain(repos);
    const trash = repos.trash;

    // Tombstone the extract (keep-descendants) → it anchors the live sub-extract+card.
    new ExtractService(handle.db).deleteSubtree(extractId, { includeSubtree: false });
    // Also trash an UNRELATED, safe row (no live descendants).
    const orphanId = repos.sources.create({ title: "Orphan", priority: 0.5, status: "active" })
      .element.id;
    repos.elements.softDelete(orphanId);

    const { purged, skipped } = trash.emptyTrash();
    // The orphan was purged; the anchoring tombstone was skipped + reported.
    expect(purged).toBe(1);
    expect(skipped).toBe(1);
    expect(repos.elements.findById(orphanId)).toBeNull();
    expect(repos.elements.findById(extractId)?.deletedAt).toBeTruthy();
    // The live descendants survived with their lineage intact.
    expect(repos.elements.findById(subExtractId)?.parentId).toBe(extractId);
    expect(foreignKeyViolations(handle)).toHaveLength(0);
  });
});

/**
 * A BRANCHING tree under one extract root: `extract → [subA → cardA], [subB → cardB]`,
 * so a NON-root intermediate (`subA`) can carry newer intent independently of `subB`.
 */
function seedBranchingTree(repos: Repositories): {
  rootId: ElementId;
  subAId: ElementId;
  cardAId: ElementId;
  subBId: ElementId;
  cardBId: ElementId;
} {
  const sourceId = repos.sources.create({ title: "Tree source", priority: 0.875, status: "active" })
    .element.id;
  const rootId = repos.sources.createExtract({
    sourceElementId: sourceId,
    title: "Root extract",
    priority: 0.625,
    selectedText: "…",
    blockIds: ["blk" as BlockId],
    startOffset: 0,
    endOffset: 10,
    label: "¶1",
  }).element.id;
  const makeSub = (label: string): ElementId =>
    repos.sources.createExtract({
      sourceElementId: sourceId,
      parentId: rootId,
      title: `Sub ${label}`,
      priority: 0.625,
      selectedText: "…",
      blockIds: ["blk" as BlockId],
      startOffset: 0,
      endOffset: 10,
      label,
    }).element.id;
  const makeCard = (parentId: ElementId, label: string): ElementId =>
    repos.review.createCard({
      kind: "qa",
      title: `Card ${label}`,
      priority: 0.625,
      prompt: "Q?",
      answer: "A.",
      parentId,
      sourceId,
      stage: "active_card",
      firstScheduledAt: "2026-06-15T00:00:00.000Z" as IsoTimestamp,
    }).element.id;
  const subAId = makeSub("A");
  const cardAId = makeCard(subAId, "A");
  const subBId = makeSub("B");
  const cardBId = makeCard(subBId, "B");
  return { rootId, subAId, cardAId, subBId, cardBId };
}

describe("TrashRepository.restoreBatch intermediate-skip + atomic undo (T135/A1)", () => {
  let repos: Repositories;
  beforeEach(() => {
    repos = createRepositories(handle.db);
  });

  it("a NON-root intermediate with newer intent keeps ITS subtree tombstoned while a sibling subtree restores", () => {
    const { rootId, subAId, cardAId, subBId, cardBId } = seedBranchingTree(repos);
    const trash = repos.trash;

    const { batchId } = new ExtractService(handle.db).deleteSubtree(rootId, {
      includeSubtree: true,
    });
    // Newer manual intent on the INTERMEDIATE `subA` (not the root): re-delete under a
    // different batch. This is the case the old binary `rootSkipped` flag mishandled —
    // cardA must NOT be restored under the still-tombstoned subA.
    handle.db.transaction((tx) =>
      repos.elements.softDeleteWithin(tx, subAId, { batchId: "newer-subA" }),
    );

    const result = trash.restoreBatch(batchId);
    const reasons = new Map(result.skipped.map((s) => [s.id, s.reason]));
    // The root and the still-valid sibling subtree restore.
    expect(result.rootRestored).toBe(true);
    expect(result.restored).toEqual(expect.arrayContaining([rootId, subBId, cardBId]));
    expect(repos.elements.findById(subBId)?.deletedAt).toBeNull();
    expect(repos.elements.findById(cardBId)?.deletedAt).toBeNull();
    // The skipped intermediate AND its descendant stay tombstoned (no orphan under a tombstone).
    expect(reasons.get(subAId)).toBe("newer-intent");
    expect(reasons.get(cardAId)).toBe("ancestor-skipped");
    expect(result.restored).not.toContain(cardAId);
    expect(repos.elements.findById(subAId)?.deletedAt).toBeTruthy();
    expect(repos.elements.findById(cardAId)?.deletedAt).toBeTruthy();
    expect(foreignKeyViolations(handle)).toHaveLength(0);
  });

  it("atomic undo: undoLast after restoreBatch re-trashes EVERY restored node as one unit", () => {
    const { extractId, subExtractId, cardId } = seedChain(repos);
    const trash = repos.trash;
    const undo = new UndoService(handle.db);

    const { batchId } = new ExtractService(handle.db).deleteSubtree(extractId, {
      includeSubtree: true,
    });
    const result = trash.restoreBatch(batchId);
    expect(result.restored).toHaveLength(3);
    expect(result.batchId).not.toBeNull();
    // All three are live after the restore.
    for (const id of [extractId, subExtractId, cardId]) {
      expect(repos.elements.findById(id)?.deletedAt).toBeNull();
    }

    // ONE undo reverses the WHOLE restore (grouped by the fresh restore batchId), not just
    // the most-recently-restored single node.
    const undone = undo.undoLast();
    expect(undone.undone).toBe(true);
    expect(undone.count).toBe(3);
    for (const id of [extractId, subExtractId, cardId]) {
      expect(repos.elements.findById(id)?.deletedAt).toBeTruthy();
    }
    expect(foreignKeyViolations(handle)).toHaveLength(0);
  });

  it("double-restore: restoring an already-restored batch skips every node with not-deleted", () => {
    const { extractId, subExtractId, cardId } = seedChain(repos);
    const trash = repos.trash;

    const { batchId } = new ExtractService(handle.db).deleteSubtree(extractId, {
      includeSubtree: true,
    });
    trash.restoreBatch(batchId); // first restore brings them all back

    const again = trash.restoreBatch(batchId);
    expect(again.restored).toHaveLength(0);
    expect(again.batchId).toBeNull();
    const reasons = new Map(again.skipped.map((s) => [s.id, s.reason]));
    // The root is already live → `not-deleted`; its descendants follow as `ancestor-skipped`.
    expect(reasons.get(extractId)).toBe("not-deleted");
    expect(reasons.get(subExtractId)).toBe("ancestor-skipped");
    expect(reasons.get(cardId)).toBe("ancestor-skipped");
  });

  it("a PURGED root surfaces as missing and its descendants as ancestor-skipped (no orphan restore)", () => {
    const { extractId, subExtractId, cardId } = seedChain(repos);
    const trash = repos.trash;

    const { batchId } = new ExtractService(handle.db).deleteSubtree(extractId, {
      includeSubtree: true,
    });
    // Hard-purge the (now leafless-from-its-own-POV) root row directly. Its descendants
    // are tombstones, so the live-descendant guard does not block this purge.
    expect(trash.purge(extractId)).toBe(true);
    expect(repos.elements.findById(extractId)).toBeNull();

    const result = trash.restoreBatch(batchId);
    expect(result.rootRestored).toBe(false);
    expect(result.restored).toHaveLength(0);
    const reasons = new Map(result.skipped.map((s) => [s.id, s.reason]));
    expect(reasons.get(extractId)).toBe("missing");
    expect(reasons.get(subExtractId)).toBe("ancestor-skipped");
    expect(reasons.get(cardId)).toBe("ancestor-skipped");
  });
});

describe("TrashRepository.restoreAncestorChain (T135/A2)", () => {
  let repos: Repositories;
  beforeEach(() => {
    repos = createRepositories(handle.db);
  });

  it("restores ONLY the focused element's deleted chain to a live root, leaving sibling tombstones deleted", () => {
    const { rootId, subAId, cardAId, subBId } = seedBranchingTree(repos);
    const trash = repos.trash;

    // Tombstone the root (keep-descendants), then tombstone subA (the focused card's
    // branch). subB is a SIBLING tombstone that must NOT be resurrected.
    new ExtractService(handle.db).deleteSubtree(rootId, { includeSubtree: false });
    new ExtractService(handle.db).deleteSubtree(subAId, { includeSubtree: false });
    new ExtractService(handle.db).deleteSubtree(subBId, { includeSubtree: false });
    // cardA stays live under the (now tombstoned) subA → tombstoned root chain.
    expect(repos.elements.findById(cardAId)?.deletedAt).toBeNull();

    const result = trash.restoreAncestorChain(cardAId);
    // cardA is live, so the chain is its ancestors: subA then root (root-first order).
    expect(result.restored).toEqual([rootId, subAId]);
    expect(result.batchId).not.toBeNull();
    expect(repos.elements.findById(rootId)?.deletedAt).toBeNull();
    expect(repos.elements.findById(subAId)?.deletedAt).toBeNull();
    // The sibling tombstone is UNTOUCHED — never resurrected by an ancestor restore.
    expect(repos.elements.findById(subBId)?.deletedAt).toBeTruthy();
    // No node left under a tombstone parent (FK + lineage intact).
    expect(foreignKeyViolations(handle)).toHaveLength(0);
  });

  it("restoring a focused TOMBSTONE includes the node itself and stops at the first live ancestor", () => {
    const { rootId, subAId, cardAId } = seedBranchingTree(repos);
    const trash = repos.trash;

    // Root stays LIVE; tombstone subA + cardA (a branch delete of subA).
    new ExtractService(handle.db).deleteSubtree(subAId, { includeSubtree: true });
    expect(repos.elements.findById(rootId)?.deletedAt).toBeNull();

    // Focused node is the tombstoned cardA: restore cardA + subA, stop at the live root.
    const result = trash.restoreAncestorChain(cardAId);
    expect(result.restored).toEqual([subAId, cardAId]); // root-first, root excluded (live)
    expect(repos.elements.findById(cardAId)?.deletedAt).toBeNull();
    expect(repos.elements.findById(subAId)?.deletedAt).toBeNull();
    expect(foreignKeyViolations(handle)).toHaveLength(0);
  });

  it("restores nothing when the focused element and its ancestors are all live", () => {
    const { cardAId } = seedBranchingTree(repos);
    const result = repos.trash.restoreAncestorChain(cardAId);
    expect(result.restored).toHaveLength(0);
    expect(result.batchId).toBeNull();
  });
});

describe("soft-delete preimage edge cases + synthesis fate restore (T135/A)", () => {
  let repos: Repositories;
  beforeEach(() => {
    repos = createRepositories(handle.db);
  });

  it("clearSchedule on a CARD with NO review_states row omits prevReviewDueAt and restores faithfully", () => {
    const sourceId = repos.sources.create({ title: "S", priority: 0.5, status: "active" }).element
      .id;
    // A bare `card` ELEMENT with NO FSRS state row (created directly, not via createCard) —
    // the exact case `softDeleteWithin` guards: it must NOT write a phantom `prevReviewDueAt`.
    const cardId = repos.elements.create({
      type: "card",
      status: "active",
      stage: "active_card",
      priority: 0.5,
      title: "Card without FSRS state",
      dueAt: "2026-07-01T00:00:00.000Z" as IsoTimestamp,
      sourceId,
    }).id;
    expect(new ReviewRepository(handle.db).findReviewState(cardId)).toBeNull();

    handle.db.transaction((tx) =>
      repos.elements.softDeleteSubtreeWithin(tx, cardId, {
        batchId: "no-fsrs",
        includeSubtree: false,
      }),
    );
    expect(repos.elements.findById(cardId)?.deletedAt).toBeTruthy();
    // The op payload records no `prevReviewDueAt` (no phantom preimage for a card with no
    // FSRS state), but DOES record `prevDueAt` (clearSchedule always clears the element due).
    const payload = latestSoftDeletePayload(handle, cardId);
    expect(Object.hasOwn(payload, "prevReviewDueAt")).toBe(false);
    expect(Object.hasOwn(payload, "prevDueAt")).toBe(true);
    expect(payload.prevDueAt).toBe("2026-07-01T00:00:00.000Z");

    // Restore is faithful: the card comes back, its element due is re-established, and it
    // still has no review_states row.
    const restored = repos.trash.restoreOne(cardId);
    expect(restored?.deletedAt).toBeNull();
    expect(restored?.dueAt).toBe("2026-07-01T00:00:00.000Z");
    expect(new ReviewRepository(handle.db).findReviewState(cardId)).toBeNull();
  });

  it("restoring a branch-deleted synthesis_note re-establishes the synthesized fate on its live target", () => {
    const { extractId } = (() => {
      const sourceId = repos.sources.create({ title: "Syn src", priority: 0.5, status: "active" })
        .element.id;
      const exId = repos.sources.createExtract({
        sourceElementId: sourceId,
        title: "Target extract",
        priority: 0.625,
        selectedText: "…",
        blockIds: ["blk" as BlockId],
        startOffset: 0,
        endOffset: 10,
        label: "¶1",
      }).element.id;
      return { extractId: exId };
    })();
    const synthesis = new SynthesisService(handle.db);
    const noteId = synthesis.create({ title: "Note" }).element.id;
    synthesis.linkElement(noteId, extractId);
    expect(repos.elements.findById(extractId)?.extractFate).toBe("synthesized");

    // Branch-delete the NOTE → its target's cached `synthesized` fate is cleared (the
    // target stays live and is rescheduled).
    const { batchId } = new ExtractService(handle.db).deleteSubtree(noteId, {
      includeSubtree: true,
    });
    expect(repos.elements.findById(extractId)?.extractFate).toBeNull();

    // Restoring the note re-establishes the `synthesized` fate on the live target.
    repos.trash.restoreBatch(batchId);
    expect(repos.elements.findById(noteId)?.deletedAt).toBeNull();
    expect(repos.elements.findById(extractId)?.extractFate).toBe("synthesized");
    expect(foreignKeyViolations(handle)).toHaveLength(0);
  });
});

/** The latest `soft_delete_element` op payload for an element (parsed). */
function latestSoftDeletePayload(handle: DbHandle, id: ElementId): Record<string, unknown> {
  const row = handle.sqlite
    .prepare(
      "SELECT payload FROM operation_log WHERE element_id = ? AND op_type = 'soft_delete_element' ORDER BY created_at DESC, rowid DESC LIMIT 1",
    )
    .get(id) as { payload: string } | undefined;
  return row ? (JSON.parse(row.payload) as Record<string, unknown>) : {};
}
