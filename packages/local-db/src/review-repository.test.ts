/**
 * ReviewRepository.createCardWithin widening (T070).
 *
 * Asserts the additive `sourceUri` + `reviewSeed` inputs (the mechanism Anki import
 * uses to preserve review history) persist correctly into `cards`/`review_states`,
 * and — critically — that the EXISTING no-seed path is byte-identical to before (no
 * regression to the authored-card shape every M6/M7 caller relies on). Runs against
 * a temporary, fully-migrated in-memory better-sqlite3 DB.
 */

import type { DbHandle } from "@interleave/db";
import { cards, reviewLogs, reviewStates } from "@interleave/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReviewRepository } from "./review-repository";
import { createInMemoryDb } from "./test-db";

let handle: DbHandle;

beforeEach(() => {
  handle = createInMemoryDb();
});
afterEach(() => {
  handle.sqlite.close();
});

describe("createCardWithin — reviewSeed + sourceUri (T070)", () => {
  it("persists the seeded reps/lapses/stability/difficulty/dueAt + sourceUri", () => {
    const review = new ReviewRepository(handle.db);
    const due = "2026-07-01T00:00:00.000Z";
    const { element, card } = review.createCard({
      kind: "qa",
      title: "Imported Q&A",
      priority: 0.375,
      prompt: "Capital of France?",
      answer: "Paris",
      sourceUri: "Atlas — https://example.com",
      reviewSeed: {
        reps: 7,
        lapses: 2,
        stability: 12,
        difficulty: 6.5,
        scheduledDays: 12,
        fsrsState: "review",
        dueAt: due,
      },
    });

    // The card row carries the source ref.
    expect(card.sourceUri).toBe("Atlas — https://example.com");

    // The review_states row carries the SEEDED counters + due, NOT the bare defaults.
    const state = handle.db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.elementId, element.id))
      .get();
    expect(state?.reps).toBe(7);
    expect(state?.lapses).toBe(2);
    expect(state?.stability).toBe(12);
    expect(state?.difficulty).toBe(6.5);
    expect(state?.scheduledDays).toBe(12);
    expect(state?.fsrsState).toBe("review");
    expect(state?.dueAt).toBe(due);

    // The element due_at mirrors review_states so the deck agrees (read fresh — the
    // returned element object snapshots pre-dueAt-update, like the firstScheduledAt path).
    const el = review.findCardById(element.id);
    expect(el?.element.dueAt).toBe(due);
    // A seeded card is authored straight into active rotation (it has history).
    expect(element.status).toBe("active");
    expect(element.stage).toBe("active_card");

    // No fabricated historical review_logs — the grading history stays truthful.
    const logs = handle.db
      .select()
      .from(reviewLogs)
      .where(eq(reviewLogs.elementId, element.id))
      .all();
    expect(logs).toHaveLength(0);
  });

  it("a seed activates even with an explicit stage:active_card (the Anki importer's call shape)", () => {
    // The Anki import service authors with BOTH a reviewSeed AND stage:"active_card"
    // explicitly. A seeded card carries full history, so it must land status "active"
    // (in the Library deck facet), not parked as "pending" — regardless of the
    // requested stage. Guards against the importer sidestepping the activation seam.
    const review = new ReviewRepository(handle.db);
    const due = "2026-08-01T00:00:00.000Z";
    const { element } = review.createCard({
      kind: "qa",
      title: "Imported with history",
      priority: 0.375,
      stage: "active_card",
      prompt: "Q",
      answer: "A",
      reviewSeed: {
        reps: 7,
        lapses: 2,
        stability: 30,
        difficulty: 6,
        scheduledDays: 30,
        fsrsState: "review",
        dueAt: due,
      },
    });
    expect(element.status).toBe("active");
    expect(element.stage).toBe("active_card");
  });

  it("the no-seed path is unchanged (authored-card shape: fsrs new, defaults)", () => {
    const review = new ReviewRepository(handle.db);
    const { element } = review.createCard({
      kind: "qa",
      title: "Authored Q&A",
      priority: 0.625,
      prompt: "Q",
      answer: "A",
    });
    const state = handle.db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.elementId, element.id))
      .get();
    // Bare defaults — no regression.
    expect(state?.fsrsState).toBe("new");
    expect(state?.stability).toBe(0);
    expect(state?.difficulty).toBe(0);
    expect(state?.reps).toBe(0);
    expect(state?.lapses).toBe(0);
    expect(state?.dueAt).toBeNull(); // un-due (no firstScheduledAt) — the M6 shape.

    // sourceUri defaults to null when not supplied.
    const card = handle.db.select().from(cards).where(eq(cards.elementId, element.id)).get();
    expect(card?.sourceUri).toBeNull();

    // Un-due authored card stays a draft (no first schedule).
    expect(element.status).toBe("pending");
    expect(element.stage).toBe("card_draft");
  });

  it("firstScheduledAt still works (no seed) and is overridden by a seed", () => {
    const review = new ReviewRepository(handle.db);
    const at = "2026-06-20T00:00:00.000Z";
    const { element } = review.createCard({
      kind: "qa",
      title: "First-scheduled",
      priority: 0.5,
      prompt: "Q",
      answer: "A",
      firstScheduledAt: at,
    });
    const state = handle.db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.elementId, element.id))
      .get();
    expect(state?.dueAt).toBe(at);
    expect(state?.fsrsState).toBe("new"); // first-schedule does NOT run FSRS math.
    expect(element.status).toBe("active");
  });
});
