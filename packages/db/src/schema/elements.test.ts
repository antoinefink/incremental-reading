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
      "dueAt",
      "parkedAt",
      "fallowUntil",
      "fallowReason",
      "fallowBatchId",
      "extractFate",
      "title",
      "parentId",
      "sourceId",
      "createdAt",
      "updatedAt",
      "deletedAt",
    ]);
    expect(columns.parentId.name).toBe("parent_id");
    expect(columns.sourceId.name).toBe("source_id");
    expect(columns.fallowUntil.name).toBe("fallow_until");
    expect(columns.fallowReason.name).toBe("fallow_reason");
    expect(columns.fallowBatchId.name).toBe("fallow_batch_id");
    expect(columns.extractFate.name).toBe("extract_fate");
    expect(columns.deletedAt.name).toBe("deleted_at");
  });
});
