import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { embeddings } from "./embeddings";

describe("embedding schema", () => {
  it("keeps vector storage as rebuildable sidecar metadata", () => {
    const columns = getTableColumns(embeddings);

    expect(getTableName(embeddings)).toBe("embeddings");
    expect(Object.keys(columns)).toEqual([
      "elementId",
      "vecRowid",
      "elementType",
      "modelId",
      "dim",
      "contentHash",
      "createdAt",
      "updatedAt",
    ]);
    expect(columns.vecRowid.name).toBe("vec_rowid");
    expect(columns.contentHash.name).toBe("content_hash");
  });
});
