/**
 * CardEditService tests (T038 — in-review card repair).
 *
 * Against a TEMPORARY, fully-migrated in-memory `better-sqlite3` DB, these assert
 * the load-bearing repair invariants in ONE place:
 *
 *  - `updateBody` edits a Q&A card's prompt/answer (or a cloze card's cloze text),
 *    logs `update_element`, and NEVER touches lineage (`sourceLocationId`), the
 *    FSRS `review_states`, or the append-only `review_logs` (an edit must not
 *    corrupt the in-flight FSRS state);
 *  - `updateBody` keeps the body non-empty for the card's kind;
 *  - `suspend` sets status `suspended` (`update_element`), leaving review state/logs;
 *  - `delete` SOFT-deletes (`deletedAt` + status `deleted`, `soft_delete_element`);
 *  - `flag` records the flag in the op payload (no column; the latest marker wins),
 *    leaving the card live + un-touching its body/lineage/FSRS state;
 *  - every repair appends the CORRECT EXISTING op (the closed 15-op set is unchanged).
 */

import type { BlockId, ElementId, IsoTimestamp, Priority, ReviewRating } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { elements, operationLog, reviewLogs, reviewStates } from "@interleave/db";
import { CardSchedulerService } from "@interleave/scheduler";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardEditService } from "./card-edit-service";
import { CardService } from "./card-service";
import { ElementRepository } from "./element-repository";
import { ReviewRepository } from "./review-repository";
import { SourceRepository } from "./source-repository";
import { createInMemoryDb } from "./test-db";

let handle: DbHandle;

/** Seed a source + an anchored extract, then a Q&A (and optionally cloze) card. */
function seedCard(
  handle: DbHandle,
  kind: "qa" | "cloze" = "qa",
  priority: Priority = 0.875,
): { cardId: ElementId; sourceLocationId: string | null } {
  const sources = new SourceRepository(handle.db);
  const { element: source } = sources.createWithDocument({
    title: "On the Measure of Intelligence",
    priority,
    status: "active",
    stage: "raw_source",
    body: "The definition paragraph.\n\nAnother paragraph.",
  });
  const { element: extract } = sources.createExtract({
    sourceElementId: source.id,
    title: "Definition extract",
    priority,
    stage: "atomic_statement",
    selectedText: "The definition paragraph.",
    blockIds: ["blk_def" as BlockId],
    startOffset: 0,
    endOffset: 25,
    label: "Definition · ¶1",
  });
  const cardSvc = new CardService(handle.db);
  const { element, sourceLocationId } = cardSvc.createFromExtract(
    kind === "qa"
      ? {
          extractId: extract.id,
          kind: "qa",
          prompt: "Original prompt?",
          answer: "Original answer.",
        }
      : { extractId: extract.id, kind: "cloze", cloze: "Intelligence is {{c1::efficiency}}." },
  );
  return { cardId: element.id, sourceLocationId };
}

/** Count `operation_log` rows of a given type for an element. */
function opCount(handle: DbHandle, elementId: ElementId, opType: string): number {
  return handle.db
    .select()
    .from(operationLog)
    .where(eq(operationLog.elementId, elementId))
    .all()
    .filter((r) => r.opType === opType).length;
}

beforeEach(() => {
  handle = createInMemoryDb();
});

afterEach(() => {
  handle.sqlite.close();
});

describe("CardEditService.updateBody", () => {
  it("edits a Q&A card's prompt/answer, logs update_element, and preserves lineage + FSRS state", () => {
    const { cardId, sourceLocationId } = seedCard(handle);
    const service = new CardEditService(handle.db);
    const review = new ReviewRepository(handle.db);

    const stateBefore = review.findReviewState(cardId);
    const logsBefore = review.listReviewLogs(cardId).length;
    const opsBefore = opCount(handle, cardId, "update_element");

    const { card } = service.updateBody(cardId, { prompt: "New prompt?", answer: "New answer." });

    expect(card.prompt).toBe("New prompt?");
    expect(card.answer).toBe("New answer.");
    // The inherited source-location anchor is intact (lineage preserved).
    expect(card.sourceLocationId).toBe(sourceLocationId);
    // The FSRS state + append-only logs are untouched by an edit.
    const stateAfter = review.findReviewState(cardId);
    expect(stateAfter?.dueAt).toBe(stateBefore?.dueAt);
    expect(stateAfter?.reps).toBe(stateBefore?.reps);
    expect(review.listReviewLogs(cardId).length).toBe(logsBefore);
    // Exactly one new update_element op.
    expect(opCount(handle, cardId, "update_element")).toBe(opsBefore + 1);
  });

  it("edits a cloze card's cloze text (canonicalizing bare markers), ignoring prompt/answer", () => {
    const { cardId } = seedCard(handle, "cloze");
    const service = new CardEditService(handle.db);
    const { card } = service.updateBody(cardId, { cloze: "Memory is {{consolidation}}." });
    // Bare `{{answer}}` is auto-numbered to the canonical `{{c1::answer}}` form.
    expect(card.cloze).toContain("{{c1::consolidation}}");
    expect(card.prompt).toBeNull();
    expect(card.answer).toBeNull();
  });

  it("rejects emptying a Q&A card's required prompt/answer", () => {
    const { cardId } = seedCard(handle);
    const service = new CardEditService(handle.db);
    expect(() => service.updateBody(cardId, { prompt: "" })).toThrow();
    expect(() => service.updateBody(cardId, { answer: "   " })).toThrow();
  });

  it("rejects a non-card / unknown element", () => {
    const service = new CardEditService(handle.db);
    expect(() => service.updateBody("el_missing" as ElementId, { prompt: "x" })).toThrow(
      /not found/,
    );
  });
});

describe("CardEditService.suspend / delete", () => {
  it("suspend sets status suspended and logs update_element, keeping review state", () => {
    const { cardId } = seedCard(handle);
    const service = new CardEditService(handle.db);
    const review = new ReviewRepository(handle.db);
    const opsBefore = opCount(handle, cardId, "update_element");

    const { element } = service.suspend(cardId);
    expect(element.status).toBe("suspended");
    expect(new ElementRepository(handle.db).findById(cardId)?.status).toBe("suspended");
    // The review state survives (recoverable on un-suspend).
    expect(review.findReviewState(cardId)).not.toBeNull();
    expect(opCount(handle, cardId, "update_element")).toBe(opsBefore + 1);
  });

  it("delete soft-deletes (status deleted, deletedAt set) and logs soft_delete_element", () => {
    const { cardId } = seedCard(handle);
    const service = new CardEditService(handle.db);
    const opsBefore = opCount(handle, cardId, "soft_delete_element");

    const { element } = service.delete(cardId);
    expect(element.status).toBe("deleted");
    expect(element.deletedAt).toBeTruthy();
    expect(opCount(handle, cardId, "soft_delete_element")).toBe(opsBefore + 1);
  });
});

describe("CardEditService.flag", () => {
  it("records a non-destructive flag (via update_element) the latest marker resolves", () => {
    const { cardId } = seedCard(handle);
    const service = new CardEditService(handle.db);
    const elements = new ElementRepository(handle.db);

    expect(service.isFlagged(cardId)).toBe(false);
    // Baseline: the card was first-scheduled + activated at creation (T036), which
    // itself logs an update_element. Measure the flag deltas against that baseline.
    const updatesBefore = opCount(handle, cardId, "update_element");

    const flagged = service.flag(cardId, true, "ambiguous pronoun");
    expect(flagged.element.status).not.toBe("deleted");
    expect(service.isFlagged(cardId)).toBe(true);
    expect(service.flagState(cardId).reason).toBe("ambiguous pronoun");
    // The card is NOT destroyed (a flag is advisory).
    expect(elements.findById(cardId)?.deletedAt).toBeNull();

    // Un-flagging clears it (latest marker wins).
    service.flag(cardId, false);
    expect(service.isFlagged(cardId)).toBe(false);

    // Only update_element ops were used for the flag (no new op type): the two
    // toggles add exactly two update_element ops over the creation baseline.
    expect(opCount(handle, cardId, "update_element")).toBe(updatesBefore + 2);
  });

  it("leaves the body + lineage + FSRS state untouched", () => {
    const { cardId, sourceLocationId } = seedCard(handle);
    const service = new CardEditService(handle.db);
    const review = new ReviewRepository(handle.db);
    const before = review.findCardById(cardId);
    const stateBefore = review.findReviewState(cardId);

    service.flag(cardId, true);

    const after = review.findCardById(cardId);
    expect(after?.card.prompt).toBe(before?.card.prompt);
    expect(after?.card.sourceLocationId).toBe(sourceLocationId);
    expect(review.findReviewState(cardId)?.dueAt).toBe(stateBefore?.dueAt);
  });
});

describe("CardEditService.setLifetime (T090)", () => {
  it("writes the six lifetime columns, logs update_element, and keeps the card active", () => {
    const { cardId } = seedCard(handle);
    const service = new CardEditService(handle.db);
    const review = new ReviewRepository(handle.db);
    const elements = new ElementRepository(handle.db);
    const opsBefore = opCount(handle, cardId, "update_element");
    const stateBefore = review.findReviewState(cardId);

    const { card, element } = service.setLifetime(cardId, {
      factStability: "slow",
      validFrom: "2019-11-05",
      validUntil: "2020-01-01",
      jurisdiction: "global",
      softwareVersion: "React 18",
      reviewBy: "2020-06-01",
    });

    expect(card.factStability).toBe("slow");
    expect(card.validFrom).toBe("2019-11-05");
    expect(card.validUntil).toBe("2020-01-01");
    expect(card.jurisdiction).toBe("global");
    expect(card.softwareVersion).toBe("React 18");
    expect(card.reviewBy).toBe("2020-06-01");
    // "Expired" is a DERIVED attribute — the card never leaves active/scheduled.
    expect(element.status).toBe(elements.findById(cardId)?.status);
    expect(["active", "scheduled", "pending"]).toContain(element.status);
    // Exactly one new update_element op (no new op type, no status change op).
    expect(opCount(handle, cardId, "update_element")).toBe(opsBefore + 1);
    // The FSRS state is untouched (a lifetime edit must not touch review state).
    expect(review.findReviewState(cardId)?.dueAt).toBe(stateBefore?.dueAt);
    expect(review.findReviewState(cardId)?.reps).toBe(stateBefore?.reps);
  });

  it("leaves omitted fields unchanged and clears with an explicit null / empty string", () => {
    const { cardId } = seedCard(handle);
    const service = new CardEditService(handle.db);
    service.setLifetime(cardId, { validUntil: "2025-01-01", reviewBy: "2025-06-01" });
    // An omitted field is unchanged; only validUntil is patched here.
    let { card } = service.setLifetime(cardId, { validUntil: "2026-01-01" });
    expect(card.validUntil).toBe("2026-01-01");
    expect(card.reviewBy).toBe("2025-06-01");
    // An explicit empty string / null clears the field.
    ({ card } = service.setLifetime(cardId, { reviewBy: "", validUntil: null }));
    expect(card.reviewBy).toBeNull();
    expect(card.validUntil).toBeNull();
  });

  it("clears fact_stability on a non-tuple value", () => {
    const { cardId } = seedCard(handle);
    const service = new CardEditService(handle.db);
    service.setLifetime(cardId, { factStability: "stable" });
    const { card } = service.setLifetime(cardId, {
      // @ts-expect-error — exercising the runtime guard against a bad value.
      factStability: "rock-solid",
    });
    expect(card.factStability).toBeNull();
  });

  it("rejects a non-card / unknown element", () => {
    const service = new CardEditService(handle.db);
    expect(() =>
      service.setLifetime("el_missing" as ElementId, { reviewBy: "2025-01-01" }),
    ).toThrow(/not found/);
  });
});

// ---------------------------------------------------------------------------
// T125 — Card-edit write barrier (re-stabilization + guarded undo).
// ---------------------------------------------------------------------------

const NOW = "2026-06-15T00:00:00.000Z" as IsoTimestamp;

/** Force a card into a matured, high-stability, far-future-due review state. */
function matureCard(handle: DbHandle, cardId: ElementId): void {
  handle.db
    .update(reviewStates)
    .set({
      dueAt: "2027-03-15T00:00:00.000Z",
      stability: 270,
      difficulty: 6.4,
      elapsedDays: 30,
      scheduledDays: 270,
      reps: 12,
      lapses: 1,
      fsrsState: "review",
      learningSteps: 0,
      lastReviewedAt: "2026-06-01T00:00:00.000Z",
    })
    .where(eq(reviewStates.elementId, cardId))
    .run();
  handle.db
    .update(elements)
    .set({ dueAt: "2027-03-15T00:00:00.000Z" })
    .where(eq(elements.id, cardId))
    .run();
}

/** Resolve a re-stabilization for the card's current state (the DbService path). */
function resolveReStabilize(handle: DbHandle, cardId: ElementId, at: IsoTimestamp) {
  const state = new ReviewRepository(handle.db).findReviewState(cardId);
  if (!state) throw new Error("no state");
  const outcome = new CardSchedulerService({
    desiredRetention: 0.9,
    enableFuzz: false,
  }).reStabilize(state, at);
  return outcome ? { outcome, at } : null;
}

/** Grade a card through the real scheduler + repository path. */
function gradeCard(handle: DbHandle, cardId: ElementId, rating: ReviewRating, at: IsoTimestamp) {
  const review = new ReviewRepository(handle.db);
  const state = review.findReviewState(cardId);
  if (!state) throw new Error("no state");
  const outcome = new CardSchedulerService({ desiredRetention: 0.9, enableFuzz: false }).gradeCard(
    state,
    rating,
    at,
    1500,
  );
  return review.recordReview(cardId, outcome, { promptMs: 200 });
}

function markerRowFor(handle: DbHandle, reviewLogId: string) {
  return handle.db.select().from(reviewLogs).where(eq(reviewLogs.id, reviewLogId)).get();
}

describe("CardEditService re-stabilize (T125 write barrier)", () => {
  it("demotes the persisted FSRS state, writes a marker row, mirrors elements.due_at, op-logs", () => {
    const { cardId } = seedCard(handle);
    matureCard(handle, cardId);
    const service = new CardEditService(handle.db);
    const review = new ReviewRepository(handle.db);

    const reStabilize = resolveReStabilize(handle, cardId, NOW);
    expect(reStabilize).not.toBeNull();
    const result = service.updateBody(
      cardId,
      { answer: "A materially rewritten answer." },
      reStabilize,
    );

    expect(result.reStabilized).not.toBeNull();
    const receipt = result.reStabilized;
    if (!receipt) throw new Error("expected a receipt");

    // Persisted review state demoted: due soon, stability collapsed, difficulty + counters kept.
    const state = review.findReviewState(cardId);
    expect(Date.parse(state?.dueAt ?? "")).toBeLessThanOrEqual(
      Date.parse(NOW) + 24 * 3600 * 1000 + 1,
    );
    expect(state?.stability).toBeLessThanOrEqual(1);
    expect(state?.difficulty).toBe(6.4);
    expect(state?.reps).toBe(12);
    expect(state?.lapses).toBe(1);
    // last_reviewed_at PRESERVED (a re-stabilization is not a review).
    expect(state?.lastReviewedAt).toBe("2026-06-01T00:00:00.000Z");

    // elements.due_at mirrors review_states.due_at.
    const el = handle.db.select().from(elements).where(eq(elements.id, cardId)).get();
    expect(el?.dueAt).toBe(state?.dueAt);

    // The marker row carries the full preimage + the class/choice + a placeholder rating.
    const marker = markerRowFor(handle, receipt.reviewLogId);
    expect(marker?.editMarkerAt).toBe(NOW);
    expect(marker?.editClass).toBe("substantive");
    expect(marker?.editChoice).toBe("re_stabilize");
    expect(marker?.rating).toBe("good");
    expect(marker?.prevStability).toBe(270);
    expect(marker?.prevDueAt).toBe("2027-03-15T00:00:00.000Z");

    // The demotion is op-logged as reschedule_element (carrying the cardReStabilize marker).
    expect(opCount(handle, cardId, "reschedule_element")).toBe(1);

    // The body change landed.
    expect(result.card.answer).toBe("A materially rewritten answer.");
  });

  it("keep-schedule (no re-stabilize arg) changes the body but not the schedule and writes no marker", () => {
    const { cardId } = seedCard(handle);
    matureCard(handle, cardId);
    const service = new CardEditService(handle.db);
    const review = new ReviewRepository(handle.db);
    const dueBefore = review.findReviewState(cardId)?.dueAt;
    const logsBefore = review.listReviewLogs(cardId).length;

    const result = service.updateBody(cardId, { answer: "Kept-schedule edit." });

    expect(result.reStabilized).toBeNull();
    expect(review.findReviewState(cardId)?.dueAt).toBe(dueBefore);
    expect(review.listReviewLogs(cardId).length).toBe(logsBefore);
    expect(opCount(handle, cardId, "reschedule_element")).toBe(0);
  });

  it("returns null re-stabilize for a new / never-reviewed card (nothing to demote)", () => {
    const { cardId } = seedCard(handle);
    // A freshly seeded card has reps 0 → resolveReStabilize is null.
    expect(resolveReStabilize(handle, cardId, NOW)).toBeNull();
  });

  it("undo restores the EXACT prior FSRS tuple, keeps the body edited, and is guarded", () => {
    const { cardId } = seedCard(handle);
    matureCard(handle, cardId);
    const service = new CardEditService(handle.db);
    const review = new ReviewRepository(handle.db);
    const before = review.findReviewState(cardId);

    const reStabilize = resolveReStabilize(handle, cardId, NOW);
    const result = service.updateBody(cardId, { answer: "Rewritten." }, reStabilize);
    const reviewLogId = result.reStabilized?.reviewLogId ?? "";

    const undo = service.undoReStabilize(cardId, reviewLogId);
    expect(undo.undone).toBe(true);

    const restored = review.findReviewState(cardId);
    expect(restored?.dueAt).toBe(before?.dueAt);
    expect(restored?.stability).toBe(before?.stability);
    expect(restored?.difficulty).toBe(before?.difficulty);
    expect(restored?.reps).toBe(before?.reps);
    expect(restored?.lapses).toBe(before?.lapses);
    expect(restored?.fsrsState).toBe(before?.fsrsState);
    // elements.due_at mirrors the restore.
    const el = handle.db.select().from(elements).where(eq(elements.id, cardId)).get();
    expect(el?.dueAt).toBe(before?.dueAt);
    // Body text stays edited (undo reverses the SCHEDULE, not the rewrite).
    expect(review.findCardById(cardId)?.card.answer).toBe("Rewritten.");
    // The marker row survives (append-only).
    expect(markerRowFor(handle, reviewLogId)).toBeDefined();
  });

  it("undo is refused after the card is reviewed since the edit (newer FSRS intent wins)", () => {
    const { cardId } = seedCard(handle);
    matureCard(handle, cardId);
    const service = new CardEditService(handle.db);

    const reStabilize = resolveReStabilize(handle, cardId, NOW);
    const result = service.updateBody(cardId, { answer: "Rewritten." }, reStabilize);
    const reviewLogId = result.reStabilized?.reviewLogId ?? "";

    // A real grade lands after the edit, advancing FSRS state past the demotion.
    gradeCard(handle, cardId, "good", "2026-06-16T00:00:00.000Z" as IsoTimestamp);

    const undo = service.undoReStabilize(cardId, reviewLogId);
    expect(undo.undone).toBe(false);
    expect(undo.reason).toMatch(/reviewed/i);
  });

  it("in-flight: a grade landing after a re-stabilize lands cleanly and does not throw the stale-preimage guard", () => {
    const { cardId } = seedCard(handle);
    matureCard(handle, cardId);
    const service = new CardEditService(handle.db);
    const review = new ReviewRepository(handle.db);

    const reStabilize = resolveReStabilize(handle, cardId, NOW);
    service.updateBody(cardId, { answer: "Rewritten." }, reStabilize);

    // The grade reads the CURRENT (demoted) state fresh → no stale-preimage throw.
    expect(() =>
      gradeCard(handle, cardId, "good", "2026-06-16T00:00:00.000Z" as IsoTimestamp),
    ).not.toThrow();
    // The card advanced from the demoted state on a real grade.
    const after = review.findReviewState(cardId);
    expect(after?.lastReviewedAt).toBe("2026-06-16T00:00:00.000Z");
  });

  it("undo is refused on a soft-deleted card (no restoring a schedule onto trash)", () => {
    const { cardId } = seedCard(handle);
    matureCard(handle, cardId);
    const service = new CardEditService(handle.db);
    const result = service.updateBody(
      cardId,
      { answer: "Rewritten." },
      resolveReStabilize(handle, cardId, NOW),
    );
    const reviewLogId = result.reStabilized?.reviewLogId ?? "";

    service.delete(cardId); // soft-delete

    const undo = service.undoReStabilize(cardId, reviewLogId);
    expect(undo.undone).toBe(false);
    expect(undo.reason).toMatch(/not available/i);
  });

  it("undo of the FIRST marker is refused once a SECOND re-stabilization exists", () => {
    const { cardId } = seedCard(handle);
    matureCard(handle, cardId);
    const service = new CardEditService(handle.db);
    const review = new ReviewRepository(handle.db);

    const r1 = service.updateBody(
      cardId,
      { answer: "First rewrite." },
      resolveReStabilize(handle, cardId, NOW),
    );
    const firstLogId = r1.reStabilized?.reviewLogId ?? "";

    const later = "2026-06-15T00:00:01.000Z" as IsoTimestamp;
    const r2 = service.updateBody(
      cardId,
      { answer: "Second rewrite." },
      resolveReStabilize(handle, cardId, later),
    );
    const secondLogId = r2.reStabilized?.reviewLogId ?? "";
    expect(review.listReviewLogs(cardId).filter((l) => l.editMarkerAt != null)).toHaveLength(2);

    // Undoing the FIRST marker must be refused (it would revert past BOTH demotions).
    const undoFirst = service.undoReStabilize(cardId, firstLogId);
    expect(undoFirst.undone).toBe(false);
    expect(undoFirst.reason).toMatch(/newer re-stabilization/i);

    // Undoing the LATEST marker is allowed (restores its own preimage).
    expect(service.undoReStabilize(cardId, secondLogId).undone).toBe(true);
  });

  it("a repeated undo of the same marker reports 'already restored', not 'reviewed since'", () => {
    const { cardId } = seedCard(handle);
    matureCard(handle, cardId);
    const service = new CardEditService(handle.db);
    const result = service.updateBody(
      cardId,
      { answer: "Rewritten." },
      resolveReStabilize(handle, cardId, NOW),
    );
    const reviewLogId = result.reStabilized?.reviewLogId ?? "";

    expect(service.undoReStabilize(cardId, reviewLogId).undone).toBe(true);
    const second = service.undoReStabilize(cardId, reviewLogId);
    expect(second.undone).toBe(false);
    expect(second.reason).toMatch(/already restored/i);
  });

  it("re-stabilizes a suspended card's persisted state without un-suspending it", () => {
    const { cardId } = seedCard(handle);
    matureCard(handle, cardId);
    const service = new CardEditService(handle.db);
    const review = new ReviewRepository(handle.db);
    service.suspend(cardId);

    const result = service.updateBody(
      cardId,
      { answer: "Rewritten." },
      resolveReStabilize(handle, cardId, NOW),
    );
    expect(result.reStabilized).not.toBeNull();
    expect(review.findReviewState(cardId)?.stability).toBeLessThanOrEqual(1);
    // The card stays suspended (the demotion never resurrects it).
    expect(new ElementRepository(handle.db).findById(cardId)?.status).toBe("suspended");
  });
});
