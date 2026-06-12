import type { ElementId, IsoTimestamp } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { cards, elements, reviewLogs, reviewStates } from "@interleave/db";
import { CARD_MATURE_STABILITY_DAYS } from "@interleave/scheduler";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BlockProcessingService } from "./block-processing-service";
import { ConceptRepository } from "./concept-repository";
import { DailyWorkQuery } from "./daily-work-query";
import { ElementRepository } from "./element-repository";
import { newReviewLogId } from "./ids";
import { createRepositories } from "./index";
import { ReviewRepository } from "./review-repository";
import { SourceRepository } from "./source-repository";
import { createInMemoryDb } from "./test-db";

let handle: DbHandle;
let elementsRepo: ElementRepository;
let sources: SourceRepository;
let reviews: ReviewRepository;
let concepts: ConceptRepository;
let query: DailyWorkQuery;

const NOW = "2026-06-08T09:00:00.000Z" as IsoTimestamp;
const PAST = "2026-06-07T09:00:00.000Z" as IsoTimestamp;
const FUTURE = "2026-06-09T09:00:00.000Z" as IsoTimestamp;

beforeEach(() => {
  handle = createInMemoryDb();
  elementsRepo = new ElementRepository(handle.db);
  sources = new SourceRepository(handle.db);
  reviews = new ReviewRepository(handle.db);
  concepts = new ConceptRepository(handle.db);
  query = new DailyWorkQuery(createRepositories(handle.db), new BlockProcessingService(handle.db));
});

afterEach(() => {
  handle.sqlite.close();
});

function createDueCard(): ElementId {
  const { element } = reviews.createCard({
    kind: "qa",
    title: "Due card",
    prompt: "Question",
    answer: "Answer",
    priority: 0.8,
  });
  handle.db
    .update(reviewStates)
    .set({ dueAt: PAST })
    .where(eq(reviewStates.elementId, element.id))
    .run();
  return element.id;
}

function createDueAttention(): ElementId {
  return elementsRepo.create({
    type: "extract",
    status: "scheduled",
    stage: "raw_extract",
    priority: 0.6,
    title: "Due extract",
    dueAt: PAST,
  }).id;
}

function createInboxSource(): ElementId {
  return sources.createWithDocument({
    title: "Inbox article",
    priority: 0.5,
    status: "inbox",
    body: "Imported yesterday.\nNeeds triage.",
  }).element.id;
}

function createActiveUnscheduledSource(
  title = "Active article",
  body = "Read me later.\n\nStill not scheduled.",
): ElementId {
  return sources.createWithDocument({
    title,
    priority: 0.75,
    status: "active",
    body,
  }).element.id;
}

function createActiveScheduledSource(title: string, dueAt: IsoTimestamp): ElementId {
  const id = sources.createWithDocument({
    title,
    priority: 0.75,
    status: "active",
    body: "Started source.\n\nHas a return path.",
  }).element.id;
  handle.db.update(elements).set({ dueAt }).where(eq(elements.id, id)).run();
  return id;
}

function createGraduatedConcept(name = "Graduated concept"): ElementId {
  const concept = concepts.createConcept({ name });
  concepts.setConceptRetention(concept.id, 0.9);
  const sourceId = elementsRepo.create({
    type: "source",
    status: "active",
    stage: "raw_source",
    priority: 0.7,
    title: `${name} source`,
  }).id;
  const extractId = elementsRepo.create({
    type: "extract",
    status: "done",
    stage: "clean_extract",
    priority: 0.7,
    title: `${name} extract`,
    parentId: sourceId,
    sourceId,
  }).id;
  elementsRepo.update(extractId, { extractFate: "synthesized" });
  for (let index = 0; index < 3; index += 1) {
    const cardId = elementsRepo.create({
      type: "card",
      status: "active",
      stage: "active_card",
      priority: 0.7,
      title: `${name} card ${index + 1}`,
      parentId: extractId,
      sourceId,
    }).id;
    handle.db.insert(cards).values({ elementId: cardId, kind: "qa", isRetired: false }).run();
    handle.db
      .insert(reviewStates)
      .values({
        elementId: cardId,
        fsrsState: "review",
        stability: CARD_MATURE_STABILITY_DAYS + 1,
        reps: 3,
      })
      .run();
    handle.db
      .insert(reviewLogs)
      .values({
        id: newReviewLogId(),
        elementId: cardId,
        rating: "good",
        reviewedAt: "2026-06-07T09:00:00.000Z",
        responseMs: 800,
        prevState: "review",
        nextState: "review",
        nextStability: CARD_MATURE_STABILITY_DAYS + 1,
        nextDifficulty: 5,
        nextDueAt: "2026-07-07T09:00:00.000Z",
      })
      .run();
  }
  concepts.assignConcept(sourceId, concept.id);
  return concept.id;
}

describe("DailyWorkQuery", () => {
  it("recommends processing the due queue before inbox or unscheduled resume work", () => {
    createDueCard();
    createDueAttention();
    createInboxSource();
    createActiveUnscheduledSource();

    const summary = query.summary(NOW);

    expect(summary.dueQueueItems).toBe(2);
    expect(summary.inboxSources).toBe(1);
    expect(summary.activeUnscheduledSources).toBe(1);
    expect(summary.recommendedAction).toBe("process_due_queue");
  });

  it("recommends inbox triage when imports exist but no queue work is due", () => {
    createInboxSource();
    createActiveUnscheduledSource();

    const summary = query.summary(NOW);

    expect(summary.dueQueueItems).toBe(0);
    expect(summary.inboxSources).toBe(1);
    expect(summary.activeUnscheduledSources).toBe(1);
    expect(summary.recommendedAction).toBe("triage_inbox");
  });

  it("recommends resuming an active unscheduled source only after due and inbox work are empty", () => {
    const id = createActiveUnscheduledSource("Current read");

    const summary = query.summary(NOW);

    expect(summary.recommendedAction).toBe("resume_unscheduled_source");
    expect(summary.activeUnscheduledSources).toBe(1);
    expect(summary.resumeSource?.id).toBe(id);
    expect(summary.resumeSource?.unresolvedBlocks).toBeGreaterThan(0);
  });

  it("counts active scheduled sources as due queue work instead of unscheduled resume work", () => {
    const id = createActiveScheduledSource("Started scheduled read", PAST);

    const summary = query.summary(NOW);

    expect(summary.dueQueueItems).toBe(1);
    expect(summary.activeUnscheduledSources).toBe(0);
    expect(summary.resumeSource).toBeNull();
    expect(summary.recommendedAction).toBe("process_due_queue");
    expect(id).toBeTruthy();
  });

  it("does not treat active sources with a future return date as unscheduled resume work", () => {
    createActiveScheduledSource("Started future read", FUTURE);

    const summary = query.summary(NOW);

    expect(summary.dueQueueItems).toBe(0);
    expect(summary.activeUnscheduledSources).toBe(0);
    expect(summary.recommendedAction).toBe("clear");
  });

  it("excludes parked due, inbox, and unscheduled source work", () => {
    const cardId = createDueCard();
    const attentionId = createDueAttention();
    const inboxId = createInboxSource();
    const activeId = createActiveUnscheduledSource("Parked active source");
    for (const id of [cardId, attentionId, inboxId, activeId]) {
      elementsRepo.update(id, { status: "parked", parkedAt: NOW });
    }

    const summary = query.summary(NOW);

    expect(summary.dueQueueItems).toBe(0);
    expect(summary.inboxSources).toBe(0);
    expect(summary.activeUnscheduledSources).toBe(0);
    expect(summary.resumeSource).toBeNull();
    expect(summary.recommendedAction).toBe("clear");
  });

  it("prefers the most recently updated active unscheduled source when unresolved work ties", () => {
    const oldId = createActiveUnscheduledSource("Old source");
    const newId = createActiveUnscheduledSource("New source");
    handle.db
      .update(elements)
      .set({ updatedAt: "2026-06-01T09:00:00.000Z" })
      .where(eq(elements.id, oldId))
      .run();
    handle.db
      .update(elements)
      .set({ updatedAt: "2026-06-08T09:00:00.000Z" })
      .where(eq(elements.id, newId))
      .run();

    expect(query.summary(NOW).resumeSource?.id).toBe(newId);
  });

  it("prefers active unscheduled sources with more unresolved blocks before recency", () => {
    const newerId = createActiveUnscheduledSource("Newer short source", "One unresolved block.");
    const olderId = createActiveUnscheduledSource(
      "Older deeper source",
      "First unresolved block.\n\nSecond unresolved block.\n\nThird unresolved block.",
    );
    handle.db
      .update(elements)
      .set({ updatedAt: "2026-06-08T09:00:00.000Z" })
      .where(eq(elements.id, newerId))
      .run();
    handle.db
      .update(elements)
      .set({ updatedAt: "2026-06-01T09:00:00.000Z" })
      .where(eq(elements.id, olderId))
      .run();

    const summary = query.summary(NOW);

    expect(summary.resumeSource?.id).toBe(olderId);
    expect(summary.resumeSource?.unresolvedBlocks).toBeGreaterThan(1);
  });

  it("reports clear only when there is no due, inbox, or active unscheduled source work", () => {
    const summary = query.summary(NOW);

    expect(summary).toMatchObject({
      dueQueueItems: 0,
      inboxSources: 0,
      activeUnscheduledSources: 0,
      resumeSource: null,
      recommendedAction: "clear",
    });
  });

  it("emits graduation lines until observed and emits again after an observed regression", () => {
    const conceptId = createGraduatedConcept("Spaced repetition");

    const first = query.summary(NOW);

    expect(first.graduationEvents).toHaveLength(1);
    expect(first.graduationEvents[0]).toMatchObject({
      subjectType: "concept",
      subjectId: conceptId,
      title: "Spaced repetition",
    });

    query.acknowledgeGraduationEvents({
      asOf: NOW,
      eventIds: first.graduationEvents.map((event) => event.eventId),
    });
    expect(query.summary(NOW).graduationEvents).toHaveLength(0);

    handle.db.update(reviewStates).set({ stability: 1 }).run();
    query.acknowledgeGraduationEvents({
      asOf: "2026-06-09T09:00:00.000Z" as IsoTimestamp,
      eventIds: [],
    });
    expect(query.summary("2026-06-09T09:00:00.000Z" as IsoTimestamp).graduationEvents).toHaveLength(
      0,
    );

    handle.db
      .update(reviewStates)
      .set({ stability: CARD_MATURE_STABILITY_DAYS + 1 })
      .run();
    const regraduated = query.summary("2026-06-10T09:00:00.000Z" as IsoTimestamp);

    expect(regraduated.graduationEvents).toHaveLength(1);
    expect(regraduated.graduationEvents[0]?.eventId).toBe(first.graduationEvents[0]?.eventId);
  });

  it("does not suppress graduation lines when acknowledgement event ids do not match", () => {
    createGraduatedConcept("Invalid acknowledgement");
    const first = query.summary(NOW);

    query.acknowledgeGraduationEvents({
      asOf: NOW,
      eventIds: ["concept:missing:graduated:v1"],
    });

    expect(query.summary(NOW).graduationEvents.map((event) => event.eventId)).toEqual(
      first.graduationEvents.map((event) => event.eventId),
    );
  });
});
