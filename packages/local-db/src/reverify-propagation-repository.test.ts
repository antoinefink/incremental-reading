/**
 * T123 — stale propagation through the lineage DAG.
 *
 * Drives the real entry point (`BlockProcessingService.reconcileSourceDocumentWithin`,
 * which composes reconcile + propagate in one transaction) so these tests prove the
 * U3 transition reporting and U4 propagation together: an edited source block flags
 * its live derived extract + card, restoring the block clears them, soft-deleted
 * lineage is excluded, re-runs are idempotent, the flag self-heals from provenance,
 * and the op-log marks the flips non-invertible by the global undo.
 */

import type { BlockId, ElementId } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import {
  documents,
  elementReverifyProvenance,
  elements,
  operationLog,
  sourceBlockProcessing,
  sourceLocations,
} from "@interleave/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BlockProcessingService } from "./block-processing-service";
import { CardService } from "./card-service";
import { DocumentRepository } from "./document-repository";
import { ElementRepository } from "./element-repository";
import { ExtractionService } from "./extraction-service";
import { SourceRepository } from "./source-repository";
import { createInMemoryDb } from "./test-db";

let handle: DbHandle;

beforeEach(() => {
  handle = createInMemoryDb();
});

afterEach(() => {
  handle.sqlite.close();
});

interface Lineage {
  readonly sourceId: ElementId;
  readonly extractId: ElementId;
  readonly cardId: ElementId;
  readonly blocks: BlockId[];
  readonly extractedBlock: BlockId;
}

/** Seed source → extract (anchored to block[1]) → card (parentId = extract). */
function seedLineage(): Lineage {
  const { element: source } = new SourceRepository(handle.db).createWithDocument({
    title: "A long article",
    priority: 0.875,
    status: "active",
    stage: "raw_source",
    body: "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.",
  });
  const sourceId = source.id;
  const blocks = new DocumentRepository(handle.db)
    .listBlocks(sourceId)
    .map((b) => b.stableBlockId as BlockId);
  const extractedBlock = blocks[1] as BlockId;

  const { element: extract } = new ExtractionService(handle.db).createExtraction({
    sourceElementId: sourceId,
    selectedText: "Second paragraph.",
    blockIds: [extractedBlock],
    startOffset: 0,
    endOffset: 17,
    priority: 0.875,
  });
  const { element: card } = new CardService(handle.db).createFromExtract({
    extractId: extract.id,
    kind: "qa",
    prompt: "What is in the second paragraph?",
    answer: "Second paragraph.",
  });

  return { sourceId, extractId: extract.id, cardId: card.id, blocks, extractedBlock };
}

function storedDoc(sourceId: ElementId): unknown {
  const row = handle.db
    .select({ json: documents.prosemirrorJson })
    .from(documents)
    .where(eq(documents.elementId, sourceId))
    .get();
  if (!row) throw new Error("no document");
  return JSON.parse(row.json);
}

/** A deep-cloned copy of the document with one block's text replaced. */
function editBlockText(doc: unknown, blockId: BlockId, newText: string): unknown {
  const clone = JSON.parse(JSON.stringify(doc)) as { content?: unknown[] };
  const visit = (node: { attrs?: { blockId?: unknown }; content?: unknown[] }): void => {
    if (node?.attrs?.blockId === blockId) {
      node.content = [{ type: "text", text: newText }];
      return;
    }
    for (const child of node?.content ?? []) visit(child as never);
  };
  visit(clone as never);
  return clone;
}

function reconcile(service: BlockProcessingService, sourceId: ElementId, doc: unknown): void {
  handle.db.transaction((tx) => {
    service.reconcileSourceDocumentWithin(tx, sourceId, doc);
  });
}

function needsReverify(id: ElementId): boolean {
  const row = handle.db
    .select({ needsReverify: elements.needsReverify, staleSince: elements.staleSince })
    .from(elements)
    .where(eq(elements.id, id))
    .get();
  return row?.needsReverify === true;
}

function staleSince(id: ElementId): string | null {
  return (
    handle.db
      .select({ staleSince: elements.staleSince })
      .from(elements)
      .where(eq(elements.id, id))
      .get()?.staleSince ?? null
  );
}

function provenanceCount(elementId: ElementId): number {
  return handle.db
    .select()
    .from(elementReverifyProvenance)
    .where(eq(elementReverifyProvenance.elementId, elementId))
    .all().length;
}

describe("ReverifyPropagation — stale propagation through the lineage DAG", () => {
  it("flags the anchored extract and its descendant card when a block is edited", () => {
    const { sourceId, extractId, cardId, extractedBlock } = seedLineage();
    const service = new BlockProcessingService(handle.db);
    const original = storedDoc(sourceId);

    reconcile(service, sourceId, editBlockText(original, extractedBlock, "Heavily rewritten."));

    expect(needsReverify(extractId)).toBe(true);
    expect(needsReverify(cardId)).toBe(true);
    expect(staleSince(extractId)).not.toBeNull();
    expect(provenanceCount(extractId)).toBe(1);
    expect(provenanceCount(cardId)).toBe(1);

    // One batchId shared by every flag flip (audit + T124 group-undo).
    const flips = handle.db
      .select()
      .from(operationLog)
      .where(eq(operationLog.opType, "update_element"))
      .all()
      .map((op) => JSON.parse(op.payload) as { propagation?: boolean; batchId?: string })
      .filter((p) => p.propagation === true);
    expect(flips.length).toBe(2);
    expect(new Set(flips.map((p) => p.batchId)).size).toBe(1);
  });

  it("does not flag soft-deleted descendants (R5)", () => {
    const { sourceId, extractId, cardId, extractedBlock } = seedLineage();
    new ElementRepository(handle.db).softDelete(cardId);
    const service = new BlockProcessingService(handle.db);

    reconcile(service, sourceId, editBlockText(storedDoc(sourceId), extractedBlock, "Rewritten."));

    expect(needsReverify(extractId)).toBe(true);
    expect(provenanceCount(cardId)).toBe(0);
  });

  it("clears the flags when the block content is restored (R4)", () => {
    const { sourceId, extractId, cardId, extractedBlock } = seedLineage();
    const service = new BlockProcessingService(handle.db);
    const original = storedDoc(sourceId);

    reconcile(service, sourceId, editBlockText(original, extractedBlock, "Rewritten."));
    expect(needsReverify(extractId)).toBe(true);

    // Restore: reconcile with the original document (block hash returns to pre-stale).
    reconcile(service, sourceId, original);

    expect(needsReverify(extractId)).toBe(false);
    expect(needsReverify(cardId)).toBe(false);
    expect(staleSince(extractId)).toBeNull();
    expect(provenanceCount(extractId)).toBe(0);
    expect(provenanceCount(cardId)).toBe(0);
  });

  it("is idempotent — re-running on the same drift adds no provenance or ops", () => {
    const { sourceId, extractId, extractedBlock } = seedLineage();
    const service = new BlockProcessingService(handle.db);
    const edited = editBlockText(storedDoc(sourceId), extractedBlock, "Rewritten.");

    reconcile(service, sourceId, edited);
    const provAfterFirst = provenanceCount(extractId);
    const opsAfterFirst = handle.db.select().from(operationLog).all().length;

    reconcile(service, sourceId, edited);
    expect(provenanceCount(extractId)).toBe(provAfterFirst);
    expect(handle.db.select().from(operationLog).all().length).toBe(opsAfterFirst);
  });

  it("self-heals the flag from provenance — recompute, not flip-on-insert (R5/F5)", async () => {
    const { sourceId, extractId, extractedBlock } = seedLineage();
    const service = new BlockProcessingService(handle.db);
    reconcile(service, sourceId, editBlockText(storedDoc(sourceId), extractedBlock, "Rewritten."));
    expect(needsReverify(extractId)).toBe(true);
    expect(provenanceCount(extractId)).toBe(1);

    // Corrupt the denormalized flag out of band (provenance row still present).
    handle.db
      .update(elements)
      .set({ needsReverify: false })
      .where(eq(elements.id, extractId))
      .run();
    expect(needsReverify(extractId)).toBe(false);

    // Re-touching the element via propagation recomputes the flag from EXISTS(provenance)
    // (the unique-triple insert is a no-op), so the projection self-corrects to true.
    const { ReverifyPropagationRepository } = await import("./reverify-propagation-repository");
    const repo = new ReverifyPropagationRepository(handle.db);
    handle.db.transaction((tx) => {
      repo.propagateReverify(
        tx,
        sourceId,
        { staled: [extractedBlock], unStaled: [] },
        "heal-batch",
      );
    });
    expect(needsReverify(extractId)).toBe(true);
    expect(provenanceCount(extractId)).toBe(1);
  });

  it("keeps the flag while one of several staling blocks remains drifted", () => {
    // Extract spanning two blocks; edit both, then restore only one.
    const { element: source } = new SourceRepository(handle.db).createWithDocument({
      title: "Two-block source",
      priority: 0.5,
      status: "active",
      stage: "raw_source",
      body: "Alpha block.\n\nBeta block.",
    });
    const sourceId = source.id;
    const blocks = new DocumentRepository(handle.db)
      .listBlocks(sourceId)
      .map((b) => b.stableBlockId as BlockId);
    const { element: extract } = new ExtractionService(handle.db).createExtraction({
      sourceElementId: sourceId,
      selectedText: "Alpha block. Beta block.",
      blockIds: [blocks[0] as BlockId, blocks[1] as BlockId],
      startOffset: 0,
      endOffset: 12,
      priority: 0.5,
    });
    const service = new BlockProcessingService(handle.db);
    const original = storedDoc(sourceId);

    // Edit both blocks → two provenance rows for the extract.
    let edited = editBlockText(original, blocks[0] as BlockId, "Alpha edited.");
    edited = editBlockText(edited, blocks[1] as BlockId, "Beta edited.");
    reconcile(service, sourceId, edited);
    expect(provenanceCount(extract.id)).toBe(2);
    expect(needsReverify(extract.id)).toBe(true);

    // Restore only block[0]: block[1] stays edited → flag remains.
    const restoreOne = editBlockText(original, blocks[1] as BlockId, "Beta edited.");
    reconcile(service, sourceId, restoreOne);
    expect(provenanceCount(extract.id)).toBe(1);
    expect(needsReverify(extract.id)).toBe(true);

    // Restore block[1] too → flag clears.
    reconcile(service, sourceId, original);
    expect(provenanceCount(extract.id)).toBe(0);
    expect(needsReverify(extract.id)).toBe(false);
  });

  it("does not cross sources — editing source X never flags source Y's outputs", () => {
    const a = seedLineage();
    const b = seedLineage();
    const service = new BlockProcessingService(handle.db);

    reconcile(
      service,
      a.sourceId,
      editBlockText(storedDoc(a.sourceId), a.extractedBlock, "Edited A."),
    );

    expect(needsReverify(a.extractId)).toBe(true);
    expect(needsReverify(b.extractId)).toBe(false);
    expect(needsReverify(b.cardId)).toBe(false);
  });

  it("flags descendants when the anchored block is deleted from the document (block_missing)", () => {
    const { sourceId, extractId, cardId } = seedLineage();
    const service = new BlockProcessingService(handle.db);

    // Reconcile against a document with the anchored block removed entirely.
    reconcile(service, sourceId, { type: "doc", content: [] });

    expect(needsReverify(extractId)).toBe(true);
    expect(needsReverify(cardId)).toBe(true);
    // The block-processing row records why it staled.
    const row = handle.db
      .select({ metadata: sourceBlockProcessing.metadata })
      .from(sourceBlockProcessing)
      .where(eq(sourceBlockProcessing.sourceElementId, sourceId))
      .get();
    expect(JSON.parse(row?.metadata ?? "{}").reason).toBe("block_missing");
  });

  it("skips propagation for an anchor whose blockIds JSON is malformed (no throw)", () => {
    const { sourceId, extractId, extractedBlock } = seedLineage();
    // Corrupt the extract's lineage anchor so its block_ids cannot be parsed.
    handle.db
      .update(sourceLocations)
      .set({ blockIds: "{not valid json" })
      .where(eq(sourceLocations.elementId, extractId))
      .run();
    const service = new BlockProcessingService(handle.db);

    expect(() =>
      reconcile(
        service,
        sourceId,
        editBlockText(storedDoc(sourceId), extractedBlock, "Rewritten."),
      ),
    ).not.toThrow();
    // The malformed anchor is silently dropped, so the extract is not flagged (the block
    // still goes stale_after_edit — only the downstream propagation is skipped).
    expect(needsReverify(extractId)).toBe(false);
    expect(provenanceCount(extractId)).toBe(0);
  });

  it("the global undo does not invert the propagation flag flips", async () => {
    const { sourceId, extractId, extractedBlock } = seedLineage();
    const service = new BlockProcessingService(handle.db);
    reconcile(service, sourceId, editBlockText(storedDoc(sourceId), extractedBlock, "Rewritten."));
    expect(needsReverify(extractId)).toBe(true);

    const { UndoService } = await import("./undo-service");
    const result = new UndoService(handle.db).undoLast();
    // The last op is a propagation flag flip — non-invertible marker → nothing undone.
    expect(result.undone).toBe(false);
    expect(needsReverify(extractId)).toBe(true);
  });

  it("counts live reverify outputs for source progress (R6) and excludes soft-deleted", () => {
    const { sourceId, extractId, cardId, extractedBlock } = seedLineage();
    const service = new BlockProcessingService(handle.db);
    reconcile(service, sourceId, editBlockText(storedDoc(sourceId), extractedBlock, "Rewritten."));

    expect(service.getSourceProcessingSummary(sourceId).needsReverifyOutputs).toBe(2);

    new ElementRepository(handle.db).softDelete(cardId);
    expect(service.getSourceProcessingSummary(sourceId).needsReverifyOutputs).toBe(1);

    expect(extractId).toBeTruthy();
  });

  it("rolls back flags atomically if the surrounding transaction fails", () => {
    const { sourceId, extractId, extractedBlock } = seedLineage();
    const service = new BlockProcessingService(handle.db);
    const edited = editBlockText(storedDoc(sourceId), extractedBlock, "Rewritten.");

    expect(() =>
      handle.db.transaction((tx) => {
        service.reconcileSourceDocumentWithin(tx, sourceId, edited);
        throw new Error("boom");
      }),
    ).toThrow("boom");

    // Whole transaction rolled back: no block left stale with descendants clean.
    expect(needsReverify(extractId)).toBe(false);
    expect(provenanceCount(extractId)).toBe(0);
  });
});
