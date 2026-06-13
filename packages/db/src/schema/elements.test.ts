import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { elements } from "./elements";

describe("element schema", () => {
  it("pins the universal element primitive columns", () => {
    const columns = getTableColumns(elements);

    expect(getTableName(elements)).toBe("elements");
    expect(Object.keys(columns)).toEqual([
      "id",
      "type",
      "status",
      "stage",
      "priority",
      "attentionIntervalMultiplier",
      "dueAt",
      "parkedAt",
      "fallowUntil",
      "fallowReason",
      "fallowBatchId",
      "extractFate",
      "needsReverify",
      "staleSince",
      "title",
      "parentId",
      "sourceId",
      "createdAt",
      "updatedAt",
      "deletedAt",
    ]);
    expect(columns.parentId.name).toBe("parent_id");
    expect(columns.attentionIntervalMultiplier.name).toBe("attention_interval_multiplier");
    expect(columns.attentionIntervalMultiplier.notNull).toBe(true);
    expect(columns.attentionIntervalMultiplier.default).toBe(1.0);
    expect(columns.sourceId.name).toBe("source_id");
    expect(columns.fallowUntil.name).toBe("fallow_until");
    expect(columns.fallowReason.name).toBe("fallow_reason");
    expect(columns.fallowBatchId.name).toBe("fallow_batch_id");
    expect(columns.extractFate.name).toBe("extract_fate");
    expect(columns.needsReverify.name).toBe("needs_reverify");
    expect(columns.needsReverify.notNull).toBe(true);
    expect(columns.needsReverify.default).toBe(false);
    expect(columns.staleSince.name).toBe("stale_since");
    expect(columns.deletedAt.name).toBe("deleted_at");
  });
});
