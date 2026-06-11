import { type ElementId, type IsoTimestamp, priorityFromLabel } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { reviewStates } from "@interleave/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRepositories, type Repositories } from "./index";
import { createInMemoryDb } from "./test-db";
import { UndoService } from "./undo-service";

let handle: DbHandle;
let repos: Repositories;
let undo: UndoService;

const NOW = "2026-06-11T08:00:00.000Z" as IsoTimestamp;
const RETURN = "2026-07-01T00:00:00.000Z" as IsoTimestamp;
const EARLIER_RETURN = "2026-06-20T00:00:00.000Z" as IsoTimestamp;
const DUE = "2026-06-10T00:00:00.000Z" as IsoTimestamp;
const LATER = "2026-08-01T00:00:00.000Z" as IsoTimestamp;

beforeEach(() => {
  handle = createInMemoryDb();
  repos = createRepositories(handle.db);
  undo = new UndoService(handle.db);
});

afterEach(() => {
  handle.sqlite.close();
});

function topic(title = "Restable topic"): ElementId {
  return repos.elements.create({
    type: "topic",
    status: "scheduled",
    stage: "rough_topic",
    priority: priorityFromLabel("B"),
    title,
    dueAt: DUE,
  }).id;
}

function extract(parentId: ElementId, title = "Topic extract", dueAt = DUE): ElementId {
  return repos.elements.create({
    type: "extract",
    status: "scheduled",
    stage: "raw_extract",
    priority: priorityFromLabel("B"),
    title,
    parentId,
    dueAt,
  }).id;
}

function card(parentId: ElementId): ElementId {
  return repos.review.createCard({
    kind: "qa",
    title: "Topic card",
    prompt: "Q",
    answer: "A",
    priority: priorityFromLabel("B"),
    stage: "active_card",
    parentId,
    firstScheduledAt: DUE,
  }).element.id;
}

function reviewDue(id: ElementId): IsoTimestamp | null {
  return (
    handle.db
      .select({ dueAt: reviewStates.dueAt })
      .from(reviewStates)
      .where(eq(reviewStates.elementId, id))
      .get()?.dueAt ?? null
  );
}

describe("FallowService", () => {
  it("fallows a topic and attention descendants without touching descendant card review state", () => {
    const topicId = topic();
    const extractId = extract(topicId);
    const cardId = card(topicId);

    const result = repos.fallow.fallowTopic({
      topicId,
      fallowUntil: RETURN,
      fallowReason: "Need a clean break",
      now: NOW,
    });

    expect(result).toMatchObject({ applied: 3, skipped: [] });
    expect(result.batchId).toBeTruthy();
    expect(repos.elements.findById(topicId)).toMatchObject({
      dueAt: RETURN,
      fallowUntil: RETURN,
      fallowReason: "Need a clean break",
      fallowBatchId: result.batchId,
    });
    expect(repos.elements.findById(extractId)?.dueAt).toBe(RETURN);
    expect(repos.elements.findById(cardId)?.dueAt).toBe(DUE);
    expect(reviewDue(cardId)).toBe(DUE);
    expect(
      repos.operationLog
        .listForElement(extractId)
        .some(
          (op) =>
            op.opType === "reschedule_element" &&
            (op.payload as { readonly fallow?: unknown }).fallow === true,
        ),
    ).toBe(true);
  });

  it("does not shorten attention descendants already scheduled after the return date", () => {
    const topicId = topic();
    const extractId = extract(topicId, "Later extract", LATER);

    repos.fallow.fallowTopic({ topicId, fallowUntil: RETURN, now: NOW });

    expect(repos.elements.findById(extractId)?.dueAt).toBe(LATER);
  });

  it("shortens descendants whose current due date is owned by the active fallow batch", () => {
    const topicId = topic();
    const extractId = extract(topicId);
    repos.fallow.fallowTopic({ topicId, fallowUntil: RETURN, now: NOW });

    const result = repos.fallow.fallowTopic({
      topicId,
      fallowUntil: EARLIER_RETURN,
      fallowReason: "Return sooner",
      now: NOW,
    });

    expect(result).toMatchObject({ applied: 3, skipped: [] });
    expect(repos.elements.findById(topicId)).toMatchObject({
      dueAt: EARLIER_RETURN,
      fallowUntil: EARLIER_RETURN,
      fallowReason: "Return sooner",
      fallowBatchId: result.batchId,
    });
    expect(repos.elements.findById(extractId)?.dueAt).toBe(EARLIER_RETURN);
  });

  it("does not refallow a descendant after newer manual schedule intent", () => {
    const topicId = topic();
    const extractId = extract(topicId);
    repos.fallow.fallowTopic({ topicId, fallowUntil: EARLIER_RETURN, now: NOW });
    repos.elements.reschedule(extractId, "2026-06-25T00:00:00.000Z" as IsoTimestamp);

    const result = repos.fallow.fallowTopic({ topicId, fallowUntil: RETURN, now: NOW });

    expect(result).toMatchObject({ applied: 2, skipped: [] });
    expect(repos.elements.findById(topicId)).toMatchObject({
      dueAt: RETURN,
      fallowUntil: RETURN,
      fallowBatchId: result.batchId,
    });
    expect(repos.elements.findById(extractId)?.dueAt).toBe("2026-06-25T00:00:00.000Z");
  });

  it("undoes the fallow batch as one command", () => {
    const topicId = topic();
    const extractId = extract(topicId);
    const result = repos.fallow.fallowTopic({ topicId, fallowUntil: RETURN, now: NOW });

    const undone = undo.undoLast();

    expect(result.batchId).toBeTruthy();
    expect(undone).toMatchObject({ undone: true, count: 3 });
    expect(repos.elements.findById(topicId)).toMatchObject({
      dueAt: DUE,
      fallowUntil: null,
      fallowReason: null,
      fallowBatchId: null,
    });
    expect(repos.elements.findById(extractId)?.dueAt).toBe(DUE);
  });

  it("direct unfallow restores schedules from the active fallow batch", () => {
    const topicId = topic();
    const extractId = extract(topicId);
    repos.fallow.fallowTopic({ topicId, fallowUntil: RETURN, now: NOW });

    const result = repos.fallow.unfallowTopic({ topicId });

    expect(result).toMatchObject({ skipped: [] });
    expect(result.applied).toBe(3);
    expect(repos.elements.findById(topicId)).toMatchObject({
      dueAt: DUE,
      fallowUntil: null,
      fallowReason: null,
      fallowBatchId: null,
    });
    expect(repos.elements.findById(extractId)?.dueAt).toBe(DUE);
  });

  it("direct unfallow after refallow restores the original pre-rest schedules", () => {
    const topicId = topic();
    const extractId = extract(topicId);
    repos.fallow.fallowTopic({ topicId, fallowUntil: RETURN, now: NOW });
    repos.fallow.fallowTopic({ topicId, fallowUntil: EARLIER_RETURN, now: NOW });

    const result = repos.fallow.unfallowTopic({ topicId });

    expect(result).toMatchObject({ skipped: [] });
    expect(repos.elements.findById(topicId)).toMatchObject({
      dueAt: DUE,
      fallowUntil: null,
      fallowBatchId: null,
    });
    expect(repos.elements.findById(extractId)?.dueAt).toBe(DUE);
  });

  it("direct unfallow restores only the requested topic when a chronic batch fallows multiple topics", () => {
    const firstTopicId = topic("First resting topic");
    const firstExtractId = extract(firstTopicId, "First resting extract");
    const secondTopicId = topic("Second resting topic");
    const secondExtractId = extract(secondTopicId, "Second resting extract");
    const sharedBatchId = "shared-chronic-fallow-batch";

    handle.db.transaction((tx) => {
      repos.fallow.fallowTopicWithin(tx, {
        topicId: firstTopicId,
        fallowUntil: RETURN,
        now: NOW,
        batchId: sharedBatchId,
      });
      repos.fallow.fallowTopicWithin(tx, {
        topicId: secondTopicId,
        fallowUntil: RETURN,
        now: NOW,
        batchId: sharedBatchId,
      });
    });

    const result = repos.fallow.unfallowTopic({ topicId: firstTopicId });

    expect(result).toMatchObject({ skipped: [] });
    expect(repos.elements.findById(firstTopicId)).toMatchObject({
      dueAt: DUE,
      fallowUntil: null,
      fallowBatchId: null,
    });
    expect(repos.elements.findById(firstExtractId)?.dueAt).toBe(DUE);
    expect(repos.elements.findById(secondTopicId)).toMatchObject({
      dueAt: RETURN,
      fallowUntil: RETURN,
      fallowBatchId: sharedBatchId,
    });
    expect(repos.elements.findById(secondExtractId)?.dueAt).toBe(RETURN);
  });

  it("direct unfallow does not overwrite newer descendant schedule intent", () => {
    const topicId = topic();
    const extractId = extract(topicId);
    repos.fallow.fallowTopic({ topicId, fallowUntil: RETURN, now: NOW });
    repos.elements.reschedule(extractId, LATER);

    const result = repos.fallow.unfallowTopic({ topicId });

    expect(result.skipped).toContainEqual({ id: extractId, reason: "schedule-changed" });
    expect(repos.elements.findById(extractId)?.dueAt).toBe(LATER);
    expect(repos.elements.findById(topicId)?.fallowUntil).toBeNull();
  });

  it("rejects non-topic and past return requests without writing fallow state", () => {
    const extractId = extract(topic());

    expect(repos.fallow.fallowTopic({ topicId: extractId, fallowUntil: RETURN, now: NOW })).toEqual(
      {
        applied: 0,
        skipped: [{ id: extractId, reason: "not-topic" }],
        batchId: null,
      },
    );
    expect(
      repos.fallow.fallowTopic({
        topicId: topic("Past topic"),
        fallowUntil: "2026-06-01T00:00:00.000Z" as IsoTimestamp,
        now: NOW,
      }).skipped[0]?.reason,
    ).toBe("invalid-return");
  });

  it("rejects parseable but non-canonical return dates without writing fallow state", () => {
    const topicId = topic("Impossible date topic");
    const extractId = extract(topicId);

    const result = repos.fallow.fallowTopic({
      topicId,
      fallowUntil: "2027-02-31T00:00:00.000Z" as IsoTimestamp,
      now: NOW,
    });

    expect(result).toEqual({
      applied: 0,
      skipped: [{ id: topicId, reason: "invalid-return" }],
      batchId: null,
    });
    expect(repos.elements.findById(topicId)).toMatchObject({
      dueAt: DUE,
      fallowUntil: null,
      fallowBatchId: null,
    });
    expect(repos.elements.findById(extractId)?.dueAt).toBe(DUE);
  });
});
