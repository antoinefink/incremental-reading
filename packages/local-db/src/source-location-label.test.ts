/**
 * `deriveSourceLocationLabel` (T021/T022 + T064 paginated label) + `deriveClipLabel`
 * (T074 media clip label).
 *
 * Pins the human-readable source-location label: the 1-based ¶ index for a
 * paragraph, a "<Type> · ¶N" for a non-paragraph block, the "Selected text"
 * fallback for an unknown block, and — for a PAGINATED source (a PDF, T064) — the
 * "Page N · ¶M" prefix when a page is supplied. `deriveClipLabel` formats a media
 * clip window as "Clip M:SS–M:SS".
 */

import { describe, expect, it } from "vitest";
import {
  deriveClipLabel,
  deriveSourceLocationLabel,
  type LabelBlock,
} from "./source-location-label";

const BLOCKS: LabelBlock[] = [
  { stableBlockId: "a", blockType: "heading", order: 0 },
  { stableBlockId: "b", blockType: "paragraph", order: 1 },
  { stableBlockId: "c", blockType: "paragraph", order: 2 },
];

describe("deriveSourceLocationLabel", () => {
  it("returns ¶N for a paragraph (no page)", () => {
    expect(deriveSourceLocationLabel(BLOCKS, "b")).toBe("¶2");
    expect(deriveSourceLocationLabel(BLOCKS, "c")).toBe("¶3");
  });

  it("returns <Type> · ¶N for a non-paragraph block (no page)", () => {
    expect(deriveSourceLocationLabel(BLOCKS, "a")).toBe("Heading · ¶1");
  });

  it("falls back to 'Selected text' for an unknown block", () => {
    expect(deriveSourceLocationLabel(BLOCKS, "missing")).toBe("Selected text");
  });

  it("prefixes 'Page N · ' when a page is supplied (PDF, T064)", () => {
    expect(deriveSourceLocationLabel(BLOCKS, "b", 4)).toBe("Page 4 · ¶2");
    expect(deriveSourceLocationLabel(BLOCKS, "a", 2)).toBe("Page 2 · Heading · ¶1");
  });

  it("is unchanged when page is null/absent (non-paginated)", () => {
    expect(deriveSourceLocationLabel(BLOCKS, "b", null)).toBe("¶2");
    expect(deriveSourceLocationLabel(BLOCKS, "b", undefined)).toBe("¶2");
  });
});

describe("deriveClipLabel (T074)", () => {
  it("formats a clip window as 'Clip M:SS–M:SS'", () => {
    expect(deriveClipLabel(42_000, 75_000)).toBe("Clip 0:42–1:15");
    expect(deriveClipLabel(0, 5_000)).toBe("Clip 0:00–0:05");
  });

  it("uses h:mm:ss past one hour", () => {
    expect(deriveClipLabel(3_661_000, 3_725_000)).toBe("Clip 1:01:01–1:02:05");
  });
});
