import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { documentBlocks, documentMarks, documents } from "./documents";

describe("document schema", () => {
  it("stores editable bodies and stable block lineage anchors separately", () => {
    expect(getTableName(documents)).toBe("documents");
    expect(Object.keys(getTableColumns(documents))).toEqual([
      "elementId",
      "prosemirrorJson",
      "plainText",
      "schemaVersion",
      "updatedAt",
    ]);

    const blockColumns = getTableColumns(documentBlocks);
    expect(getTableName(documentBlocks)).toBe("document_blocks");
    expect(Object.keys(blockColumns)).toEqual([
      "id",
      "documentId",
      "blockType",
      "order",
      "stableBlockId",
      "page",
      "timestampMs",
    ]);
    expect(blockColumns.stableBlockId.name).toBe("stable_block_id");
    expect(blockColumns.timestampMs.name).toBe("timestamp_ms");
  });

  it("keeps editor marks keyed by document and stable block id", () => {
    const columns = getTableColumns(documentMarks);

    expect(getTableName(documentMarks)).toBe("document_marks");
    expect(Object.keys(columns)).toEqual([
      "id",
      "documentId",
      "blockId",
      "markType",
      "range",
      "attrs",
    ]);
    expect(columns.blockId.name).toBe("block_id");
  });
});
