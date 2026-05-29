/**
 * Selection → source-location resolution (T019).
 *
 * The text-selection toolbar (T019) is the single entry point to every M4 action
 * (highlight, extract, cloze). Before any of those can persist lineage, the
 * renderer must turn a live ProseMirror selection into a STABLE, storable anchor:
 * the ordered list of block ids (from T016) the selection spans, plus the
 * character offsets within the first and last spanned block, plus a verbatim
 * snapshot of the selected text. That anchor is exactly the shape
 * `source_locations` stores (`blockIds`, `startOffset`, `endOffset`,
 * `selectedText`) and what T021's `extractions.create` / T020's `documents.marks`
 * consume — so resolving it correctly here is the load-bearing part of T019.
 *
 * This module is the headless, framework-free core of that resolution: it takes a
 * raw ProseMirror {@link EditorState} (what the live editor wrapper reads) and
 * returns a {@link SelectionLocation}, exactly like the sibling read-point helpers
 * (`resolveReadPointFromState`). It NEVER touches the DOM, `window.appApi`,
 * SQLite, or React — the renderer's `useTextSelection` hook owns the DOM rect +
 * UI state, and the toolbar is purely presentational. Keeping the offset/blockId
 * math here means it is unit-testable without standing up a DOM editor and reused
 * identically by the extract path (T021) and the sub-extract path (T025).
 *
 * Offsets are measured from the start of each block's text content (matching the
 * read-point `offset` semantics) so they line up with `document_blocks` text and
 * survive a re-import: marks/locations re-anchor by block id, never by absolute
 * ProseMirror position (see the M4 op-log note + the T020 "ranges are per stable
 * block id" risk).
 */

import type { EditorState } from "@tiptap/pm/state";
import { BLOCK_ID_NODE_TYPES } from "./block-id";

const BLOCK_ID_NODE_SET = new Set<string>(BLOCK_ID_NODE_TYPES);

/**
 * A resolved selection anchor: the ordered stable block ids the selection spans,
 * the character offset within the FIRST spanned block where the selection starts,
 * the character offset within the LAST spanned block where it ends, and a verbatim
 * snapshot of the selected text. This is the renderer-side shape the toolbar hands
 * to `documents.marks.add` (T020) and `extractions.create` (T021); on the main
 * side it maps directly onto `source_locations` (`blockIds` / `startOffset` /
 * `endOffset` / `selectedText`).
 */
export interface SelectionLocation {
  /** Ordered stable block ids spanned by the selection (≥ 1, document order). */
  readonly blockIds: readonly string[];
  /** Char offset within the FIRST spanned block where the selection starts. */
  readonly startOffset: number;
  /** Char offset within the LAST spanned block where the selection ends. */
  readonly endOffset: number;
  /** Verbatim snapshot of the selected text (the user's exact selection). */
  readonly selectedText: string;
  /** Whether the selection spans more than one block (cross-block select). */
  readonly crossBlock: boolean;
}

/**
 * Find the nearest enclosing block-level node (one carrying a non-empty
 * `blockId`) at a given resolved position, returning the block id, the absolute
 * position of the block's start, and the block's text length. Returns `null` when
 * the position is not inside an id'd block (e.g. an un-id'd freshly typed block).
 */
function blockAt(
  $pos: ReturnType<EditorState["doc"]["resolve"]>,
): { blockId: string; blockStart: number; textLen: number } | null {
  for (let depth = $pos.depth; depth >= 0; depth--) {
    const node = $pos.node(depth);
    if (!BLOCK_ID_NODE_SET.has(node.type.name)) continue;
    const blockId = node.attrs.blockId as string | null | undefined;
    if (typeof blockId !== "string" || blockId.length === 0) continue;
    return { blockId, blockStart: $pos.start(depth), textLen: node.textContent.length };
  }
  return null;
}

/**
 * Resolve the {@link SelectionLocation} for a raw ProseMirror {@link EditorState}.
 *
 * Returns `null` when there is nothing to act on:
 *  - the selection is empty (a bare caret — no run of text), or
 *  - the selection's endpoints are not inside id'd block-level nodes.
 *
 * For a single-block selection `blockIds` has one entry and `start/endOffset` are
 * the caret offsets within it. For a CROSS-BLOCK selection it returns EVERY block
 * id from the first to the last spanned block in document order (so extraction can
 * record the full span — see the T019 "cross-node selections must still resolve a
 * multi-block location" note), with `startOffset` in the first block and
 * `endOffset` in the last. Pure + DOM-free, so it is unit-testable headlessly.
 */
export function resolveSelectionLocation(state: EditorState): SelectionLocation | null {
  const { from, to, empty } = state.selection;
  if (empty || from === to) return null;

  const fromBlock = blockAt(state.doc.resolve(from));
  const toBlock = blockAt(state.doc.resolve(to));
  if (!fromBlock || !toBlock) return null;

  // Walk the doc once to collect, in order, every id'd block whose range overlaps
  // [from, to]. A block "starts" at blockStart and spans textLen chars of text, so
  // it overlaps the selection when its start is < `to` and its end is > `from`.
  const blockIds: string[] = [];
  state.doc.descendants((node, pos) => {
    if (!BLOCK_ID_NODE_SET.has(node.type.name)) return true;
    const blockId = node.attrs.blockId as string | null | undefined;
    if (typeof blockId !== "string" || blockId.length === 0) return true;
    const blockStart = pos + 1; // step inside the block node to its text
    const blockEnd = blockStart + node.textContent.length;
    // Overlap test (inclusive of touching the boundary so a selection ending at a
    // block's start still includes the block it starts in, not the previous one).
    if (blockStart <= to && blockEnd >= from) blockIds.push(blockId);
    return true;
  });

  // Defensive fallback: if the overlap walk somehow missed the endpoints (e.g. an
  // atom block), still record the resolved endpoints' blocks in order.
  if (blockIds.length === 0) {
    blockIds.push(fromBlock.blockId);
    if (toBlock.blockId !== fromBlock.blockId) blockIds.push(toBlock.blockId);
  }

  const startOffset = Math.max(0, Math.min(from - fromBlock.blockStart, fromBlock.textLen));
  const endOffset = Math.max(0, Math.min(to - toBlock.blockStart, toBlock.textLen));
  // `textBetween` with a block separator mirrors `Node.textContent` across blocks,
  // so the snapshot reads as the user sees it (one newline between paragraphs).
  const selectedText = state.doc.textBetween(from, to, "\n", "\n");

  return {
    blockIds,
    startOffset,
    endOffset,
    selectedText,
    crossBlock: blockIds.length > 1,
  };
}
