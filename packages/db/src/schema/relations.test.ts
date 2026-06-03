import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { elementRelations, readPoints } from "./relations";

describe("relation schema", () => {
  it("stores typed lineage edges independently from nesting", () => {
    const columns = getTableColumns(elementRelations);

    expect(getTableName(elementRelations)).toBe("element_relations");
    expect(Object.keys(columns)).toEqual([
      "id",
      "fromElementId",
      "toElementId",
      "relationType",
      "siblingGroupId",
      "createdAt",
    ]);
    expect(columns.fromElementId.name).toBe("from_element_id");
    expect(columns.siblingGroupId.name).toBe("sibling_group_id");
  });

  it("stores read points by source element, document, stable block, and offset", () => {
    const columns = getTableColumns(readPoints);

    expect(getTableName(readPoints)).toBe("read_points");
    expect(Object.keys(columns)).toEqual([
      "id",
      "elementId",
      "documentId",
      "blockId",
      "offset",
      "updatedAt",
    ]);
    expect(columns.documentId.name).toBe("document_id");
    expect(columns.blockId.name).toBe("block_id");
  });
});
