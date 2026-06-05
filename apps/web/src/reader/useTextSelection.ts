/**
 * The reader's text-selection hook (T019).
 *
 * Watches a live Tiptap editor for a non-trivial text selection inside the reader
 * and, when one exists, surfaces everything the selection toolbar needs:
 *
 *  - `position` — the viewport anchor (top + horizontal centre of the selection's
 *    bounding rect) the toolbar renders `fixed` above, or `null` to hide it;
 *  - `location` — the resolved {@link SelectionLocation} (ordered stable block ids
 *    + start/end offsets + verbatim snapshot), computed by the headless
 *    `resolveSelectionLocation` in `@interleave/editor` (NOT here — this hook owns
 *    only the DOM rect + open/close UI state, no offset/lineage math);
 *  - `dismiss()` — close the toolbar WITHOUT mutating the document or collapsing
 *    the selection, used by Cancel / Escape / click-elsewhere / after an action.
 *
 * It never persists anything and never touches `window.appApi`: the toolbar's
 * actions are delegated to the reader's callbacks (highlight in T020, extract in
 * T021). The selection itself is only ever READ (`editor.state.selection`,
 * `window.getSelection().getRangeAt(0).getBoundingClientRect()`) — opening, using,
 * or dismissing the toolbar must leave the ProseMirror selection intact (the
 * toolbar's own `onMouseDown` preventDefault keeps a button press from clearing
 * it; this hook adds no DOM mutation of its own).
 */

import { type Editor, resolveSelectionLocation, type SelectionLocation } from "@interleave/editor";
import { useCallback, useEffect, useState } from "react";
import type { SelectionToolbarPosition } from "./SelectionToolbar";

/** Minimum selected-character count before the toolbar appears (matches the kit). */
const MIN_SELECTION_LENGTH = 3;
/** Px above the selection's top edge to float the toolbar (matches the kit's -8). */
const ANCHOR_GAP = 8;

/** What {@link useTextSelection} exposes to the reader. */
export interface TextSelectionState {
  /** Where to anchor the toolbar, or `null` when there is nothing to act on. */
  readonly position: SelectionToolbarPosition | null;
  /** The resolved source-location anchor for the current selection, or `null`. */
  readonly location: SelectionLocation | null;
  /** Close the toolbar without mutating the document or clearing the selection. */
  readonly dismiss: () => void;
}

function editorDom(editor: Editor): HTMLElement | null {
  if (typeof HTMLElement === "undefined") return null;
  const dom = (editor as Editor & { view?: { dom?: unknown } }).view?.dom;
  return dom instanceof HTMLElement ? dom : null;
}

function domSelectionBelongsToEditor(editor: Editor, selection: Selection): boolean {
  const dom = editorDom(editor);
  if (!dom) return true;
  const { anchorNode, focusNode } = selection;
  return Boolean(anchorNode && focusNode && dom.contains(anchorNode) && dom.contains(focusNode));
}

/**
 * Track the reader's text selection and resolve the toolbar anchor + location.
 *
 * @param editor       the live Tiptap editor (or `null` before it mounts)
 * @param editorReady  whether the editor instance is mounted and ready to read
 */
export function useTextSelection(editor: Editor | null, editorReady: boolean): TextSelectionState {
  const [position, setPosition] = useState<SelectionToolbarPosition | null>(null);
  const [location, setLocation] = useState<SelectionLocation | null>(null);

  const dismiss = useCallback(() => {
    setPosition(null);
    setLocation(null);
  }, []);

  // Recompute the anchor + location from the editor's CURRENT selection. Reads
  // only — never mutates the doc or the DOM selection. Hides the toolbar when the
  // selection is empty, too short, or not inside an id'd block.
  const recompute = useCallback(() => {
    if (!editor) {
      setPosition(null);
      setLocation(null);
      return;
    }
    const resolved = resolveSelectionLocation(editor.state);
    if (!resolved || resolved.selectedText.trim().length < MIN_SELECTION_LENGTH) {
      setPosition(null);
      setLocation(null);
      return;
    }
    // The DOM rect comes from the browser selection, not ProseMirror, so the
    // toolbar floats exactly over what the user highlighted on screen.
    const domSelection = typeof window !== "undefined" ? window.getSelection() : null;
    if (
      domSelection &&
      domSelection.rangeCount > 0 &&
      !domSelectionBelongsToEditor(editor, domSelection)
    ) {
      setPosition(null);
      setLocation(null);
      return;
    }
    if (!domSelection || domSelection.rangeCount === 0) {
      // No DOM rect available (headless/edge) — keep the location but no anchor.
      setLocation(resolved);
      return;
    }
    const rect = domSelection.getRangeAt(0).getBoundingClientRect();
    setLocation(resolved);
    setPosition({ top: rect.top - ANCHOR_GAP, left: rect.left + rect.width / 2 });
  }, [editor]);

  // On every mouseup inside the document, re-evaluate the selection. (mouseup is
  // the moment a drag-select finishes; the prototype uses the same trigger.)
  useEffect(() => {
    if (!editorReady || !editor || typeof window === "undefined") return;
    const onMouseUp = () => {
      // Defer one tick so the browser has committed the final selection range.
      window.setTimeout(recompute, 0);
    };
    window.addEventListener("mouseup", onMouseUp);
    return () => window.removeEventListener("mouseup", onMouseUp);
  }, [editor, editorReady, recompute]);

  // Keyboard select (Shift+Arrows) doesn't fire mouseup; track selectionchange too,
  // but only while the editor view is focused so we don't react to selections
  // elsewhere on the page.
  useEffect(() => {
    if (!editorReady || !editor || typeof document === "undefined") return;
    const onSelectionChange = () => {
      if (!editor.isFocused) return;
      recompute();
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () => document.removeEventListener("selectionchange", onSelectionChange);
  }, [editor, editorReady, recompute]);

  // Escape dismisses the toolbar (Cancel mirror), and a mousedown that is NOT on
  // the toolbar collapses it. We do NOT clear the ProseMirror selection here.
  useEffect(() => {
    if (!position) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        dismiss();
      }
    };
    const onDocMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('[data-testid="selection-toolbar"]')) return;
      dismiss();
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDocMouseDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDocMouseDown);
    };
  }, [position, dismiss]);

  return { position, location, dismiss };
}
