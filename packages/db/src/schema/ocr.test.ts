import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { ocrPages } from "./ocr";

describe("OCR schema", () => {
  it("stores reviewable page OCR separately from document bodies", () => {
    const columns = getTableColumns(ocrPages);

    expect(getTableName(ocrPages)).toBe("ocr_pages");
    expect(Object.keys(columns)).toEqual([
      "id",
      "sourceElementId",
      "page",
      "text",
      "meanConfidence",
      "words",
      "status",
      "sourceLocationId",
      "createdAt",
      "updatedAt",
    ]);
    expect(columns.sourceElementId.name).toBe("source_element_id");
    expect(columns.meanConfidence.name).toBe("mean_confidence");
    expect(columns.sourceLocationId.name).toBe("source_location_id");
  });
});
