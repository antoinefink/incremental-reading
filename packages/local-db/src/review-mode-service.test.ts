/**
 * ReviewModeService tests (T096 — targeted review-mode selection).
 *
 * Run against a temporary, fully-migrated in-memory `better-sqlite3` DB so behaviour
 * matches production. One block per selection query, each pinning the load-bearing
 * invariants:
 *
 *  - the resolver returns ONLY live `card` element ids — soft-deleted, `deleted`,
 *    suspended, and T082-retired cards are dropped, and non-card members of a
 *    concept/branch/search are excluded;
 *  - the deck INCLUDES a card whose `review_states.due_at` is in the FUTURE (the
 *    "outside scheduling" assertion — a not-due card IS selected, unlike `dueCards`);
 *  - the documented per-mode order holds (search keeps rank; leech most-lapsed-first;
 *    stale most-overdue-first; concept/source/branch priority-desc);
 *  - `stale` includes only `due_for_review`/`expired` cards and excludes a fresh card
 *    and a lifetime-less card (outside the prefilter candidate set);
 *  - `MAX_REVIEW_MODE_DECK` caps the deck and sets `truncated`;
 *  - the `random` sample is bounded + seed-stable;
 *  - the `semantic` resolver with no query vector degrades to keyword (same ids).
 */

import {
  type ElementId,
  type IsoTimestamp,
  MAX_REVIEW_MODE_DECK,
  type Priority,
} from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { cards, elements, reviewStates } from "@interleave/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConceptRepository } from "./concept-repository";
import { ElementRepository } from "./element-repository";
import { createRepositories, type Repositories } from "./index";
import { ReviewModeService } from "./review-mode-service";
import { ReviewRepository } from "./review-repository";
import { createInMemoryDb } from "./test-db";

let handle: DbHandle;
let repos: Repositories;
let service: ReviewModeService;

const NOW = "2026-06-01T12:00:00.000Z" as IsoTimestamp;

/** Create a Q&A card (live, active) at a given priority; returns its element id. */
function seedCard(
  title: string,
  opts: { priority?: number; sourceId?: ElementId; parentId?: ElementId } = {},
): ElementId {
  const review = new ReviewRepository(handle.db);
  const { element } = review.createCard({
    kind: "qa",
    title,
    priority: (opts.priority ?? 0.5) as Priority,
    prompt: `${title}?`,
    answer: `${title}.`,
    stage: "active_card",
    ...(opts.sourceId ? { sourceId: opts.sourceId } : {}),
    ...(opts.parentId ? { parentId: opts.parentId } : {}),
  });
  return element.id as ElementId;
}

/** Set a card's `review_states.due_at` directly (test setup, not a review). */
function setDueAt(id: ElementId, dueAt: string | null): void {
  handle.db.update(reviewStates).set({ dueAt }).where(eq(reviewStates.elementId, id)).run();
}

/** Flag a card retired (T082) directly on the `cards` side-table. */
function setRetired(id: ElementId): void {
  handle.db.update(cards).set({ isRetired: true }).where(eq(cards.elementId, id)).run();
}

/** Flag a card a leech (T040) directly on the `cards` side-table. */
function setLeech(id: ElementId, lapses: number): void {
  handle.db.update(cards).set({ isLeech: true }).where(eq(cards.elementId, id)).run();
  handle.db.update(reviewStates).set({ lapses }).where(eq(reviewStates.elementId, id)).run();
}

/** Set a card's lifetime fields (T090) directly. */
function setLifetime(id: ElementId, lifetime: { validUntil?: string; reviewBy?: string }): void {
  handle.db
    .update(cards)
    .set({
      validUntil: lifetime.validUntil ?? null,
      reviewBy: lifetime.reviewBy ?? null,
    })
    .where(eq(cards.elementId, id))
    .run();
}

/** Set a card element's lifecycle status directly. */
function setStatus(id: ElementId, status: string): void {
  handle.db.update(elements).set({ status }).where(eq(elements.id, id)).run();
}

beforeEach(() => {
  handle = createInMemoryDb();
  repos = createRepositories(handle.db);
  service = new ReviewModeService(handle.db, repos);
});

afterEach(() => {
  handle.sqlite.close();
});

describe("ReviewModeService — concept mode", () => {
  it("resolves live cards via elementsForConcept, priority-desc, dropping non-cards + retired/deleted/suspended", () => {
    const concepts = new ConceptRepository(handle.db);
    const conceptId = concepts.createConcept({ name: "Spaced repetition" }).id as ElementId;

    const high = seedCard("High", { priority: 0.9 });
    const low = seedCard("Low", { priority: 0.2 });
    const futureDue = seedCard("Future", { priority: 0.5 });
    const retired = seedCard("Retired", { priority: 0.8 });
    const suspended = seedCard("Suspended", { priority: 0.7 });
    const deleted = seedCard("Deleted", { priority: 0.6 });

    // A NON-card member: an extract assigned to the same concept must be excluded.
    const elementsRepo = new ElementRepository(handle.db);
    const extract = elementsRepo.create({
      type: "extract",
      title: "An extract",
      stage: "raw_extract",
      status: "active",
      priority: 0.99 as Priority,
    }).id as ElementId;

    // `futureDue` is NOT due (its FSRS due_at is in the future) — still selectable.
    setDueAt(futureDue, "2099-01-01T00:00:00.000Z");
    setRetired(retired);
    setStatus(suspended, "suspended");

    for (const id of [high, low, futureDue, retired, suspended, deleted, extract]) {
      concepts.assignConcept(id, conceptId);
    }
    elementsRepo.softDelete(deleted);

    const deck = service.deck({ kind: "concept", conceptId }, NOW);
    // Only the three live, non-retired, non-suspended CARDS, priority-desc.
    expect(deck.cardIds).toEqual([high, futureDue, low]);
    expect(deck.cardIds).not.toContain(retired);
    expect(deck.cardIds).not.toContain(suspended);
    expect(deck.cardIds).not.toContain(deleted);
    expect(deck.cardIds).not.toContain(extract);
    // The defining behavior: a NOT-due card is in the deck.
    expect(deck.cardIds).toContain(futureDue);
    expect(deck.label).toBe("Concept");
    expect(deck.truncated).toBe(false);
  });

  it("count() agrees with deck().cardIds.length", () => {
    const concepts = new ConceptRepository(handle.db);
    const conceptId = concepts.createConcept({ name: "C" }).id as ElementId;
    const a = seedCard("A");
    const b = seedCard("B");
    concepts.assignConcept(a, conceptId);
    concepts.assignConcept(b, conceptId);
    expect(service.count({ kind: "concept", conceptId }, NOW).total).toBe(2);
  });
});

describe("ReviewModeService — source mode", () => {
  it("resolves live cards under a source, dropping retired + including not-due", () => {
    const elementsRepo = new ElementRepository(handle.db);
    const sourceId = elementsRepo.create({
      type: "source",
      title: "A source",
      stage: "raw_source",
      status: "active",
      priority: 0.5 as Priority,
    }).id as ElementId;

    const c1 = seedCard("C1", { priority: 0.8, sourceId });
    const c2 = seedCard("C2", { priority: 0.3, sourceId });
    const retired = seedCard("Retired", { priority: 0.9, sourceId });
    const otherSourceCard = seedCard("Other", { priority: 0.9 });
    setRetired(retired);
    setDueAt(c2, "2099-01-01T00:00:00.000Z");

    const deck = service.deck({ kind: "source", sourceId }, NOW);
    expect(deck.cardIds).toEqual([c1, c2]); // priority-desc, retired dropped
    expect(deck.cardIds).not.toContain(retired);
    expect(deck.cardIds).not.toContain(otherSourceCard);
    expect(deck.cardIds).toContain(c2); // not-due is included
  });
});

describe("ReviewModeService — branch mode", () => {
  it("resolves the lineage-subtree cards via LineageQuery, only `card` nodes, priority-desc", () => {
    const elementsRepo = new ElementRepository(handle.db);
    const source = elementsRepo.create({
      type: "source",
      title: "Root source",
      stage: "raw_source",
      status: "active",
      priority: 0.5 as Priority,
    }).id as ElementId;
    const extract = elementsRepo.create({
      type: "extract",
      title: "An extract",
      stage: "raw_extract",
      status: "active",
      priority: 0.5 as Priority,
      parentId: source,
      sourceId: source,
    }).id as ElementId;

    const cardHigh = seedCard("Card high", {
      priority: 0.9,
      parentId: extract,
      sourceId: source,
    });
    const cardLow = seedCard("Card low", {
      priority: 0.2,
      parentId: extract,
      sourceId: source,
    });
    setDueAt(cardLow, "2099-01-01T00:00:00.000Z");

    const deck = service.deck({ kind: "branch", rootId: source }, NOW);
    // Only the cards of the subtree (not the source/extract nodes), priority-desc.
    expect(deck.cardIds).toEqual([cardHigh, cardLow]);
    expect(deck.cardIds).not.toContain(source);
    expect(deck.cardIds).not.toContain(extract);
    expect(deck.cardIds).toContain(cardLow); // not-due included
  });
});

describe("ReviewModeService — search mode", () => {
  it("keeps the ranked FTS card order, filtered to live cards, including not-due", () => {
    // Title-headline hit outranks body-only; ensure 'mitochondria' is the keyword.
    const headline = seedCard("Mitochondria energy"); // title match (tier 0)
    const bodyOnly = (() => {
      const review = new ReviewRepository(handle.db);
      const { element } = review.createCard({
        kind: "qa",
        title: "Cellular biology",
        priority: 0.5 as Priority,
        prompt: "What is the powerhouse?",
        answer: "The mitochondria of the cell.", // body match (tier 1)
        stage: "active_card",
      });
      return element.id as ElementId;
    })();
    setDueAt(headline, "2099-01-01T00:00:00.000Z"); // not due — still selectable

    const deck = service.deck({ kind: "search", query: "mitochondria" }, NOW);
    expect(deck.cardIds.length).toBe(2);
    // Headline (title) hit ranks before the body-only hit.
    expect(deck.cardIds[0]).toBe(headline);
    expect(deck.cardIds[1]).toBe(bodyOnly);
  });

  it("excludes a soft-deleted matching card", () => {
    const elementsRepo = new ElementRepository(handle.db);
    const a = seedCard("Mitochondria one");
    const b = seedCard("Mitochondria two");
    elementsRepo.softDelete(b);
    const deck = service.deck({ kind: "search", query: "mitochondria" }, NOW);
    expect(deck.cardIds).toEqual([a]);
  });
});

describe("ReviewModeService — semantic mode", () => {
  it("degrades to the keyword resolver when no query vector is supplied (same ids, never throws)", () => {
    const a = seedCard("Photosynthesis basics");
    const keyword = service.deck({ kind: "search", query: "photosynthesis" }, NOW);
    const semanticNoVector = service.deck({ kind: "semantic", query: "photosynthesis" }, NOW, {
      enabled: false,
      queryVector: null,
    });
    expect(semanticNoVector.cardIds).toEqual(keyword.cardIds);
    expect(semanticNoVector.cardIds).toContain(a);
  });
});

describe("ReviewModeService — stale mode", () => {
  it("includes only due_for_review/expired cards; excludes a fresh card and a lifetime-less card", () => {
    const expired = seedCard("Expired");
    const dueForReview = seedCard("DueForReview");
    const fresh = seedCard("Fresh");
    const noLifetime = seedCard("NoLifetime");

    setLifetime(expired, { validUntil: "2025-01-01" }); // past → expired
    setLifetime(dueForReview, { reviewBy: "2025-09-01" }); // past review_by → due_for_review
    setLifetime(fresh, { validUntil: "2099-01-01" }); // future → fresh
    // noLifetime: no lifetime fields → outside the candidate set entirely

    const deck = service.deck({ kind: "stale" }, NOW);
    // Both not-fresh cards, expired before due_for_review (most-overdue-first).
    expect(deck.cardIds).toEqual([expired, dueForReview]);
    expect(deck.cardIds).not.toContain(fresh);
    expect(deck.cardIds).not.toContain(noLifetime);
  });

  it("drops a retired stale card", () => {
    const expired = seedCard("Expired");
    setLifetime(expired, { validUntil: "2025-01-01" });
    setRetired(expired);
    expect(service.deck({ kind: "stale" }, NOW).cardIds).toEqual([]);
  });
});

describe("ReviewModeService — leech mode", () => {
  it("returns exactly the live leech set, most-lapsed-first, dropping retired + suspended", () => {
    const worst = seedCard("Worst");
    const bad = seedCard("Bad");
    const retiredLeech = seedCard("RetiredLeech");
    const suspendedLeech = seedCard("SuspendedLeech");
    const notLeech = seedCard("NotLeech");

    setLeech(worst, 9);
    setLeech(bad, 4);
    setLeech(retiredLeech, 7);
    setLeech(suspendedLeech, 6);
    setRetired(retiredLeech);
    setStatus(suspendedLeech, "suspended");

    const deck = service.deck({ kind: "leech" }, NOW);
    expect(deck.cardIds).toEqual([worst, bad]); // most-lapsed-first
    expect(deck.cardIds).not.toContain(retiredLeech);
    expect(deck.cardIds).not.toContain(suspendedLeech);
    expect(deck.cardIds).not.toContain(notLeech);
  });
});

describe("ReviewModeService — random mode", () => {
  it("returns a bounded sample and the SAME sample for the same seed", () => {
    const ids: ElementId[] = [];
    for (let i = 0; i < 10; i++) ids.push(seedCard(`Card ${i}`));

    const first = service.deck({ kind: "random", size: 4, seed: 123 }, NOW);
    const again = service.deck({ kind: "random", size: 4, seed: 123 }, NOW);
    expect(first.cardIds.length).toBe(4);
    expect(again.cardIds).toEqual(first.cardIds); // seed-stable
    // Every sampled id is one of the live cards.
    for (const id of first.cardIds) expect(ids).toContain(id);
    // total reflects the full live-card pool (10), not the sample size — consistent
    // with every other mode's `total` semantic. `size` is a per-mode deck cap.
    expect(first.total).toBe(10);
    expect(first.truncated).toBe(false); // size <= MAX, so never flagged truncated
    // count() agrees with deck().total (both report the full pool).
    expect(service.count({ kind: "random", size: 4, seed: 123 }, NOW).total).toBe(10);
  });

  it("excludes retired + deleted cards from the random pool", () => {
    const live = seedCard("Live");
    const retired = seedCard("Retired");
    const deleted = seedCard("Deleted");
    setRetired(retired);
    new ElementRepository(handle.db).softDelete(deleted);
    const deck = service.deck({ kind: "random", size: 10, seed: 1 }, NOW);
    expect(deck.cardIds).toEqual([live]);
  });
});

describe("ReviewModeService — deck cap", () => {
  it("caps the deck at MAX_REVIEW_MODE_DECK and flags truncated", () => {
    const concepts = new ConceptRepository(handle.db);
    const conceptId = concepts.createConcept({ name: "Big" }).id as ElementId;
    const count = MAX_REVIEW_MODE_DECK + 5;
    for (let i = 0; i < count; i++) {
      // Equal priority so order is creation-stable; the cap is what we assert.
      const id = seedCard(`Card ${String(i).padStart(4, "0")}`, { priority: 0.5 });
      concepts.assignConcept(id, conceptId);
    }
    const deck = service.deck({ kind: "concept", conceptId }, NOW);
    expect(deck.cardIds.length).toBe(MAX_REVIEW_MODE_DECK);
    expect(deck.total).toBe(count);
    expect(deck.truncated).toBe(true);
  });
});
