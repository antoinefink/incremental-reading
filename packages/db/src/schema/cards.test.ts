import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { cards, reviewLogs, reviewStates } from "./cards";

describe("card schema", () => {
  it("pins card authoring, source lineage, retirement, and claim-lifetime columns", () => {
    const columns = getTableColumns(cards);

    expect(getTableName(cards)).toBe("cards");
    expect(Object.keys(columns)).toEqual([
      "elementId",
      "kind",
      "prompt",
      "answer",
      "cloze",
      "sourceLocationId",
      "sourceUri",
      "mediaRef",
      "isLeech",
      "desiredRetention",
      "isRetired",
      "factStability",
      "validFrom",
      "validUntil",
      "jurisdiction",
      "softwareVersion",
      "reviewBy",
    ]);
    expect(columns.sourceLocationId.name).toBe("source_location_id");
    expect(columns.isRetired.name).toBe("is_retired");
    expect(columns.reviewBy.name).toBe("review_by");
  });

  it("keeps FSRS state and review log tables separate from cards", () => {
    expect(getTableName(reviewStates)).toBe("review_states");
    expect(Object.keys(getTableColumns(reviewStates))).toEqual([
      "elementId",
      "dueAt",
      "stability",
      "difficulty",
      "elapsedDays",
      "scheduledDays",
      "reps",
      "lapses",
      "fsrsState",
      "learningSteps",
      "lastReviewedAt",
    ]);
    expect(getTableName(reviewLogs)).toBe("review_logs");
    expect(Object.keys(getTableColumns(reviewLogs))).toEqual([
      "id",
      "elementId",
      "rating",
      "reviewedAt",
      "responseMs",
      "prevState",
      "nextState",
      "nextStability",
      "nextDifficulty",
      "nextDueAt",
    ]);
  });
});
