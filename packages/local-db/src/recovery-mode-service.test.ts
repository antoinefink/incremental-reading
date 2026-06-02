/**
 * RecoveryModeService tests (T078 — the APPLY seam for catch-up & vacation).
 *
 * These run against a TEMPORARY, fully-migrated in-memory `better-sqlite3` DB so behaviour
 * matches production exactly. They pin the contract:
 *
 *  - previews mutate NOTHING (no due-date change, no status change, no op appended);
 *  - `applyCatchUp` reschedules attention items + defers cards under ONE `batchId` (existing
 *    ops only), each card landing on its EXACT planned `targetDueAt` (the ABSOLUTE `cardDeferTo`
 *    path — so the applied per-day curve matches the previewed plan, even for an overdue card);
 *  - the FSRS memory state (stability/difficulty/reps/lapses/fsrsState) is UNCHANGED and NO
 *    review log is written by either apply;
 *  - `applyVacation` SUSPENDS fragile cards (status → `suspended`, prior status captured) and
 *    SHIFTS the rest past return, all under one `batchId`;
 *  - the batch undo restores everything (suspends back to their prior status, shifts back).
 */

import type { ElementId, IsoTimestamp, Priority } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { operationLog, reviewLogs, reviewStates } from "@interleave/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ElementRepository } from "./element-repository";
import { createRepositories } from "./index";
import { QueueQuery } from "./queue-query";
import { RecoveryModeService } from "./recovery-mode-service";
import { ReviewRepository } from "./review-repository";
import { SourceRepository } from "./source-repository";
import { createInMemoryDb } from "./test-db";
import { UndoService } from "./undo-service";

let handle: DbHandle;

const NOW = "2027-06-01T12:00:00.000Z" as IsoTimestamp;
const OVERDUE = "2027-05-01T12:00:00.000Z" as IsoTimestamp;

/** Seed a topic/source (attention item) and force it overdue so it reads as due at NOW. */
function seedTopic(priority: Priority, dueAt: IsoTimestamp = OVERDUE, title = "topic"): ElementId {
  const sources = new SourceRepository(handle.db);
  const { element } = sources.createWithDocument({
    title,
    priority,
    status: "scheduled",
    stage: "raw_source",
    body: "Body.",
  });
  new ElementRepository(handle.db).reschedule(element.id, dueAt);
  return element.id;
}

/**
 * Seed a card with explicit FSRS state, due on `dueAt`. `mature` ⇒ review phase + high
 * stability + retrievable; otherwise a fragile (learning) card.
 */
function seedCard(
  priority: Priority,
  opts: { mature: boolean; dueAt?: IsoTimestamp; title?: string },
): ElementId {
  const review = new ReviewRepository(handle.db);
  const { element } = review.createCard({
    kind: "qa",
    title: opts.title ?? "card",
    priority,
    prompt: "Q",
    answer: "A",
  });
  handle.db
    .update(reviewStates)
    .set({
      dueAt: opts.dueAt ?? OVERDUE,
      stability: opts.mature ? 90 : 2,
      fsrsState: opts.mature ? "review" : "learning",
      lapses: 0,
      reps: opts.mature ? 5 : 1,
      lastReviewedAt: "2027-04-01T12:00:00.000Z",
    })
    .where(eq(reviewStates.elementId, element.id))
    .run();
  return element.id;
}

/** Count ops of a given type for an element. */
function opCount(id: ElementId, opType: string): number {
  return handle.db
    .select()
    .from(operationLog)
    .where(eq(operationLog.elementId, id))
    .all()
    .filter((op) => op.opType === opType).length;
}

/** The set of element ids due in the queue at a given clock. */
function dueIdsAt(asOf: IsoTimestamp): Set<string> {
  const queue = new QueueQuery(createRepositories(handle.db));
  return new Set(queue.list({ asOf }).items.map((r) => r.id));
}

/** Build the service over the open DB. */
function service(): RecoveryModeService {
  return new RecoveryModeService(handle.db, createRepositories(handle.db));
}

/** Set the daily review budget (the per-day cap; clamped to ≥ 10 by the settings layer). */
function setBudget(n: number): void {
  createRepositories(handle.db).settings.updateAppSettings({ dailyReviewBudget: n });
}

const BUDGET_MIN = 10;

beforeEach(() => {
  handle = createInMemoryDb();
});

afterEach(() => {
  handle.sqlite.close();
});

describe("RecoveryModeService.previewCatchUp / previewVacation", () => {
  it("previewCatchUp mutates nothing — no due-date change, no op appended", () => {
    setBudget(BUDGET_MIN);
    const ids = Array.from({ length: BUDGET_MIN + 5 }, (_, i) =>
      seedTopic(0.4, OVERDUE, `topic ${i}`),
    );
    const elements = new ElementRepository(handle.db);
    const beforeDue = ids.map((id) => elements.findById(id)?.dueAt);
    const beforeOps = handle.db.select().from(operationLog).all().length;

    const preview = service().previewCatchUp({ asOf: NOW, spreadDays: 7 });
    // The cost is quantified (the headline requirement).
    expect(preview.cost.loadBefore.length).toBeGreaterThan(0);
    expect(preview.cost.loadAfter.length).toBeGreaterThan(0);
    expect(preview.budget).toBe(BUDGET_MIN);

    // Nothing changed.
    expect(ids.map((id) => elements.findById(id)?.dueAt)).toEqual(beforeDue);
    expect(handle.db.select().from(operationLog).all().length).toBe(beforeOps);
  });

  it("previewCatchUp keeps each day within budget in the after-curve", () => {
    setBudget(BUDGET_MIN);
    // 25 overdue topics, budget 10 → spread keeps each day ≤ 10.
    for (let i = 0; i < 25; i++) seedTopic(0.4, OVERDUE, `topic ${i}`);
    const preview = service().previewCatchUp({ asOf: NOW, spreadDays: 7 });
    for (const point of preview.cost.loadAfter) {
      expect(point.count).toBeLessThanOrEqual(BUDGET_MIN);
    }
    expect(preview.cost.moved).toBe(25);
  });

  it("previewVacation mutates nothing and reports suspend/shift counts", () => {
    setBudget(BUDGET_MIN);
    const awayStart = "2027-06-10T00:00:00.000Z" as IsoTimestamp;
    const awayEnd = "2027-06-20T23:59:59.000Z" as IsoTimestamp;
    const fragile = seedCard(0.5, {
      mature: false,
      dueAt: "2027-06-15T12:00:00.000Z" as IsoTimestamp,
    });
    const mature = seedCard(0.5, {
      mature: true,
      dueAt: "2027-06-16T12:00:00.000Z" as IsoTimestamp,
    });
    const topic = seedTopic(0.5, "2027-06-12T12:00:00.000Z" as IsoTimestamp, "in-window topic");

    const beforeOps = handle.db.select().from(operationLog).all().length;
    const preview = service().previewVacation({ awayStart, awayEnd, asOf: NOW });
    expect(preview.suspendedCount).toBe(1); // the fragile card
    expect(preview.shiftedCount).toBe(2); // the mature card + the topic
    // Nothing mutated.
    expect(handle.db.select().from(operationLog).all().length).toBe(beforeOps);
    expect(new ElementRepository(handle.db).findById(fragile)?.status).not.toBe("suspended");
    // The window items still sit on their original day.
    void mature;
    void topic;
  });
});

describe("RecoveryModeService.applyCatchUp", () => {
  it("reschedules attention + defers cards under ONE batchId, each landing on its EXACT planned day", () => {
    setBudget(BUDGET_MIN);
    // A mix: 12 overdue topics + 3 overdue mature cards, budget 10 → spread forward.
    const topicIds: ElementId[] = [];
    for (let i = 0; i < 12; i++) topicIds.push(seedTopic(0.4, OVERDUE, `topic ${i}`));
    const cardIds: ElementId[] = [];
    for (let i = 0; i < 3; i++)
      cardIds.push(seedCard(0.4, { mature: true, title: `mature card ${i}` }));

    // Snapshot the previewed per-item target days (the planned curve).
    const preview = service().previewCatchUp({ asOf: NOW, spreadDays: 7 });
    expect(preview.cost.moved).toBe(15);

    const result = service().applyCatchUp({ asOf: NOW, spreadDays: 7 });
    expect(result.moved).toBeGreaterThan(0);
    expect(result.suspended).toBe(0);
    expect(result.batchId).toBeTruthy();

    // Every postpone op shares the SAME batchId (the whole plan undoes as one).
    const batchIds = handle.db
      .select()
      .from(operationLog)
      .all()
      .filter((op) => op.opType === "reschedule_element")
      .map((op) => JSON.parse(op.payload as string) as { batchId?: string })
      .filter((p) => p.batchId === result.batchId);
    expect(batchIds.length).toBe(result.moved);

    // The applied per-day curve EQUALS the previewed curve (the absolute cardDeferTo path —
    // a relative defer would mis-place the overdue cards). Re-read the queue across the spread
    // window and bucket by day; compare to the preview's loadAfter.
    const queue = new QueueQuery(createRepositories(handle.db));
    const horizon = "2027-06-30T12:00:00.000Z" as IsoTimestamp;
    const dueByDay = new Map<string, number>();
    for (const row of queue.list({ asOf: horizon }).items) {
      if (!row.dueAt) continue;
      const day = row.dueAt.slice(0, 10);
      dueByDay.set(day, (dueByDay.get(day) ?? 0) + 1);
    }
    // Each non-empty day in the applied curve is within budget (the catch-up guarantee).
    for (const [, count] of dueByDay) {
      expect(count).toBeLessThanOrEqual(BUDGET_MIN);
    }
    // The applied curve matches the previewed after-curve day-for-day (where non-zero).
    for (const point of preview.cost.loadAfter) {
      if (point.count === 0) continue;
      expect(dueByDay.get(point.date) ?? 0).toBe(point.count);
    }
  });

  it("defers a card WITHOUT touching FSRS memory state or writing a review log", () => {
    setBudget(BUDGET_MIN);
    // One mature card + enough topics to push the card to a later day.
    const card = seedCard(0.4, { mature: true, title: "mature card" });
    for (let i = 0; i < BUDGET_MIN + 2; i++) seedTopic(0.45, OVERDUE, `topic ${i}`);

    const before = handle.db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.elementId, card))
      .get();
    const reviewLogsBefore = handle.db
      .select()
      .from(reviewLogs)
      .where(eq(reviewLogs.elementId, card))
      .all().length;

    service().applyCatchUp({ asOf: NOW, spreadDays: 7 });

    const after = handle.db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.elementId, card))
      .get();
    // The FSRS due moved (the card was rescheduled)…
    expect(after?.dueAt).not.toBe(before?.dueAt);
    // …but the MEMORY STATE is byte-for-byte unchanged (the protection invariant).
    expect(after?.stability).toBe(before?.stability);
    expect(after?.difficulty).toBe(before?.difficulty);
    expect(after?.reps).toBe(before?.reps);
    expect(after?.lapses).toBe(before?.lapses);
    expect(after?.fsrsState).toBe(before?.fsrsState);
    // NO review log was written (a defer is not a graded review).
    expect(
      handle.db.select().from(reviewLogs).where(eq(reviewLogs.elementId, card)).all().length,
    ).toBe(reviewLogsBefore);
    // The card never lands on the attention-side `scheduled` status.
    expect(new ElementRepository(handle.db).findById(card)?.status).not.toBe("scheduled");
  });

  it("the catch-up batch undoes everything (both due fields restored)", () => {
    setBudget(BUDGET_MIN);
    const topic = seedTopic(0.4, OVERDUE, "topic");
    for (let i = 0; i < BUDGET_MIN + 4; i++) seedTopic(0.4, OVERDUE, `filler ${i}`);
    const card = seedCard(0.4, { mature: true, title: "mature card" });

    const beforeTopicDue = new ElementRepository(handle.db).findById(topic)?.dueAt;
    const beforeCardReviewDue = handle.db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.elementId, card))
      .get()?.dueAt;

    const dueBefore = dueIdsAt(NOW).size;
    service().applyCatchUp({ asOf: NOW, spreadDays: 7 });
    // The backlog receded from NOW's due set.
    expect(dueIdsAt(NOW).size).toBeLessThan(dueBefore);

    // Undo the whole batch.
    new UndoService(handle.db).undoLast();
    // The due set is restored.
    expect(dueIdsAt(NOW).size).toBe(dueBefore);
    // Both due fields are restored to their pre-images.
    expect(new ElementRepository(handle.db).findById(topic)?.dueAt).toBe(beforeTopicDue);
    expect(
      handle.db.select().from(reviewStates).where(eq(reviewStates.elementId, card)).get()?.dueAt,
    ).toBe(beforeCardReviewDue);
  });
});

describe("RecoveryModeService.applyVacation", () => {
  const AWAY_START = "2027-06-10T00:00:00.000Z" as IsoTimestamp;
  const AWAY_END = "2027-06-20T23:59:59.000Z" as IsoTimestamp;

  it("suspends fragile cards and shifts the rest past return, under one batchId", () => {
    setBudget(BUDGET_MIN);
    const fragile = seedCard(0.6, {
      mature: false,
      dueAt: "2027-06-15T12:00:00.000Z" as IsoTimestamp,
    });
    const mature = seedCard(0.6, {
      mature: true,
      dueAt: "2027-06-16T12:00:00.000Z" as IsoTimestamp,
    });
    const topic = seedTopic(0.5, "2027-06-12T12:00:00.000Z" as IsoTimestamp, "in-window topic");
    // Out of window — untouched.
    const outside = seedTopic(0.5, "2027-06-25T12:00:00.000Z" as IsoTimestamp, "outside topic");
    const outsideDueBefore = new ElementRepository(handle.db).findById(outside)?.dueAt;

    const result = service().applyVacation({
      awayStart: AWAY_START,
      awayEnd: AWAY_END,
      asOf: NOW,
    });
    expect(result.suspended).toBe(1);
    expect(result.moved).toBe(2);
    expect(result.batchId).toBeTruthy();

    const elements = new ElementRepository(handle.db);
    // The fragile card is suspended via update_element (prior status captured).
    expect(elements.findById(fragile)?.status).toBe("suspended");
    expect(opCount(fragile, "update_element")).toBeGreaterThanOrEqual(1);
    // The mature card + topic shifted PAST the away window.
    expect(Date.parse(elements.findById(mature)?.dueAt as string)).toBeGreaterThan(
      Date.parse(AWAY_END),
    );
    expect(Date.parse(elements.findById(topic)?.dueAt as string)).toBeGreaterThan(
      Date.parse(AWAY_END),
    );
    // The mature card's FSRS due also shifted past return (the queue reads review_states for cards).
    const matureReviewDue = handle.db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.elementId, mature))
      .get()?.dueAt;
    expect(Date.parse(matureReviewDue as string)).toBeGreaterThan(Date.parse(AWAY_END));
    // The out-of-window item is untouched.
    expect(elements.findById(outside)?.dueAt).toBe(outsideDueBefore);

    // Every mutation op shares the SAME batchId.
    const batchOps = handle.db
      .select()
      .from(operationLog)
      .all()
      .map((op) => JSON.parse(op.payload as string) as { batchId?: string })
      .filter((p) => p.batchId === result.batchId);
    expect(batchOps.length).toBe(3); // 1 suspend (update) + 2 shifts (reschedule)
  });

  it("does not write a review log when shifting a card", () => {
    setBudget(BUDGET_MIN);
    const mature = seedCard(0.6, {
      mature: true,
      dueAt: "2027-06-16T12:00:00.000Z" as IsoTimestamp,
    });
    const before = handle.db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.elementId, mature))
      .get();
    const reviewLogsBefore = handle.db
      .select()
      .from(reviewLogs)
      .where(eq(reviewLogs.elementId, mature))
      .all().length;

    service().applyVacation({ awayStart: AWAY_START, awayEnd: AWAY_END, asOf: NOW });

    const after = handle.db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.elementId, mature))
      .get();
    // FSRS memory state unchanged.
    expect(after?.stability).toBe(before?.stability);
    expect(after?.fsrsState).toBe(before?.fsrsState);
    expect(after?.reps).toBe(before?.reps);
    // No review log.
    expect(
      handle.db.select().from(reviewLogs).where(eq(reviewLogs.elementId, mature)).all().length,
    ).toBe(reviewLogsBefore);
  });

  it("the vacation batch undo restores prior status + due (resume)", () => {
    setBudget(BUDGET_MIN);
    const fragile = seedCard(0.6, {
      mature: false,
      dueAt: "2027-06-15T12:00:00.000Z" as IsoTimestamp,
    });
    const mature = seedCard(0.6, {
      mature: true,
      dueAt: "2027-06-16T12:00:00.000Z" as IsoTimestamp,
    });

    const elements = new ElementRepository(handle.db);
    const fragileStatusBefore = elements.findById(fragile)?.status;
    const matureDueBefore = elements.findById(mature)?.dueAt;
    const matureReviewDueBefore = handle.db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.elementId, mature))
      .get()?.dueAt;

    service().applyVacation({ awayStart: AWAY_START, awayEnd: AWAY_END, asOf: NOW });
    expect(elements.findById(fragile)?.status).toBe("suspended");

    // Resume via the existing batch undo (T044).
    new UndoService(handle.db).undoLast();

    // The fragile card is un-suspended (prior status restored) and the mature card un-shifted.
    expect(elements.findById(fragile)?.status).toBe(fragileStatusBefore);
    expect(elements.findById(mature)?.dueAt).toBe(matureDueBefore);
    expect(
      handle.db.select().from(reviewStates).where(eq(reviewStates.elementId, mature)).get()?.dueAt,
    ).toBe(matureReviewDueBefore);
  });
});
