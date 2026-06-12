/**
 * Row → domain mapper tests (T065 — `source_locations.region`; T074 —
 * `source_locations.clip`).
 *
 * The region cell is JSON `{ x0, y0, x1, y1 }` (fractions) for a PDF region
 * extract, `null` otherwise. The clip cell is JSON `{ startMs, endMs }` (integer ms)
 * for a video/audio clip extract, `null` otherwise. `rowToSourceLocation` must parse
 * a well-formed value, degrade a malformed/partial cell to `null` (never throw on
 * read), and keep a `null` cell `null`.
 */

import type { ElementRow, SourceLocationRow } from "@interleave/db";
import { describe, expect, it } from "vitest";
import { rowToElement, rowToSourceLocation } from "./mappers";

/** A minimal `source_locations` row with overridable `region`/`clip` cells. */
function row(region: string | null, clip: string | null = null): SourceLocationRow {
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
    clip,
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

describe("rowToSourceLocation clip (T074)", () => {
  it("parses a well-formed clip window", () => {
    const loc = rowToSourceLocation(row(null, JSON.stringify({ startMs: 42000, endMs: 75000 })));
    expect(loc.clip).toEqual({ startMs: 42000, endMs: 75000 });
  });

  it("keeps a null clip null", () => {
    expect(rowToSourceLocation(row(null, null)).clip).toBeNull();
  });

  it("degrades a malformed/inverted clip cell to null (does not throw)", () => {
    expect(rowToSourceLocation(row(null, "{not json")).clip).toBeNull();
    // Inverted (endMs <= startMs) and partial windows degrade to null.
    expect(
      rowToSourceLocation(row(null, JSON.stringify({ startMs: 9000, endMs: 9000 }))).clip,
    ).toBeNull();
    expect(rowToSourceLocation(row(null, JSON.stringify({ startMs: 1000 }))).clip).toBeNull();
  });
});

describe("rowToElement attention interval multiplier", () => {
  it("maps the persisted attention interval multiplier", () => {
    const element = rowToElement({
      id: "el-1",
      type: "topic",
      status: "active",
      stage: "rough_topic",
      priority: 0.5,
      attentionIntervalMultiplier: 1.75,
      dueAt: null,
      parkedAt: null,
      fallowUntil: null,
      fallowReason: null,
      fallowBatchId: null,
      extractFate: null,
      title: "Topic",
      parentId: null,
      sourceId: null,
      createdAt: "2026-06-12T00:00:00.000Z",
      updatedAt: "2026-06-12T00:00:00.000Z",
      deletedAt: null,
    } satisfies ElementRow);

    expect(element.attentionIntervalMultiplier).toBe(1.75);
  });
});
