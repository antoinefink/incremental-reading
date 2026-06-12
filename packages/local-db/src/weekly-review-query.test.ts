import type { ElementId, IsoTimestamp } from "@interleave/core";
import { PRIORITY_LABEL_VALUE } from "@interleave/core";
import { type DbHandle, operationLog, tasks } from "@interleave/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRepositories, type Repositories } from "./index";
import { createInMemoryDb } from "./test-db";

let handle: DbHandle;
let repos: Repositories;

const NOW = "2026-06-12T12:00:00.000Z" as IsoTimestamp;

beforeEach(() => {
  handle = createInMemoryDb();
  repos = createRepositories(handle.db);
});

afterEach(() => {
  handle.sqlite.close();
});

describe("WeeklyReviewQuery / WeeklyReviewService", () => {
  it("creates one scheduled weekly_review task for the next cadence in an empty vault", () => {
    const summary = repos.weeklyReview.summary(NOW);
    expect(summary.enabled).toBe(true);
    expect(summary.session?.taskType).toBe("weekly_review");
    expect(summary.session?.dueAt).toBe("2026-06-19T12:00:00.000Z");
    expect(summary.due).toBe(false);

    const again = repos.weeklyReview.summary(NOW);
    expect(again.session?.id).toBe(summary.session?.id);
    expect(repos.queue.dueAttentionItems(NOW).map((row) => row.id)).not.toContain(
      summary.session?.id,
    );
  });

  it("creates an immediately due weekly_review task when there is weekly material", () => {
    repos.sources.create({
      title: "Weekly source",
      priority: PRIORITY_LABEL_VALUE.A,
      status: "active",
    });

    const summary = repos.weeklyReview.summary(NOW);
    expect(summary.session?.taskType).toBe("weekly_review");
    expect(summary.session?.dueAt).toBe(NOW);
    expect(summary.due).toBe(true);
    expect(repos.queue.dueAttentionItems(NOW).map((row) => row.id)).toContain(summary.session?.id);
  });

  it("persists section progress across dismiss and clears it on complete", () => {
    const summary = repos.weeklyReview.summary(NOW);
    const taskId = required(summary.session?.id);
    repos.weeklyReviewService.updateProgress({
      taskId,
      sections: { ledger: "done", chronic: "skipped" },
    });

    const dismissed = repos.weeklyReviewService.dismissSession(taskId, {
      asOf: NOW,
      snoozeDays: 2,
    });
    expect(dismissed.task?.dueAt).toBe("2026-06-14T12:00:00.000Z");
    expect(dismissed.progress?.sections.ledger).toBe("done");

    const afterDismiss = repos.weeklyReview.summary(NOW);
    expect(afterDismiss.progress?.sections.chronic).toBe("skipped");

    const completed = repos.weeklyReviewService.completeSession(taskId, NOW);
    expect(completed.task?.dueAt).toBe("2026-06-19T12:00:00.000Z");
    expect(completed.task?.id).not.toBe(taskId);
    expect(completed.progress).toBeNull();
    expect(handle.db.select().from(tasks).where(eq(tasks.elementId, taskId)).get()?.status).toBe(
      "done",
    );
    const afterComplete = repos.weeklyReview.summary(NOW);
    expect(afterComplete.progress?.sections.ledger).toBe("pending");
  });

  it("repairs soft-deleted weekly rows before creating a replacement", () => {
    const source = repos.sources.create({
      title: "Source",
      priority: PRIORITY_LABEL_VALUE.A,
      status: "active",
    });
    expect(source.element.id).toBeTruthy();
    const first = repos.weeklyReview.summary(NOW);
    const taskId = required(first.session?.id);

    repos.elements.softDelete(taskId);
    const next = repos.weeklyReview.summary(NOW);

    expect(next.session?.id).not.toBe(taskId);
    expect(handle.db.select().from(tasks).where(eq(tasks.elementId, taskId)).get()?.status).toBe(
      "deleted",
    );
    expect(next.session?.taskType).toBe("weekly_review");
  });

  it("audits progress writes against the weekly task", () => {
    repos.sources.create({
      title: "Audited source",
      priority: PRIORITY_LABEL_VALUE.A,
      status: "active",
    });
    const summary = repos.weeklyReview.summary(NOW);
    const taskId = required(summary.session?.id);

    repos.weeklyReviewService.updateProgress({ taskId, sections: { ledger: "done" } });

    const rows = handle.db
      .select()
      .from(operationLog)
      .where(eq(operationLog.elementId, taskId))
      .all();
    expect(rows.some((row) => row.payload.includes("weeklyReviewProgress"))).toBe(true);
  });

  it("composes weekly ledger counts and decision queues from existing read models", () => {
    const source = repos.sources.create({
      title: "Priority source",
      priority: PRIORITY_LABEL_VALUE.A,
      status: "active",
    });
    const extract = repos.sources.createExtract({
      sourceElementId: source.element.id,
      title: "Important extract",
      priority: PRIORITY_LABEL_VALUE.A,
      selectedText: "Important",
      blockIds: [],
      label: null,
    });
    const card = repos.review.createCard({
      kind: "qa",
      title: "Mature card",
      priority: PRIORITY_LABEL_VALUE.A,
      prompt: "Q",
      answer: "A",
      parentId: extract.element.id,
      sourceId: source.element.id,
      sourceLocationId: extract.location.id,
      stage: "active_card",
    });
    repos.review.recordReview(card.element.id, {
      rating: "good",
      reviewedAt: NOW,
      responseMs: 1000,
      prevState: "new",
      nextState: "review",
      nextStability: 10,
      nextDifficulty: 5,
      nextDueAt: "2026-06-20T12:00:00.000Z" as IsoTimestamp,
      elapsedDays: 1,
      scheduledDays: 8,
      reps: 2,
      lapses: 0,
      nextLearningSteps: 0,
    });
    repos.elements.reschedule(source.element.id, "2026-06-10T12:00:00.000Z" as IsoTimestamp);
    handle.db.transaction((tx) => {
      repos.elements.rescheduleWithin(
        tx,
        source.element.id,
        "2026-06-20T12:00:00.000Z" as IsoTimestamp,
        "scheduled",
        { postpone: true, postponeCount: 1 },
      );
    });

    const summary = repos.weeklyReview.summary(NOW);
    expect(summary.ledger.sources).toBeGreaterThanOrEqual(1);
    expect(summary.ledger.extracts).toBeGreaterThanOrEqual(1);
    expect(summary.ledger.cards).toBeGreaterThanOrEqual(1);
    expect(summary.ledger.maturedCards).toBe(1);
    expect(summary.ledger.priorityMisses.some((miss) => miss.band === "A")).toBe(true);
  });
});

function required(id: ElementId | undefined): ElementId {
  if (!id) throw new Error("expected weekly task id");
  return id;
}
