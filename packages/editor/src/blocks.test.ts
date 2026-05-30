/**
 * Block preservation-transform tests (T016).
 *
 * `toBlockInputs` reads stable ids straight off a ProseMirror document's
 * `blockId` attributes (never minting), in document order, so the save path can
 * mirror them into `document_blocks`. These are pure JSON-walk tests (no editor,
 * no DOM).
 */

import { describe, expect, it } from "vitest";
import { blockIdsOf, toBlockInputs } from "./blocks";

const PARA = (text: string, blockId: string) => ({
  type: "paragraph",
  attrs: { blockId },
  content: [{ type: "text", text }],
});

describe("toBlockInputs", () => {
  it("returns empty for nullish / non-object input", () => {
    expect(toBlockInputs(null)).toEqual([]);
    expect(toBlockInputs(undefined)).toEqual([]);
    expect(toBlockInputs("nope")).toEqual([]);
  });

  it("emits one descriptor per block-level node, in document order", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 1, blockId: "h1" },
          content: [{ type: "text", text: "T" }],
        },
        PARA("p", "p1"),
        { type: "horizontalRule", attrs: { blockId: "hr1" } },
      ],
    };
    expect(toBlockInputs(doc)).toEqual([
      { blockType: "heading", order: 0, stableBlockId: "h1" },
      { blockType: "paragraph", order: 1, stableBlockId: "p1" },
      { blockType: "horizontalRule", order: 2, stableBlockId: "hr1" },
    ]);
  });

  it("emits ONE block per list row (the listItem) — not the container, not the inner paragraph", () => {
    // Note: this fixture carries a STRAY id on the inner paragraphs (`pa`/`pb`),
    // the legacy shape a re-imported doc could still carry. The transform must
    // still emit exactly one block per row (the listItem), never the duplicate
    // inner-paragraph anchor that would corrupt `document_blocks` / source lineage.
    const doc = {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            { type: "listItem", attrs: { blockId: "li1" }, content: [PARA("a", "pa")] },
            { type: "listItem", attrs: { blockId: "li2" }, content: [PARA("b", "pb")] },
          ],
        },
      ],
    };
    const inputs = toBlockInputs(doc);
    expect(inputs.map((b) => b.blockType)).toEqual(["listItem", "listItem"]);
    expect(inputs.map((b) => b.stableBlockId)).toEqual(["li1", "li2"]);
    expect(inputs.some((b) => b.blockType === "bulletList")).toBe(false);
    expect(inputs.some((b) => b.blockType === "paragraph")).toBe(false);
    expect(inputs.map((b) => b.order)).toEqual([0, 1]);
  });

  it("emits ONE block for a multi-paragraph blockquote (the quote), not its inner paragraphs", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "blockquote",
          attrs: { blockId: "bq1" },
          // Stray inner-paragraph ids (legacy shape) must be ignored.
          content: [PARA("first", "qa"), PARA("second", "qb")],
        },
      ],
    };
    const inputs = toBlockInputs(doc);
    expect(inputs.map((b) => b.blockType)).toEqual(["blockquote"]);
    expect(inputs.map((b) => b.stableBlockId)).toEqual(["bq1"]);
  });

  it("skips block nodes that have no blockId (un-editor-processed)", () => {
    const doc = {
      type: "doc",
      content: [PARA("kept", "k1"), { type: "paragraph", content: [{ type: "text", text: "x" }] }],
    };
    expect(blockIdsOf(doc)).toEqual(["k1"]);
  });

  it("reads ids verbatim — never regenerates them", () => {
    const doc = { type: "doc", content: [PARA("a", "FIXED")] };
    expect(blockIdsOf(doc)).toEqual(["FIXED"]);
    // Calling again yields the same ids (pure read).
    expect(blockIdsOf(doc)).toEqual(["FIXED"]);
  });
});
