/**
 * Row → domain mapper tests (T065 — `source_locations.region` parsing).
 *
 * The region cell is JSON `{ x0, y0, x1, y1 }` (fractions) for a PDF region
 * extract, `null` otherwise. `rowToSourceLocation` must parse a well-formed rect,
 * degrade a malformed/partial cell to `null` (never throw on read), and keep a
 * `null` cell `null`.
 */

import type { SourceLocationRow } from "@interleave/db";
import { describe, expect, it } from "vitest";
import { rowToSourceLocation } from "./mappers";

/** A minimal `source_locations` row with an overridable `region` cell. */
function row(region: string | null): SourceLocationRow {
  return {
    id: "loc-1",
    elementId: "el-1",
    sourceElementId: "src-1",
    blockIds: JSON.stringify(["b-1"]),
    startOffset: null,
    endOffset: null,
    page: 3,
    timestampMs: null,
    region,
    label: "Page 3 · region",
    selectedText: "Figure on page 3",
  };
}

describe("rowToSourceLocation region (T065)", () => {
  it("parses a well-formed region rect", () => {
    const loc = rowToSourceLocation(row(JSON.stringify({ x0: 0.1, y0: 0.2, x1: 0.6, y1: 0.7 })));
    expect(loc.region).toEqual({ x0: 0.1, y0: 0.2, x1: 0.6, y1: 0.7 });
    expect(loc.page).toBe(3);
  });

  it("keeps a null region null", () => {
    expect(rowToSourceLocation(row(null)).region).toBeNull();
  });

  it("degrades a malformed region cell to null (does not throw)", () => {
    expect(rowToSourceLocation(row("{not json")).region).toBeNull();
    expect(rowToSourceLocation(row(JSON.stringify({ x0: 0.1, y0: 0.2 }))).region).toBeNull();
  });
});
