/**
 * TrashRepository tests (T044 — the Trash read + terminal hard-delete).
 *
 * Run against a TEMPORARY, fully-migrated in-memory `better-sqlite3` DB. They pin:
 *  - `listTrash` returns ONLY `deletedAt != null` rows, newest-deleted first, with
 *    the correct `originStatus` (the status before delete) + owning-source title;
 *  - restoring a row removes it from the trash;
 *  - `purge`/`emptyTrash` HARD-delete and CASCADE (no orphan cards/review_states).
 */

import type { BlockId, ElementId } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { cards, elements, reviewStates } from "@interleave/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardService } from "./card-service";
import { DocumentRepository } from "./document-repository";
import { ElementRepository } from "./element-repository";
import { ExtractionService } from "./extraction-service";
import { SourceRepository } from "./source-repository";
import { createInMemoryDb } from "./test-db";
import { TrashRepository } from "./trash-query";

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
