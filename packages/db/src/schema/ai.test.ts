import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { aiSuggestions } from "./ai";

describe("ai schema", () => {
  it("keeps AI suggestions as grounded, inert draft rows", () => {
    const columns = getTableColumns(aiSuggestions);

    expect(getTableName(aiSuggestions)).toBe("ai_suggestions");
    expect(Object.keys(columns)).toEqual([
      "id",
      "owningElementId",
      "action",
      "kind",
      "providerKind",
      "suggestionText",
      "cards",
      "sourceElementId",
      "sourceBlockIds",
      "startOffset",
      "endOffset",
      "selectedText",
      "status",
      "createdAt",
    ]);
    expect(columns.sourceElementId.name).toBe("source_element_id");
    expect(columns.selectedText.name).toBe("selected_text");
  });
});
