import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { occlusionMasks } from "./occlusion";

describe("occlusion schema", () => {
  it("stores image masks as vector metadata linked to source images and generated cards", () => {
    const columns = getTableColumns(occlusionMasks);

    expect(getTableName(occlusionMasks)).toBe("occlusion_masks");
    expect(Object.keys(columns)).toEqual([
      "id",
      "imageElementId",
      "cardElementId",
      "region",
      "label",
      "order",
      "createdAt",
    ]);
    expect(columns.imageElementId.name).toBe("image_element_id");
    expect(columns.cardElementId.name).toBe("card_element_id");
  });
});
