/**
 * BulkActionService tests (T099) — the thin batch wrappers behind Maintenance cleanup.
 *
 * Against this package's in-memory `createInMemoryDb` harness. Covers:
 *  - `bulkSoftDelete` mints ONE `batchId`, soft-deletes each id, skips missing ones,
 *    and the WHOLE batch reverses with `UndoService.undoLast` (every item live again,
 *    prior status restored);
 *  - `bulkArchive` `dismiss` sets status `dismissed` under one batch and undoes as one;
 *  - `bulkArchive` `retire` retires CARDS only and skips a non-card clearly;
 *  - `bulkPostpone` defers a card on FSRS + reschedules an attention item under one
 *    batch (the two-scheduler split holds).
 */

import { PRIORITY_LABEL_VALUE } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { reviewStates } from "@interleave/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BulkActionService } from "./bulk-action-service";
import { createRepositories, type Repositories } from "./index";
import { createInMemoryDb } from "./test-db";
import { UndoService } from "./undo-service";

let handle: DbHandle;
let repos: Repositories;
let bulk: BulkActionService;
let undo: UndoService;

beforeEach(() => {
  handle = createInMemoryDb();
  repos = createRepositories(handle.db);
  bulk = repos.bulkActions;
  undo = new UndoService(handle.db);
});

afterEach(() => {
  handle.sqlite.close();
});

/** A live source element id (an attention item). */
function makeSource(title: string, priority = PRIORITY_LABEL_VALUE.C): string {
  return repos.sources.create({ title, priority, status: "active", stage: "raw_source" }).element
    .id;
}

/** A live card element id (an FSRS item), due now so postpone has something to defer. */
function makeCard(title: string): string {
  const card = repos.review.createCard({
    kind: "qa",
    title,
    prompt: "Q",
    answer: "A",
    priority: PRIORITY_LABEL_VALUE.C,
    stage: "active_card",
    firstScheduledAt: "2026-06-01T00:00:00.000Z" as never,
  });
  return card.element.id;
}

describe("BulkActionService.bulkSoftDelete", () => {
  it("mints one batchId, soft-deletes each id, skips missing, undoes as one batch", () => {
    const a = makeSource("A");
    const b = makeSource("B");
    const res = bulk.bulkSoftDelete([a as never, b as never, "missing" as never]);
    expect(res.affected).toBe(2);
    expect(res.skipped).toEqual(["missing"]);
    expect(res.batchId).toBeTruthy();

    // Both are soft-deleted now.
    expect(repos.elements.findById(a as never)?.deletedAt).toBeTruthy();
    expect(repos.elements.findById(b as never)?.deletedAt).toBeTruthy();

    // The whole batch reverses with ONE undoLast.
    const result = undo.undoLast();
    expect(result.undone).toBe(true);
    expect(result.count).toBe(2);
    expect(repos.elements.findById(a as never)?.deletedAt).toBeNull();
    expect(repos.elements.findById(b as never)?.deletedAt).toBeNull();
    expect(repos.elements.findById(a as never)?.status).toBe("active");
  });
});

describe("BulkActionService.bulkArchive", () => {
  it("dismiss sets status `dismissed` under one batch and undoes as one", () => {
    const a = makeSource("A");
    const b = makeSource("B");
    const res = bulk.bulkArchive([a as never, b as never], "dismiss");
    expect(res.affected).toBe(2);
    expect(repos.elements.findById(a as never)?.status).toBe("dismissed");
    expect(repos.elements.findById(b as never)?.status).toBe("dismissed");

    const result = undo.undoLast();
    expect(result.undone).toBe(true);
    expect(result.count).toBe(2);
    expect(repos.elements.findById(a as never)?.status).toBe("active");
    expect(repos.elements.findById(b as never)?.status).toBe("active");
  });

  it("trash mode soft-deletes (recoverable) under one batch", () => {
    const a = makeSource("A");
    const res = bulk.bulkArchive([a as never], "trash");
    expect(res.affected).toBe(1);
    expect(repos.elements.findById(a as never)?.deletedAt).toBeTruthy();
  });

  it("retire applies to CARDS only and skips a non-card clearly", () => {
    const card = makeCard("Card");
    const source = makeSource("Source");
    const res = bulk.bulkArchive([card as never, source as never], "retire");
    expect(res.affected).toBe(1);
    expect(res.skipped).toEqual([source]);
    // The card is retired (durable flag), the source untouched.
    expect(repos.review.findCardById(card as never)?.card.isRetired).toBe(true);
    expect(repos.elements.findById(source as never)?.status).toBe("active");
  });
});

describe("BulkActionService.bulkPostpone", () => {
  it("defers a card on FSRS + reschedules an attention item under one batch (the split)", () => {
    const card = makeCard("Card");
    const source = makeSource("Source");
    const prevCardDue = handle.db
      .select({ dueAt: reviewStates.dueAt })
      .from(reviewStates)
      .where(eq(reviewStates.elementId, card as never))
      .get()?.dueAt;

    const res = bulk.bulkPostpone([card as never, source as never], "2026-06-01T00:00:00.000Z");
    expect(res.elements).toHaveLength(2);
    expect(res.batchId).toBeTruthy();

    // The card's FSRS due moved (review_states), NOT just the element.
    const nextCardDue = handle.db
      .select({ dueAt: reviewStates.dueAt })
      .from(reviewStates)
      .where(eq(reviewStates.elementId, card as never))
      .get()?.dueAt;
    expect(nextCardDue).not.toBe(prevCardDue);
    expect(nextCardDue).toBeTruthy();

    // The attention source got a future due_at on the element.
    expect(repos.elements.findById(source as never)?.dueAt).toBeTruthy();

    // The whole bulk-postpone reverses as one batch.
    const result = undo.undoLast();
    expect(result.undone).toBe(true);
    expect(result.count).toBe(2);
  });
});
