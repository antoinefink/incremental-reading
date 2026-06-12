/**
 * DescendantQuery tests (T135 / U3).
 *
 * `countDescendants` drives the lineage-delete intent menu: a zero total means
 * "quiet delete, no menu"; a non-zero total opens the blast-radius menu. The
 * breakdown ({@link DescendantCounts}) quantifies what a branch delete would take
 * — descendant extracts, cards, and the cards carrying review history — so it is
 * tested against a real `source → extract → sub-extract → cards` chain built
 * through the repositories (mirroring the lineage-query fixture rather than
 * importing `@interleave/testing`, which depends on this package).
 *
 * The walk is the SHARED live-descendant DFS (`liveDescendantsWithin`, also used
 * by the fallow path), so these also pin: soft-deleted descendants are excluded,
 * and a deep chain counts transitively.
 */

import type { BlockId, ElementId } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { CardSchedulerService } from "@interleave/scheduler";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DescendantQuery } from "./descendant-query";
import { createRepositories, type Repositories } from "./index";
import { createInMemoryDb } from "./test-db";

let handle: DbHandle;
let repos: Repositories;
let descendants: DescendantQuery;

const NOW = "2026-06-15T00:00:00.000Z";

beforeEach(() => {
  handle = createInMemoryDb();
  repos = createRepositories(handle.db);
  descendants = new DescendantQuery(handle.db);
});

afterEach(() => {
  handle.sqlite.close();
});

/** Create a bare source and return its id. */
function makeSource(title = "On the Measure of Intelligence"): ElementId {
  return repos.sources.create({ title, priority: 0.875, status: "active" }).element.id;
}

/** Create an extract anchored to a source (optionally under a parent extract). */
function makeExtract(sourceId: ElementId, parentId?: ElementId): ElementId {
  return repos.sources.createExtract({
    sourceElementId: sourceId,
    ...(parentId ? { parentId } : {}),
    title: parentId ? "Sub-extract" : "Extract",
    priority: 0.625,
    selectedText: "…",
    blockIds: ["blk" as BlockId],
    startOffset: 0,
    endOffset: 10,
    label: "¶1",
  }).element.id;
}

/** Author a Q&A card under an extract. */
function makeCard(parentId: ElementId, sourceId: ElementId, title = "Card"): ElementId {
  return repos.review.createCard({
    kind: "qa",
    title,
    priority: 0.625,
    prompt: "Q?",
    answer: "A.",
    parentId,
    sourceId,
    stage: "active_card",
  }).element.id;
}

/** Drive one real FSRS grade so the card has a `review_logs` row. */
function reviewOnce(cardId: ElementId): void {
  const scheduler = new CardSchedulerService({ desiredRetention: 0.9, enableFuzz: false });
  const state = repos.review.findReviewState(cardId);
  if (!state) throw new Error(`review state missing for ${cardId}`);
  repos.review.recordReview(cardId, scheduler.gradeCard(state, "good", NOW as never, 1200));
}

describe("DescendantQuery.countDescendants", () => {
  it("R4: a leaf (no live descendants) returns total 0 and zero breakdown", () => {
    const sourceId = makeSource();
    const extractId = makeExtract(sourceId);
    const cardId = makeCard(extractId, sourceId);

    // The card is a leaf — nothing hangs beneath it.
    expect(descendants.countDescendants(cardId)).toEqual({
      extracts: 0,
      cards: 0,
      cardsWithHistory: 0,
      total: 0,
    });
  });

  it("R5: an extract with a sub-extract and two cards (one reviewed) → extracts 1, cards 2, cardsWithHistory 1, total 3", () => {
    const sourceId = makeSource();
    const extractId = makeExtract(sourceId);
    makeExtract(sourceId, extractId); // sub-extract beneath the extract
    const reviewedCard = makeCard(extractId, sourceId, "Reviewed card");
    makeCard(extractId, sourceId, "Fresh card"); // never reviewed
    reviewOnce(reviewedCard);

    expect(descendants.countDescendants(extractId)).toEqual({
      extracts: 1,
      cards: 2,
      cardsWithHistory: 1,
      total: 3,
    });
  });

  it("cardsWithHistory counts a reviewed card by its review_logs row (not reps), so a reviewed-then-reset card still counts", () => {
    const sourceId = makeSource();
    const extractId = makeExtract(sourceId);
    const cardId = makeCard(extractId, sourceId);
    reviewOnce(cardId);

    // Simulate a "forgotten"/reset card: zero out reps/lapses on review_states but
    // leave the immutable review_logs row. The signal is history-exists, not reps>0.
    repos.review.findReviewState(cardId); // sanity: state exists
    handle.sqlite
      .prepare("UPDATE review_states SET reps = 0, lapses = 0 WHERE element_id = ?")
      .run(cardId);

    const counts = descendants.countDescendants(extractId);
    expect(counts.cards).toBe(1);
    expect(counts.cardsWithHistory).toBe(1);
  });

  it("excludes soft-deleted descendants from every count", () => {
    const sourceId = makeSource();
    const extractId = makeExtract(sourceId);
    const subExtractId = makeExtract(sourceId, extractId);
    const liveCard = makeCard(extractId, sourceId, "Live card");
    const deletedCard = makeCard(extractId, sourceId, "Deleted card");

    // Soft-delete the sub-extract and one card.
    repos.elements.softDelete(subExtractId);
    repos.elements.softDelete(deletedCard);

    const counts = descendants.countDescendants(extractId);
    expect(counts.extracts).toBe(0); // the only sub-extract is deleted
    expect(counts.cards).toBe(1); // only the live card remains
    expect(counts.total).toBe(1);
    // The deleted card is gone even though it exists in the row store.
    expect(liveCard).not.toBe(deletedCard);
  });

  it("counts a deep chain transitively (extract → sub → sub-sub → card)", () => {
    const sourceId = makeSource();
    const e1 = makeExtract(sourceId);
    const e2 = makeExtract(sourceId, e1);
    const e3 = makeExtract(sourceId, e2);
    makeCard(e3, sourceId);

    // From the source: e1 + e2 + e3 (3 extracts) + 1 card = total 4.
    const fromSource = descendants.countDescendants(sourceId);
    expect(fromSource).toEqual({ extracts: 3, cards: 1, cardsWithHistory: 0, total: 4 });

    // From e1: e2 + e3 (2 extracts) + 1 card = total 3.
    expect(descendants.countDescendants(e1)).toEqual({
      extracts: 2,
      cards: 1,
      cardsWithHistory: 0,
      total: 3,
    });
  });
});
