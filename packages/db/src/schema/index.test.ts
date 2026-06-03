import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as schema from "./index";

describe("schema barrel", () => {
  it("exports every persisted table module through the Drizzle schema barrel", () => {
    expect(
      [
        schema.aiSuggestions,
        schema.assets,
        schema.cards,
        schema.concepts,
        schema.documentBlocks,
        schema.documentMarks,
        schema.documents,
        schema.elementRelations,
        schema.elementTags,
        schema.elements,
        schema.embeddings,
        schema.jobs,
        schema.occlusionMasks,
        schema.ocrPages,
        schema.operationLog,
        schema.readPoints,
        schema.reviewLogs,
        schema.reviewStates,
        schema.settings,
        schema.sourceLocations,
        schema.sources,
        schema.tags,
        schema.tasks,
      ].map((table) => getTableName(table)),
    ).toEqual([
      "ai_suggestions",
      "assets",
      "cards",
      "concepts",
      "document_blocks",
      "document_marks",
      "documents",
      "element_relations",
      "element_tags",
      "elements",
      "embeddings",
      "jobs",
      "occlusion_masks",
      "ocr_pages",
      "operation_log",
      "read_points",
      "review_logs",
      "review_states",
      "settings",
      "source_locations",
      "sources",
      "tags",
      "tasks",
    ]);
  });
});
