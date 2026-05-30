/**
 * Jump-to-source helpers (T022) — make extraction lineage *actionable*.
 *
 * Every extract stores a `source_locations` anchor (the original source element
 * id + the ordered STABLE block ids it spans + char offsets + a verbatim
 * snapshot + a human label). From an extract (the inspector's "Source location"
 * section, or the extract view) the user can "Jump to source": open the source
 * reader, scroll the originating paragraph into view, and briefly FLASH it (the
 * kit's accent ring — `design/kit/app/screen-reader.jsx`'s `jumped` treatment).
 *
 * This module owns the editor/ProseMirror side of that flow so the layering rule
 * holds (editor logic in `@interleave/editor`, NOT a React component):
 *
 *  - {@link scrollBlockIntoView} finds a block by its stable id in a live editor,
 *    sets the caret at the (clamped) offset, and scrolls the matching
 *    `data-block-id` DOM node into view — degrading gracefully when the block was
 *    edited/removed (it falls back to the document start rather than throwing, so
 *    lineage is never a dead end);
 *  - {@link flashBlock} draws the transient `.jumped` ring on a block via the
 *    reader-decoration plugin (a ProseMirror node decoration, so it survives the
 *    editor's own re-renders), then clears it after a beat;
 *  - {@link jumpToSource} composes the two: scroll + flash in one call, returning
 *    what it did so the host can surface a "Jumped to source · <label>" toast.
 *
 * Resolution is ALWAYS by stable block id, never by an absolute ProseMirror
 * position — that is what keeps jump-back correct after edits / re-imports.
 */

import type { Editor } from "@tiptap/core";
import { BLOCK_ID_DOM_ATTR, BLOCK_ID_NODE_TYPES } from "./block-id";
import {
  type ReaderDecorationState,
  readerDecorationsKey,
  setReaderDecorations,
} from "./reader-decorations";

const BLOCK_ID_NODE_SET = new Set<string>(BLOCK_ID_NODE_TYPES);

/** How long the jump flash ring lingers before it clears (ms). */
export const JUMP_FLASH_MS = 1800;

/** Options for {@link scrollBlockIntoView} / {@link jumpToSource}. */
export interface JumpToSourceOptions {
  /** Char offset within the target block to place the caret at. Defaults to `0`. */
  readonly offset?: number;
  /** Whether to scroll the matching DOM block into view. Defaults to `true`. */
  readonly scroll?: boolean;
  /** `scrollIntoView` block alignment. Defaults to `"center"`. */
  readonly block?: ScrollLogicalPosition;
  /** How long the flash ring lingers (ms). Defaults to {@link JUMP_FLASH_MS}. */
  readonly flashMs?: number;
}

/** What a jump did, so the host can decide how to surface it. */
export type JumpToSourceResult =
  | { readonly kind: "jumped"; readonly blockId: string; readonly offset: number }
  | { readonly kind: "fallback"; readonly reason: "missing-block" };

/** Locate a block by its stable id; returns its absolute position + text length, or `null`. */
function findBlock(editor: Editor, blockId: string): { pos: number; textLen: number } | null {
  let target: { pos: number; textLen: number } | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (target) return false;
    if (!BLOCK_ID_NODE_SET.has(node.type.name)) return true;
    if ((node.attrs.blockId as string | null) === blockId) {
      target = { pos, textLen: node.textContent.length };
      return false;
    }
    return true;
  });
  return target;
}

/**
 * Scroll a block into view in a live editor and place the caret at the (clamped)
 * offset. Resolves the block by its STABLE id. When the block is gone (edited /
 * re-imported away) it does NOT throw — it leaves the caret at the document start
 * and returns `{ kind: "fallback" }` so the caller can still show the stored
 * snapshot rather than a dead end.
 */
export function scrollBlockIntoView(
  editor: Editor,
  blockId: string,
  options: JumpToSourceOptions = {},
): JumpToSourceResult {
  const { offset = 0, scroll = true, block = "center" } = options;
  const target = findBlock(editor, blockId);
  if (!target) {
    editor.commands.setTextSelection(0);
    return { kind: "fallback", reason: "missing-block" };
  }

  const { pos, textLen } = target;
  const clampedOffset = Math.max(0, Math.min(offset, textLen));
  // +1 steps inside the block node to its text; add the clamped char offset.
  editor.commands.setTextSelection(pos + 1 + clampedOffset);

  if (scroll && typeof document !== "undefined") {
    const dom = editor.view.dom as HTMLElement;
    const el = dom.querySelector<HTMLElement>(`[${BLOCK_ID_DOM_ATTR}="${cssEscape(blockId)}"]`);
    el?.scrollIntoView({ behavior: "auto", block });
  }
  return { kind: "jumped", blockId, offset: clampedOffset };
}

/**
 * Briefly ring a block with the `.jumped` accent decoration, then clear it after
 * `flashMs`. Idempotent + decoration-based (it preserves the editor's existing
 * decoration inputs and only toggles `flashedBlockId`), so it never disturbs the
 * read-point divider / extracted markers / highlights. Returns a disposer that
 * cancels the pending clear (e.g. on unmount). No-op when the editor is gone.
 */
export function flashBlock(
  editor: Editor | null,
  blockId: string,
  flashMs: number = JUMP_FLASH_MS,
): () => void {
  if (!editor) return () => {};
  const current = (readerDecorationsKey.getState(editor.state) ??
    null) as ReaderDecorationState | null;
  const base: ReaderDecorationState = current ?? {
    firstUnreadBlockId: null,
    readPointBlockId: null,
    extractedBlockIds: [],
    highlights: [],
    processed: [],
    flashedBlockId: null,
  };
  setReaderDecorations(editor, { ...base, flashedBlockId: blockId });

  const timer = setTimeout(() => {
    // Re-read the latest inputs so we clear ONLY the flash, preserving any other
    // decoration changes the host pushed in the meantime.
    const latest = (readerDecorationsKey.getState(editor.state) ?? base) as ReaderDecorationState;
    if (latest.flashedBlockId === blockId) {
      setReaderDecorations(editor, { ...latest, flashedBlockId: null });
    }
  }, flashMs);

  return () => clearTimeout(timer);
}

/**
 * Jump to a source location's originating block in a live editor: scroll it into
 * view, set the caret, and flash the accent ring. Composes
 * {@link scrollBlockIntoView} + {@link flashBlock}. Returns what it did (jumped /
 * fallback) plus the flash disposer.
 */
export function jumpToSource(
  editor: Editor,
  blockId: string,
  options: JumpToSourceOptions = {},
): { readonly result: JumpToSourceResult; readonly dispose: () => void } {
  const result = scrollBlockIntoView(editor, blockId, options);
  // Flash even on a fallback so the user sees *something* move; the kit's ring is
  // a no-op when the block isn't rendered (the node decoration simply finds no node).
  const dispose = flashBlock(editor, blockId, options.flashMs);
  return { result, dispose };
}

/** Escape a value for use inside a CSS attribute selector (ids are ULIDs, but be safe). */
function cssEscape(value: string): string {
  const cssApi = (globalThis as { CSS?: { escape?: (s: string) => string } }).CSS;
  if (cssApi?.escape) return cssApi.escape(value);
  return value.replace(/["\\]/g, "\\$&");
}
