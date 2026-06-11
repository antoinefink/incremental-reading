/**
 * PriorityIntegrityQuery tests (T105).
 *
 * This read model is a receipt over existing facts only: attention reschedules,
 * FSRS review logs, current elements/cards, and operation-log postpone markers.
 * The tests intentionally seed those durable rows directly so the semantics stay
 * pinned to the stored contract instead of one particular service path.
 */

import type { ElementId, IsoTimestamp, PriorityLabel } from "@interleave/core";
import { priorityFromLabel } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { cards, elements, operationLog, reviewLogs, reviewStates } from "@interleave/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ElementRepository } from "./element-repository";
import { newOperationId, newReviewLogId } from "./ids";
import { PriorityIntegrityQuery } from "./priority-integrity-query";
import { createInMemoryDb } from "./test-db";

let handle: DbHandle;
let repo: ElementRepository;

function localInstant(
  year: number,
  month: number,
  day: number,
  hour = 12,
  minute = 0,
): IsoTimestamp {
  return new Date(year, month, day, hour, minute, 0, 0).toISOString() as IsoTimestamp;
}

function seedElement(
  title: string,
  band: PriorityLabel,
  opts: {
    readonly type?: "source" | "topic" | "extract" | "card";
    readonly status?: "active" | "scheduled" | "parked" | "done";
    readonly sourceId?: ElementId | null;
    readonly dueAt?: IsoTimestamp | null;
  } = {},
): ElementId {
  const type = opts.type ?? "extract";
  const element = repo.create({
    type,
    status: opts.status ?? "scheduled",
    stage:
      type === "card"
        ? "active_card"
        : type === "source"
          ? "raw_source"
          : type === "topic"
            ? "rough_topic"
            : "raw_extract",
    priority: priorityFromLabel(band),
    title,
    sourceId: opts.sourceId ?? null,
    dueAt: opts.dueAt ?? null,
  });
  if (type === "card") {
    handle.db.insert(cards).values({ elementId: element.id, kind: "qa" }).run();
    handle.db
      .insert(reviewStates)
      .values({ elementId: element.id, fsrsState: "review", dueAt: opts.dueAt ?? null })
      .run();
  }
  return element.id;
}

function appendOp(
  elementId: ElementId,
  opType: "reschedule_element" | "update_element",
  payload: Record<string, unknown>,
  createdAt: IsoTimestamp,
): void {
  handle.db
    .insert(operationLog)
    .values({
      id: newOperationId(),
      opType,
      elementId,
      payload: JSON.stringify(payload),
      createdAt,
    })
    .run();
}

function appendReview(elementId: ElementId, reviewedAt: IsoTimestamp): void {
  handle.db
    .insert(reviewLogs)
    .values({
      id: newReviewLogId(),
      elementId,
      rating: "good",
      reviewedAt,
      responseMs: 900,
      prevState: "review",
      nextState: "review",
      nextStability: 10,
      nextDifficulty: 5,
      nextDueAt: reviewedAt,
    })
    .run();
}

beforeEach(() => {
  handle = createInMemoryDb();
  repo = new ElementRepository(handle.db);
});

afterEach(() => {
  handle.sqlite.close();
});

describe("PriorityIntegrityQuery.compute", () => {
  it("returns an empty four-band receipt without appending operation_log rows", () => {
    const asOf = localInstant(2026, 5, 11, 18);
    const before = handle.db.select().from(operationLog).all().length;

    const summary = new PriorityIntegrityQuery(handle.db).compute(asOf);

    expect(summary.priorityAttribution).toBe("current");
    expect(summary.windowDays).toBe(30);
    expect(summary.bands.map((band) => band.band)).toEqual(["A", "B", "C", "D"]);
    expect(summary.bands.every((band) => band.totalEvents === 0)).toBe(true);
    expect(summary.thresholdFlags).toEqual({
      aBandInflation: false,
      aBandDeferredRecently: false,
      postponeDebtHigh: false,
    });
    expect(summary.topics).toEqual([]);
    expect(summary.sacrificed).toEqual([]);
    expect(handle.db.select().from(operationLog).all()).toHaveLength(before);
  });

  it("summarizes attention service, FSRS service, deferrals, debt, and source anchors", () => {
    const asOf = localInstant(2026, 5, 11, 18);
    const sourceId = seedElement("Networking paper", "A", { type: "source", status: "active" });
    const extractId = seedElement("Atomic note", "A", { sourceId });
    const cardId = seedElement("Recall TCP", "B", { type: "card", sourceId });

    appendOp(
      extractId,
      "reschedule_element",
      { id: extractId, action: "extract", dueAt: localInstant(2026, 5, 12) },
      localInstant(2026, 5, 10, 9),
    );
    appendOp(
      extractId,
      "reschedule_element",
      {
        id: extractId,
        postpone: true,
        prevDueAt: localInstant(2026, 5, 9),
        dueAt: localInstant(2026, 5, 25, 10),
      },
      localInstant(2026, 5, 10, 10),
    );
    appendReview(cardId, localInstant(2026, 5, 10, 11));

    const before = handle.db.select().from(operationLog).all().length;
    const summary = new PriorityIntegrityQuery(handle.db).compute(asOf);

    const aBand = summary.bands.find((band) => band.band === "A");
    const bBand = summary.bands.find((band) => band.band === "B");
    expect(aBand).toMatchObject({
      attentionServiced: 1,
      deferred: 1,
      totalEvents: 2,
      postponeDebtDays: 15,
      liveCount: 2,
    });
    expect(aBand?.serviceRate).toBe(0.5);
    expect(bBand).toMatchObject({ fsrsServiced: 1, totalEvents: 1, liveCount: 1 });
    expect(summary.thresholdFlags).toEqual({
      aBandInflation: true,
      aBandDeferredRecently: true,
      postponeDebtHigh: true,
    });
    expect(summary.topics).toEqual([
      {
        anchorId: sourceId,
        title: "Networking paper",
        type: "source",
        band: "A",
        attentionServiced: 1,
        fsrsServiced: 1,
        deferred: 1,
        postponeDebtDays: 15,
      },
    ]);
    expect(summary.sacrificed).toEqual([
      {
        id: extractId,
        title: "Atomic note",
        type: "extract",
        band: "A",
        scheduler: "attention",
        postponeCount: 1,
        postponeDebtDays: 15,
        latestDeferredAt: localInstant(2026, 5, 10, 10),
        topicAnchorId: sourceId,
        topicTitle: "Networking paper",
      },
    ]);
    expect(handle.db.select().from(operationLog).all()).toHaveLength(before);
  });

  it("excludes future-due, parked, deleted, and retired postponed rows", () => {
    const asOf = localInstant(2026, 5, 11, 18);
    const futureDue = seedElement("Future due", "A");
    const parked = seedElement("Parked", "A", { status: "parked" });
    const deleted = seedElement("Deleted", "A");
    repo.softDelete(deleted);
    const retiredCard = seedElement("Retired card", "A", { type: "card" });
    handle.db.update(cards).set({ isRetired: true }).where(eq(cards.elementId, retiredCard)).run();

    appendOp(
      futureDue,
      "reschedule_element",
      {
        id: futureDue,
        postpone: true,
        prevDueAt: localInstant(2026, 5, 12),
        dueAt: localInstant(2026, 5, 20),
      },
      localInstant(2026, 5, 10, 10),
    );
    for (const id of [parked, deleted]) {
      appendOp(
        id,
        "reschedule_element",
        {
          id,
          postpone: true,
          prevDueAt: localInstant(2026, 5, 9),
          dueAt: localInstant(2026, 5, 20),
        },
        localInstant(2026, 5, 10, 10),
      );
    }
    appendOp(
      retiredCard,
      "reschedule_element",
      {
        id: retiredCard,
        postpone: true,
        cardDefer: true,
        prevReviewDueAt: localInstant(2026, 5, 9),
        dueAt: localInstant(2026, 5, 20),
      },
      localInstant(2026, 5, 10, 10),
    );

    const summary = new PriorityIntegrityQuery(handle.db).compute(asOf);

    expect(summary.bands.find((band) => band.band === "A")?.deferred).toBe(0);
    expect(summary.sacrificed).toEqual([]);
    expect(summary.thresholdFlags.aBandDeferredRecently).toBe(false);
  });

  it("counts historical service events after an attention item becomes done", () => {
    const asOf = localInstant(2026, 5, 11, 18);
    const taskId = seedElement("Verify claim", "A", {
      type: "topic",
      status: "done",
      dueAt: null,
    });
    appendOp(
      taskId,
      "reschedule_element",
      {
        id: taskId,
        action: "done",
        prevDueAt: localInstant(2026, 5, 10, 9),
        dueAt: null,
        status: "done",
      },
      localInstant(2026, 5, 10, 10),
    );

    const summary = new PriorityIntegrityQuery(handle.db).compute(asOf);

    expect(summary.bands.find((band) => band.band === "A")?.attentionServiced).toBe(1);
    expect(summary.bands.find((band) => band.band === "A")?.liveCount).toBe(0);
  });

  it("counts unmarked due attention reschedules as service but ignores initial scheduling", () => {
    const asOf = localInstant(2026, 5, 11, 18);
    const dueExtract = seedElement("Due extract", "B");
    const newExtract = seedElement("New extract", "B");
    appendOp(
      dueExtract,
      "reschedule_element",
      {
        id: dueExtract,
        prevDueAt: localInstant(2026, 5, 10, 9),
        dueAt: localInstant(2026, 5, 12, 10),
        status: "scheduled",
      },
      localInstant(2026, 5, 10, 10),
    );
    appendOp(
      newExtract,
      "reschedule_element",
      {
        id: newExtract,
        prevDueAt: null,
        dueAt: localInstant(2026, 5, 12, 10),
        status: "scheduled",
      },
      localInstant(2026, 5, 10, 10),
    );

    const summary = new PriorityIntegrityQuery(handle.db).compute(asOf);

    expect(summary.bands.find((band) => band.band === "B")?.attentionServiced).toBe(1);
  });

  it("counts live FSRS deferrals with review preimages and malformed deferrals with zero debt", () => {
    const asOf = localInstant(2026, 5, 11, 18);
    const cardId = seedElement("Deferred card", "B", { type: "card" });
    const extractId = seedElement("Malformed defer", "B");
    appendOp(
      cardId,
      "reschedule_element",
      {
        id: cardId,
        postpone: true,
        cardDefer: true,
        prevReviewDueAt: localInstant(2026, 5, 9, 10),
        dueAt: localInstant(2026, 5, 15, 10),
      },
      localInstant(2026, 5, 10, 10),
    );
    appendOp(
      extractId,
      "reschedule_element",
      {
        id: extractId,
        postpone: true,
        prevDueAt: "not-a-date",
        dueAt: "also-not-a-date",
      },
      localInstant(2026, 5, 10, 10),
    );

    const summary = new PriorityIntegrityQuery(handle.db).compute(asOf);

    expect(summary.bands.find((band) => band.band === "B")).toMatchObject({
      deferred: 2,
      postponeDebtDays: 5,
    });
    expect(summary.sacrificed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: cardId,
          scheduler: "fsrs",
          postponeDebtDays: 5,
        }),
        expect.objectContaining({
          id: extractId,
          scheduler: "attention",
          postponeDebtDays: 0,
        }),
      ]),
    );
  });

  it("attributes to current priority while suppressing strong A-defer warnings after priority edits", () => {
    const asOf = localInstant(2026, 5, 11, 18);
    const extractId = seedElement("Recently promoted", "C");
    appendOp(
      extractId,
      "reschedule_element",
      {
        id: extractId,
        postpone: true,
        prevDueAt: localInstant(2026, 5, 9),
        dueAt: localInstant(2026, 5, 15),
      },
      localInstant(2026, 5, 10, 10),
    );
    handle.db
      .update(elements)
      .set({ priority: priorityFromLabel("A") })
      .where(eq(elements.id, extractId))
      .run();
    appendOp(
      extractId,
      "update_element",
      {
        id: extractId,
        patch: { priority: priorityFromLabel("A") },
        prev: { priority: priorityFromLabel("C") },
      },
      localInstant(2026, 5, 10, 11),
    );

    const summary = new PriorityIntegrityQuery(handle.db).compute(asOf);

    expect(summary.bands.find((band) => band.band === "A")?.deferred).toBe(1);
    expect(summary.thresholdFlags.aBandDeferredRecently).toBe(false);
  });
});
