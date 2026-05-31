/**
 * QueueActionService tests (T030 — the in-place queue ACT seam).
 *
 * These run against a TEMPORARY, fully-migrated in-memory `better-sqlite3` DB so
 * behaviour matches production exactly. They pin the per-action contract:
 *
 *  - each `kind` produces the expected status / priority / `due_at` change AND
 *    appends EXACTLY the expected EXISTING op (no new op types);
 *  - delete is SOFT (`deletedAt` set, the row still present) and `undo` restores it;
 *  - done/dismiss set the status and `undo` re-sets the PRIOR status;
 *  - the FSRS-ISOLATION assertion: postponing a CARD defers its `review_states.due_at`
 *    (FSRS) WITHOUT touching the attention scheduler, while postponing an EXTRACT
 *    reschedules `elements.due_at` (attention) and creates NO `review_states` row —
 *    the two-scheduler split holds and is never crossed.
 */

import type { BlockId, ElementId, IsoTimestamp, Priority } from "@interleave/core";
import { priorityToLabel } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { operationLog, reviewStates } from "@interleave/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DocumentRepository } from "./document-repository";
import { ElementRepository } from "./element-repository";
import { ExtractionService } from "./extraction-service";
import { createRepositories } from "./index";
import { CARD_DEFER_DAYS, QueueActionService } from "./queue-action-service";
import { QueueQuery } from "./queue-query";
import { ReviewRepository } from "./review-repository";
import { SourceRepository } from "./source-repository";
import { createInMemoryDb } from "./test-db";

let handle: DbHandle;

function seedSource(handle: DbHandle, priority: Priority = 0.625): ElementId {
  const sources = new SourceRepository(handle.db);
  const { element } = sources.createWithDocument({
    title: "On the Measure of Intelligence",
    priority,
    status: "active",
    stage: "raw_source",
    body: "Intro paragraph one.\n\nThe definition paragraph two.\n\nA third paragraph.",
  });
  return element.id;
}

function seedExtract(handle: DbHandle, priority: Priority = 0.625): ElementId {
  const sourceId = seedSource(handle, priority);
  const blocks = new DocumentRepository(handle.db)
    .listBlocks(sourceId)
    .map((b) => b.stableBlockId as BlockId);
  const extraction = new ExtractionService(handle.db);
  const { element } = extraction.createExtraction({
    sourceElementId: sourceId,
    selectedText: "The definition paragraph two.",
    blockIds: [blocks[1] as BlockId],
    startOffset: 0,
    endOffset: 29,
    priority,
  });
  return element.id;
}

/** Seed a Q&A card (with an FSRS review_states row) that is already due. */
function seedCard(handle: DbHandle, priority: Priority = 0.625): ElementId {
  const review = new ReviewRepository(handle.db);
  const { element } = review.createCard({
    kind: "qa",
    title: "Q: define intelligence",
    priority,
    prompt: "Define intelligence",
    answer: "Skill-acquisition efficiency",
  });
  // Make it due so it reads as a queue card.
  handle.db
    .update(reviewStates)
    .set({ dueAt: "2020-01-01T00:00:00.000Z" })
    .where(eq(reviewStates.elementId, element.id))
    .run();
  return element.id;
}

/** Count ops of a given type for an element. */
function opCount(handle: DbHandle, id: ElementId, opType: string): number {
  return handle.db
    .select()
    .from(operationLog)
    .where(eq(operationLog.elementId, id))
    .all()
    .filter((op) => op.opType === opType).length;
}

beforeEach(() => {
  handle = createInMemoryDb();
});

afterEach(() => {
  handle.sqlite.close();
});

describe("QueueActionService.act", () => {
  it("raise / lower steps the priority band and logs exactly one update_element each", () => {
    const id = seedExtract(handle, 0.375); // band C
    const service = new QueueActionService(handle.db);
    const elements = new ElementRepository(handle.db);

    const before = opCount(handle, id, "update_element");
    const raised = service.act(id, "raise");
    expect(priorityToLabel(raised.element.priority)).toBe("B");
    expect(raised.removed).toBe(false);
    expect(raised.undo).toBeNull();
    expect(opCount(handle, id, "update_element")).toBe(before + 1);

    const lowered = service.act(id, "lower");
    expect(priorityToLabel(lowered.element.priority)).toBe("C");
    expect(opCount(handle, id, "update_element")).toBe(before + 2);
    // Persisted on the row.
    expect(priorityToLabel(elements.findById(id)?.priority ?? 0)).toBe("C");
  });

  it("markDone sets status done (update_element) and undo re-sets the prior status", () => {
    const id = seedExtract(handle);
    const service = new QueueActionService(handle.db);
    const elements = new ElementRepository(handle.db);
    const prior = elements.findById(id)?.status;

    const res = service.act(id, "markDone");
    expect(res.element.status).toBe("done");
    expect(res.removed).toBe(true);
    expect(res.undo).toEqual({ kind: "status", previousStatus: prior });
    expect(elements.findById(id)?.status).toBe("done");

    // Undo restores the prior status via update_element.
    if (res.undo) service.undo(id, res.undo);
    expect(elements.findById(id)?.status).toBe(prior);
  });

  it("dismiss sets status dismissed (update_element)", () => {
    const id = seedExtract(handle);
    const service = new QueueActionService(handle.db);
    const res = service.act(id, "dismiss");
    expect(res.element.status).toBe("dismissed");
    expect(res.removed).toBe(true);
    expect(res.undo?.kind).toBe("status");
  });

  it("delete is SOFT (deletedAt set, row still present) and undo restores it", () => {
    const id = seedExtract(handle);
    const service = new QueueActionService(handle.db);
    const elements = new ElementRepository(handle.db);
    const prior = elements.findById(id)?.status;

    const before = opCount(handle, id, "soft_delete_element");
    const res = service.act(id, "delete");
    expect(res.removed).toBe(true);
    expect(res.undo).toEqual({ kind: "restore", previousStatus: prior });
    expect(opCount(handle, id, "soft_delete_element")).toBe(before + 1);

    // The row is NOT hard-deleted — it is still there with deletedAt set.
    const deleted = elements.findById(id);
    expect(deleted).not.toBeNull();
    expect(deleted?.deletedAt).toBeTruthy();
    expect(deleted?.status).toBe("deleted");

    // Undo restores it (restore_element) to its prior status, clearing deletedAt.
    if (res.undo) service.undo(id, res.undo);
    const restored = elements.findById(id);
    expect(restored?.deletedAt).toBeNull();
    expect(restored?.status).toBe(prior);
    expect(opCount(handle, id, "restore_element")).toBe(1);
  });

  it("postponing an EXTRACT reschedules elements.due_at (attention) — exactly one reschedule_element op", () => {
    const id = seedExtract(handle);
    const service = new QueueActionService(handle.db);
    const elements = new ElementRepository(handle.db);

    const before = opCount(handle, id, "reschedule_element");
    const res = service.act(id, "postpone", "2026-05-30T12:00:00.000Z");
    expect(res.removed).toBe(false);
    expect(res.element.status).toBe("scheduled");
    expect(res.element.dueAt).toBeTruthy();
    // Future-dated relative to the injected "now".
    expect(Date.parse(res.element.dueAt as string)).toBeGreaterThan(
      Date.parse("2026-05-30T12:00:00.000Z"),
    );
    expect(opCount(handle, id, "reschedule_element")).toBe(before + 1);
    expect(elements.findById(id)?.dueAt).toBe(res.element.dueAt);
  });

  it("FSRS isolation — postponing a CARD defers review_states.due_at, never the attention heuristic", () => {
    const cardId = seedCard(handle);
    const extractId = seedExtract(handle);
    const service = new QueueActionService(handle.db);

    // The card has an FSRS review_states row; the extract has NONE (attention only).
    const elements = new ElementRepository(handle.db);
    const priorCardStatus = elements.findById(cardId)?.status;
    expect(priorCardStatus).toBe("pending"); // un-scheduled, freshly-authored card
    expect(
      handle.db.select().from(reviewStates).where(eq(reviewStates.elementId, cardId)).get(),
    ).toBeTruthy();
    expect(
      handle.db.select().from(reviewStates).where(eq(reviewStates.elementId, extractId)).get(),
    ).toBeUndefined();

    // Postpone the card → its FSRS due moves forward by CARD_DEFER_DAYS; no
    // review_states row is ever created for the extract (the split is never crossed).
    const now = "2026-05-30T12:00:00.000Z";
    const res = service.act(cardId, "postpone", now);
    const state = handle.db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.elementId, cardId))
      .get();
    expect(state?.dueAt).toBeTruthy();
    const expected = Date.parse(now) + CARD_DEFER_DAYS * 86_400_000;
    expect(Date.parse(state?.dueAt as string)).toBe(expected);
    // The element's dueAt mirrors the FSRS due so the queue (which reads
    // review_states.due_at for cards) picks it up.
    expect(res.element.dueAt).toBe(state?.dueAt);

    // The card's ELEMENT status is PRESERVED — the thin defer must NOT smear the
    // attention-side `scheduled` status onto an FSRS card (the two-scheduler split).
    // A card lives in the card-lifecycle vocabulary (active/pending/suspended).
    expect(res.element.status).toBe(priorCardStatus);
    expect(res.element.status).not.toBe("scheduled");
    expect(elements.findById(cardId)?.status).toBe(priorCardStatus);

    // The extract still has NO FSRS row after the card was postponed.
    expect(
      handle.db.select().from(reviewStates).where(eq(reviewStates.elementId, extractId)).get(),
    ).toBeUndefined();
  });

  it("throws for an unknown / soft-deleted element", () => {
    const service = new QueueActionService(handle.db);
    expect(() => service.act("el_missing" as ElementId, "raise")).toThrow(/not found/);

    const id = seedExtract(handle);
    new ElementRepository(handle.db).softDelete(id);
    expect(() => service.act(id, "raise")).toThrow(/not found/);
  });
});

/**
 * The T030 Done-when "done / dismiss / delete … without leaving the list" is a
 * READ-side guarantee: after the action, a re-read of the real `QueueQuery.list()`
 * (the same path the renderer's `queue.list` IPC drives) must NOT contain the row.
 * These run the actual due read end-to-end (not just the row's status) — the
 * regression that proves a `done`/`dismissed` row no longer satisfies the due query
 * and so disappears from the queue, and reappears once undone.
 */
describe("QueueActionService — removing actions leave the due read", () => {
  const NOW = "2026-05-30T12:00:00.000Z" as IsoTimestamp;

  /** Seed an extract and force it OVERDUE so it appears in the due read. */
  function seedDueExtract(): ElementId {
    const id = seedExtract(handle);
    // Push its attention due into the past so it is unambiguously due at NOW.
    new ElementRepository(handle.db).reschedule(id, "2026-05-29T08:00:00.000Z" as IsoTimestamp);
    return id;
  }

  function queueIds(): string[] {
    const queue = new QueueQuery(createRepositories(handle.db));
    return queue.list({ asOf: NOW }).items.map((r) => r.id);
  }

  it("markDone removes the row from QueueQuery.list and undo brings it back", () => {
    const id = seedDueExtract();
    const service = new QueueActionService(handle.db);
    expect(queueIds()).toContain(id); // due before the action

    const res = service.act(id, "markDone", NOW);
    // The done row no longer satisfies the due query — it has LEFT the list.
    expect(queueIds()).not.toContain(id);

    // Undo re-sets the prior status, so it is due again and reappears.
    if (res.undo) service.undo(id, res.undo);
    expect(queueIds()).toContain(id);
  });

  it("dismiss removes the row from QueueQuery.list", () => {
    const id = seedDueExtract();
    const service = new QueueActionService(handle.db);
    expect(queueIds()).toContain(id);

    service.act(id, "dismiss", NOW);
    expect(queueIds()).not.toContain(id);
  });

  it("delete removes the row from QueueQuery.list and undo restores it", () => {
    const id = seedDueExtract();
    const service = new QueueActionService(handle.db);
    expect(queueIds()).toContain(id);

    const res = service.act(id, "delete", NOW);
    expect(queueIds()).not.toContain(id);

    if (res.undo) service.undo(id, res.undo);
    expect(queueIds()).toContain(id);
  });
});
