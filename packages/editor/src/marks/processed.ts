/**
 * Tiptap **processed-span** mark (T026).
 *
 * After the user has read/extracted a passage they can mark it **processed** so it
 * visually dims (`.dimmed`, matching the design kit's processed paragraphs) — a way
 * to declutter a long source WITHOUT deleting any content. A processed span is a
 * lightweight, fully REVERSIBLE reading annotation: it creates NO element, NO
 * schedule, and NO lineage (see the `MarkType` invariant in `@interleave/core`). It
 * is the THIRD of the M4 marks, a sibling of highlight (T020) and extracted-span
 * (T021) in this folder, deliberately kept separate (same `document_marks` table,
 * different `markType`, different semantics) — `processed_span` must never be
 * conflated with `highlight` (`mark.hl`) or `extracted_span` (`mark.extracted`).
 *
 * This module is framework-agnostic (it imports only `@tiptap/core`, which runs
 * headless under ProseMirror) so the mark + its commands are unit-testable without a
 * DOM. Marks are applied through these Tiptap COMMANDS — never DOM surgery — so undo
 * and JSON serialization stay correct, and the underlying source body is never
 * destroyed (the "never silently destroy user data" data rule).
 *
 * ## Persistence vs in-editor mark — how T026 actually stores processed spans
 *
 * The canonical persistence for a processed span is a `document_marks` row keyed by
 * the STABLE block id + a `[start,end]` character range (so it re-anchors after a
 * re-import — never an absolute ProseMirror position), reusing the T020
 * `DocumentRepository` mark methods + `documents.marks.*` bridge with
 * `markType: "processed_span"` (no new table / op / IPC command). The reader renders
 * persisted processed spans as ProseMirror *decorations* (the same overlay mechanism
 * the read-point divider / extracted markers / highlights use), not as stored inline
 * marks in the document JSON — that keeps them out of the body and out of the
 * extraction substrate. This extension exists so a processed span can still be
 * applied through a real Tiptap command (toggle/add/remove) and so the `dimmed` mark
 * is a first-class, testable part of the schema; the persisted source of truth is the
 * `document_marks` row.
 */

import { Mark, mergeAttributes } from "@tiptap/core";

/** The ProseMirror mark name + the DOM class the design kit styles (`.dimmed`). */
export const PROCESSED_MARK_NAME = "processedSpan" as const;
export const PROCESSED_MARK_CLASS = "dimmed" as const;

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    interleaveProcessedSpan: {
      /** Apply the processed-span mark to the current selection. */
      setProcessedSpan: () => ReturnType;
      /** Toggle the processed-span mark on the current selection. */
      toggleProcessedSpan: () => ReturnType;
      /** Remove the processed-span mark from the current selection. */
      unsetProcessedSpan: () => ReturnType;
    };
  }
}

/**
 * The processed-span mark extension. Renders `<mark class="dimmed">`, parses any
 * `<mark class="dimmed">` back to the mark, and exposes set/toggle/unset commands.
 * Not part of the default constrained schema (processed spans persist as
 * `document_marks`, not body marks); install it explicitly where a live
 * processed-span command is wanted (and in the editor unit test).
 */
export const ProcessedSpan = Mark.create({
  name: PROCESSED_MARK_NAME,

  // Processed spans are "inclusive: false" so typing at a boundary does not extend
  // the dimming — a reading annotation should not grow as the user edits.
  inclusive: false,

  parseHTML() {
    return [{ tag: `mark.${PROCESSED_MARK_CLASS}` }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["mark", mergeAttributes(HTMLAttributes, { class: PROCESSED_MARK_CLASS }), 0];
  },

  addCommands() {
    return {
      setProcessedSpan:
        () =>
        ({ commands }) =>
          commands.setMark(this.name),
      toggleProcessedSpan:
        () =>
        ({ commands }) =>
          commands.toggleMark(this.name),
      unsetProcessedSpan:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    };
  },
});
