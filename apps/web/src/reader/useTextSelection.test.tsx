/**
 * `useTextSelection` hook tests (T019).
 *
 * Verifies the reader's selection seam: a ≥3-char selection inside the editor
 * surfaces a toolbar anchor + resolved location on mouseup, Escape dismisses it
 * without mutating the document, and the document/selection are only ever READ.
 *
 * The hook reads `editor.state` (a real ProseMirror `EditorState`) and the DOM
 * selection rect, so the test stands up a real state behind a minimal fake editor
 * and stubs `window.getSelection()` to return a range with a bounding rect.
 */

import { buildSchema, type Editor } from "@interleave/editor";
import { act, renderHook } from "@testing-library/react";
import { Node as PmNode } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTextSelection } from "./useTextSelection";

const schema = buildSchema();
const DOC = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      attrs: { blockId: "blk_1" },
      content: [{ type: "text", text: "Alpha beta gamma." }],
    },
  ],
};

/** A minimal fake Tiptap editor exposing the `.state`, `.view.dom`, and `.isFocused` the hook reads. */
function fakeEditor(from: number, to: number): { editor: Editor; selectedNode: Text } {
  const doc = PmNode.fromJSON(schema, DOC);
  let state = EditorState.create({ schema, doc });
  state = state.apply(state.tr.setSelection(TextSelection.create(doc, from, to)));
  const editorDom = document.createElement("div");
  const selectedNode = document.createTextNode("Alpha beta gamma.");
  editorDom.append(selectedNode);
  document.body.append(editorDom);

  return {
    editor: { state, isFocused: true, view: { dom: editorDom } } as unknown as Editor,
    selectedNode,
  };
}

/** Stub the DOM selection so the hook can read a bounding rect on mouseup. */
function stubDomSelection(anchorNode: Node) {
  const range = {
    getBoundingClientRect: () => ({ top: 100, left: 200, width: 80, height: 18 }),
  };
  vi.spyOn(window, "getSelection").mockReturnValue({
    rangeCount: 1,
    anchorNode,
    focusNode: anchorNode,
    getRangeAt: () => range,
  } as unknown as Selection);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("useTextSelection", () => {
  it("surfaces a position + location for a ≥3-char selection on mouseup", () => {
    vi.useFakeTimers();
    // "Alpha" = positions 1..6 inside the single paragraph.
    const { editor, selectedNode } = fakeEditor(1, 6);
    stubDomSelection(selectedNode);
    const { result } = renderHook(() => useTextSelection(editor, true));

    expect(result.current.position).toBeNull();
    act(() => {
      window.dispatchEvent(new MouseEvent("mouseup"));
      vi.runAllTimers();
    });
    expect(result.current.position).toEqual({ top: 92, left: 240 }); // top-8, left+width/2
    expect(result.current.location?.blockIds).toEqual(["blk_1"]);
    expect(result.current.location?.selectedText).toBe("Alpha");
  });

  it("Escape dismisses the toolbar", () => {
    vi.useFakeTimers();
    const { editor, selectedNode } = fakeEditor(1, 6);
    stubDomSelection(selectedNode);
    const { result } = renderHook(() => useTextSelection(editor, true));
    act(() => {
      window.dispatchEvent(new MouseEvent("mouseup"));
      vi.runAllTimers();
    });
    expect(result.current.position).not.toBeNull();

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(result.current.position).toBeNull();
    expect(result.current.location).toBeNull();
  });

  it("does not show the toolbar for a sub-3-char selection", () => {
    vi.useFakeTimers();
    // "Al" = positions 1..3 → 2 chars, below the threshold.
    const { editor, selectedNode } = fakeEditor(1, 3);
    stubDomSelection(selectedNode);
    const { result } = renderHook(() => useTextSelection(editor, true));
    act(() => {
      window.dispatchEvent(new MouseEvent("mouseup"));
      vi.runAllTimers();
    });
    expect(result.current.position).toBeNull();
  });

  it("does not anchor the toolbar to a selection outside the editor, such as a quality check row", () => {
    vi.useFakeTimers();
    const { editor } = fakeEditor(1, 6);
    const qualityCheck = document.createElement("div");
    qualityCheck.className = "qc qc--warn";
    qualityCheck.textContent =
      "Nearly identical to another card — they may interfere; merge or differentiate";
    document.body.append(qualityCheck);
    const qualityText = qualityCheck.firstChild;
    if (!qualityText) throw new Error("Expected quality-check text node.");
    stubDomSelection(qualityText);

    const { result } = renderHook(() => useTextSelection(editor, true));
    act(() => {
      window.dispatchEvent(new MouseEvent("mouseup"));
      vi.runAllTimers();
    });

    expect(result.current.position).toBeNull();
    expect(result.current.location).toBeNull();
  });
});
