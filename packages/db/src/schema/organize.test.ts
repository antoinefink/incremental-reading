import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { concepts, elementTags, tags, tasks } from "./organize";

describe("organization schema", () => {
  it("pins concept hierarchy and tag join tables", () => {
    expect(getTableName(concepts)).toBe("concepts");
    expect(Object.keys(getTableColumns(concepts))).toEqual([
      "id",
      "parentConceptId",
      "name",
      "desiredRetention",
      "fsrsParams",
    ]);
    expect(getTableName(tags)).toBe("tags");
    expect(Object.keys(getTableColumns(tags))).toEqual(["id", "name"]);
    expect(getTableName(elementTags)).toBe("element_tags");
    expect(Object.keys(getTableColumns(elementTags))).toEqual(["elementId", "tagId"]);
  });

  it("pins verification task linkage and scheduling columns", () => {
    const columns = getTableColumns(tasks);

    expect(getTableName(tasks)).toBe("tasks");
    expect(Object.keys(columns)).toEqual([
      "elementId",
      "taskType",
      "dueAt",
      "status",
      "linkedElementId",
      "note",
    ]);
    expect(columns.linkedElementId.name).toBe("linked_element_id");
  });
});
