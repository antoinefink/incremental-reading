/**
 * Selection → source-location resolution tests (T019).
 *
 * These prove the load-bearing part of the text-selection toolbar: turning a
 * ProseMirror selection into the stable block-ids + offsets + verbatim snapshot
 * that highlight (T020) and extraction (T021) persist as a `source_locations`
 * anchor. They run headlessly against a raw `EditorState` (no DOM, mirroring what
 * the live editor wrapper reads), covering a single-block selection, a cross-block
 * selection (which must still return ALL spanned block ids — the T019 risk note),
 * and the empty/no-block cases that must produce no toolbar.
 */

import { Node as PmNode } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";
import { buildSchema } from "./schema";
import { resolveSelectionLocation } from "./selection-location";

const schema = buildSchema();

const PARA = (text: string, blockId: string) => ({
  type: "paragraph",
  attrs: { blockId },
  content: text ? [{ type: "text", text }] : [],
});

const HEADING = (text: string, blockId: string) => ({
  type: "heading",
  attrs: { level: 1, blockId },
  content: [{ type: "text", text }],
});

/** A three-block document: heading + two paragraphs, each with a stable id. */
const DOC = {
  type: "doc",
  content: [
    HEADING("Title", "blk_h"),
    PARA("First paragraph here.", "blk_a"),
    PARA("Second paragraph.", "blk_b"),
  ],
};

/** Absolute position of the START of a block's text content, by block id. */
function textStartOf(json: unknown, blockId: string): number {
  const doc = PmNode.fromJSON(schema, json);
  let start = -1;
  doc.descendants((node, pos) => {
    if (start >= 0) return false;
    const id = node.attrs.blockId as string | null | undefined;
    if (id === blockId) {
      start = pos + 1; // step inside the block node to its text
      return false;
    }
    return true;
  });
  return start;
}

/** Build an EditorState with a text selection spanning [from, to]. */
function stateWithSelection(json: unknown, from: number, to: number): EditorState {
  const doc = PmNode.fromJSON(schema, json);
  const state = EditorState.create({ schema, doc });
  return state.apply(state.tr.setSelection(TextSelection.create(doc, from, to)));
}

describe("resolveSelectionLocation — single-block selection", () => {
  it("resolves one block id with start/end offsets and the exact snapshot", () => {
    const start = textStartOf(DOC, "blk_a");
    // Select "First" (chars 0..5) inside "First paragraph here."
    const loc = resolveSelectionLocation(stateWithSelection(DOC, start, start + 5));
    expect(loc).not.toBeNull();
    expect(loc?.blockIds).toEqual(["blk_a"]);
    expect(loc?.startOffset).toBe(0);
    expect(loc?.endOffset).toBe(5);
    expect(loc?.selectedText).toBe("First");
    expect(loc?.crossBlock).toBe(false);
  });

  it("resolves a mid-block selection with non-zero start offset", () => {
    const start = textStartOf(DOC, "blk_a");
    // "First " is 6 chars; select "paragraph" (offset 6..15).
    const loc = resolveSelectionLocation(stateWithSelection(DOC, start + 6, start + 15));
    expect(loc?.blockIds).toEqual(["blk_a"]);
    expect(loc?.startOffset).toBe(6);
    expect(loc?.endOffset).toBe(15);
    expect(loc?.selectedText).toBe("paragraph");
  });
});

describe("resolveSelectionLocation — cross-block selection", () => {
  it("returns ALL spanned block ids in document order with first/last offsets", () => {
    const aStart = textStartOf(DOC, "blk_a");
    const bStart = textStartOf(DOC, "blk_b");
    // From "paragraph here." in blk_a (offset 6) through "Second" in blk_b (offset 6).
    const loc = resolveSelectionLocation(stateWithSelection(DOC, aStart + 6, bStart + 6));
    expect(loc).not.toBeNull();
    expect(loc?.blockIds).toEqual(["blk_a", "blk_b"]);
    expect(loc?.startOffset).toBe(6); // into blk_a
    expect(loc?.endOffset).toBe(6); // into blk_b
    expect(loc?.crossBlock).toBe(true);
    // The snapshot joins the two paragraphs' text with a newline.
    expect(loc?.selectedText).toBe("paragraph here.\nSecond");
  });

  it("spans the heading + both paragraphs when the selection covers all three", () => {
    const hStart = textStartOf(DOC, "blk_h");
    const bStart = textStartOf(DOC, "blk_b");
    const loc = resolveSelectionLocation(
      stateWithSelection(DOC, hStart, bStart + "Second paragraph.".length),
    );
    expect(loc?.blockIds).toEqual(["blk_h", "blk_a", "blk_b"]);
    expect(loc?.crossBlock).toBe(true);
  });
});

describe("resolveSelectionLocation — nothing-to-act-on cases", () => {
  it("returns null for an empty (collapsed caret) selection", () => {
    const start = textStartOf(DOC, "blk_a");
    expect(resolveSelectionLocation(stateWithSelection(DOC, start, start))).toBeNull();
  });

  it("returns null when the selection is not inside an id'd block", () => {
    const empty = { type: "doc", content: [{ type: "paragraph" }] };
    // The single empty paragraph has no blockId, so there is no anchor to resolve.
    const doc = PmNode.fromJSON(schema, empty);
    const state = EditorState.create({ schema, doc });
    // A whole-doc selection over an un-id'd block resolves no block id.
    const selected = state.apply(
      state.tr.setSelection(TextSelection.create(doc, 0, doc.content.size)),
    );
    expect(resolveSelectionLocation(selected)).toBeNull();
  });
});
