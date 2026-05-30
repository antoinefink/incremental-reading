/**
 * Processed-span mark extension tests (T026).
 *
 * The processed-span mark renders `<mark class="dimmed">` and exposes set/toggle/unset
 * commands that delegate to ProseMirror's `addMark`/`removeMark` (applied through
 * Tiptap COMMANDS, never DOM surgery — so undo + serialization stay correct and the
 * source body is never destroyed). These run HEADLESSLY (no DOM, matching the sibling
 * `highlight` / `reader-decorations` tests) against a real ProseMirror schema built
 * from the constrained extension set PLUS the {@link ProcessedSpan} mark: they assert
 * the mark is in the schema, applies/removes over a selection range, round-trips
 * to/from `<mark class="dimmed">` HTML, and is DISTINCT from the highlight mark
 * (different name / class — `processed_span` must never be conflated with `highlight`).
 */

import { Node as PmNode } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";
import { buildSchema } from "../schema";
import { HIGHLIGHT_MARK_CLASS, Highlight } from "./highlight";
import { PROCESSED_MARK_CLASS, PROCESSED_MARK_NAME, ProcessedSpan } from "./processed";

// The constrained schema PLUS the processed-span AND highlight marks, built via the
// package's own `buildSchema` so a single prosemirror-model instance is used (mixing
// compile paths loads two copies and throws). Including highlight lets us assert the
// two marks stay strictly separate.
const schema = buildSchema([ProcessedSpan, Highlight]);

const DOC = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      attrs: { blockId: "b1" },
      content: [{ type: "text", text: "the quick brown fox" }],
    },
  ],
};

/** Build a headless EditorState over the constrained-plus-marks schema. */
function buildState(): EditorState {
  return EditorState.create({ schema, doc: PmNode.fromJSON(schema, DOC) });
}

/** The processed-span mark type from the schema (asserted present). */
function processedMark() {
  const markType = schema.marks[PROCESSED_MARK_NAME];
  if (!markType) throw new Error("processed-span mark missing from schema");
  return markType;
}

describe("ProcessedSpan mark", () => {
  it("registers the `processedSpan` mark in the schema", () => {
    expect(schema.marks[PROCESSED_MARK_NAME]).toBeDefined();
  });

  it("applies the processed-span mark over a selection range (addMark)", () => {
    const state = buildState();
    const markType = processedMark();
    // Select "quick" (positions 5..10 in the paragraph text).
    const tr = state.tr.setSelection(TextSelection.create(state.doc, 5, 10));
    tr.addMark(5, 10, markType.create());
    const next = state.apply(tr);
    expect(next.doc.rangeHasMark(5, 10, markType)).toBe(true);
    expect(next.doc.rangeHasMark(1, 4, markType)).toBe(false);
    // The body text is UNCHANGED — dimming never destroys content.
    expect(next.doc.textContent).toBe("the quick brown fox");
  });

  it("removes the processed-span mark over a selection range (removeMark) — fully reversible", () => {
    const markType = processedMark();
    let state = buildState();
    state = state.apply(state.tr.addMark(5, 10, markType.create()));
    expect(state.doc.rangeHasMark(5, 10, markType)).toBe(true);
    state = state.apply(state.tr.removeMark(5, 10, markType));
    expect(state.doc.rangeHasMark(5, 10, markType)).toBe(false);
    // Restoring leaves the text intact.
    expect(state.doc.textContent).toBe("the quick brown fox");
  });

  it('renders the processed-span to a `<mark class="dimmed">` DOM spec (toDOM)', () => {
    const markType = processedMark();
    const spec = markType.spec.toDOM?.(markType.create(), false);
    expect(Array.isArray(spec)).toBe(true);
    const out = spec as [string, Record<string, string>, number];
    expect(out[0]).toBe("mark");
    expect(out[1].class).toBe(PROCESSED_MARK_CLASS);
  });

  it("parses `mark.dimmed` HTML back into the processed-span mark (parse rule)", () => {
    expect(schema.marks[PROCESSED_MARK_NAME]?.spec.parseDOM?.[0]?.tag).toBe("mark.dimmed");
  });

  it("stays strictly separate from the highlight mark (distinct name + class)", () => {
    // processed_span must never be conflated with highlight: different mark name and
    // a different DOM class so they render + persist independently.
    expect(PROCESSED_MARK_NAME).not.toBe("highlight");
    expect(PROCESSED_MARK_CLASS).toBe("dimmed");
    expect(HIGHLIGHT_MARK_CLASS).toBe("hl");
    expect(PROCESSED_MARK_CLASS).not.toBe(HIGHLIGHT_MARK_CLASS);
  });
});
