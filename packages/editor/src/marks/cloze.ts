/**
 * Tiptap **cloze** mark (T034).
 *
 * A cloze mark records a cloze deletion span on a CARD body — the `{{cN::answer}}`
 * the user chose to hide. It renders `<span class="cloze">…</span>` (matching the
 * design kit's `.cloze` render) and carries a `clozeIndex` attribute (the 1-based
 * `cN` number) so a multi-cloze card's spans stay distinguishable. It is the FOURTH
 * of the M4/M6 marks, a sibling of highlight (T020), extracted-span (T021), and
 * processed-span (T026) in this folder — same `document_marks` table, different
 * `markType` (`cloze`), different semantics. A cloze mark creates NO element, NO
 * schedule, NO lineage (see the `MarkType` invariant in `@interleave/core`); the
 * card element + its scheduling come from `CardService` (T032).
 *
 * This module is framework-agnostic (it imports only `@tiptap/core`, which runs
 * headless under ProseMirror) so the mark + its commands are unit-testable without a
 * DOM. Marks are applied through these Tiptap COMMANDS — never DOM surgery — so undo
 * and JSON serialization stay correct.
 *
 * ## Persistence — how T034 actually stores cloze spans
 *
 * The canonical source of truth for a cloze card is `cards.cloze` (the numbered
 * `{{c1::answer}}` text); the structured model is the `@interleave/core`
 * {@link parseCloze} of that text. The cloze deletion spans are ALSO persisted as
 * `cloze` `document_marks` rows on the CARD body, keyed by the STABLE block id + a
 * `[start,end]` character range (so they re-anchor after a re-render), with
 * `attrs: { clozeIndex }` — reusing the existing T020 `documents.marks.*` surface
 * with `markType: "cloze"` (NO new table / op / IPC command). This extension exists
 * so a cloze span can be applied through a real Tiptap command (toggle/add/remove)
 * and so the `cloze` mark is a first-class, testable part of the schema; the
 * persisted source of truth is `cards.cloze` + the `document_marks` rows. The cloze
 * markers are NEVER written back into the source/extract body (that would corrupt the
 * extract) — they live on the card.
 */

import { Mark, mergeAttributes } from "@tiptap/core";

/** The ProseMirror mark name + the DOM class the design kit styles (`.cloze`). */
export const CLOZE_MARK_NAME = "cloze" as const;
export const CLOZE_MARK_CLASS = "cloze" as const;

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    interleaveCloze: {
      /** Apply the cloze mark (with a cloze index) to the current selection. */
      setCloze: (attributes?: { clozeIndex?: number }) => ReturnType;
      /** Toggle the cloze mark (with a cloze index) on the current selection. */
      toggleCloze: (attributes?: { clozeIndex?: number }) => ReturnType;
      /** Remove the cloze mark from the current selection. */
      unsetCloze: () => ReturnType;
    };
  }
}

/**
 * The cloze mark extension. Renders `<span class="cloze" data-cloze-index="N">`,
 * parses any `<span class="cloze">` back to the mark (reading `data-cloze-index`),
 * and exposes set/toggle/unset commands. Not part of the default constrained schema
 * (cloze spans persist as `document_marks`, not body marks); install it explicitly
 * where a live cloze command is wanted (and in the editor unit test).
 */
export const Cloze = Mark.create({
  name: CLOZE_MARK_NAME,

  // Cloze spans are "inclusive: false" so typing at a boundary does not extend the
  // deletion — the answer span should not grow as the user edits around it.
  inclusive: false,

  addAttributes() {
    return {
      clozeIndex: {
        default: 1,
        parseHTML: (element) => {
          const raw = element.getAttribute("data-cloze-index");
          const n = raw == null ? Number.NaN : Number.parseInt(raw, 10);
          return Number.isFinite(n) && n > 0 ? n : 1;
        },
        renderHTML: (attributes) => {
          const index = (attributes as { clozeIndex?: unknown }).clozeIndex;
          const n = typeof index === "number" && Number.isFinite(index) && index > 0 ? index : 1;
          return { "data-cloze-index": String(n) };
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: `span.${CLOZE_MARK_CLASS}` }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { class: CLOZE_MARK_CLASS }), 0];
  },

  addCommands() {
    return {
      setCloze:
        (attributes) =>
        ({ commands }) =>
          commands.setMark(this.name, attributes ?? {}),
      toggleCloze:
        (attributes) =>
        ({ commands }) =>
          commands.toggleMark(this.name, attributes ?? {}),
      unsetCloze:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    };
  },
});
