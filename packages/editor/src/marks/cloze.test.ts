/**
 * Cloze mark extension tests (T034).
 *
 * The cloze mark renders `<span class="cloze" data-cloze-index="N">` and exposes
 * set/toggle/unset commands that delegate to ProseMirror's `addMark`/`removeMark`
 * (applied through Tiptap COMMANDS, never DOM surgery — so undo + serialization stay
 * correct). These run HEADLESSLY (no DOM) against a real ProseMirror schema built
 * from the constrained extension set PLUS the {@link Cloze} mark: they assert the
 * mark is in the schema, applies/removes over a selection range carrying its
 * `clozeIndex`, toggles, and round-trips its DOM spec.
 */

import { Node as PmNode } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";
import { buildSchema } from "../schema";
import { CLOZE_MARK_CLASS, CLOZE_MARK_NAME, Cloze } from "./cloze";

// The constrained schema PLUS the cloze mark, built via the package's own
// `buildSchema` so a single prosemirror-model instance is used.
const schema = buildSchema([Cloze]);

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

function buildState(): EditorState {
  return EditorState.create({ schema, doc: PmNode.fromJSON(schema, DOC) });
}

function clozeMark() {
  const markType = schema.marks[CLOZE_MARK_NAME];
  if (!markType) throw new Error("cloze mark missing from schema");
  return markType;
}

describe("Cloze mark", () => {
  it("registers the `cloze` mark in the schema", () => {
    expect(schema.marks[CLOZE_MARK_NAME]).toBeDefined();
  });

  it("applies the cloze mark with a clozeIndex over a selection range (addMark)", () => {
    const state = buildState();
    const markType = clozeMark();
    // Select "quick" (positions 5..10 in the paragraph text).
    const tr = state.tr.setSelection(TextSelection.create(state.doc, 5, 10));
    tr.addMark(5, 10, markType.create({ clozeIndex: 2 }));
    const next = state.apply(tr);
    expect(next.doc.rangeHasMark(5, 10, markType)).toBe(true);
    // The applied mark carries its cloze index.
    let foundIndex: number | null = null;
    next.doc.nodesBetween(5, 10, (node) => {
      const mark = node.marks.find((m) => m.type === markType);
      if (mark) foundIndex = mark.attrs.clozeIndex as number;
      return true;
    });
    expect(foundIndex).toBe(2);
  });

  it("toggles the cloze mark on and off over a selection (toggleMark)", () => {
    const markType = clozeMark();
    let state = buildState();
    state = state.apply(state.tr.addMark(5, 10, markType.create({ clozeIndex: 1 })));
    expect(state.doc.rangeHasMark(5, 10, markType)).toBe(true);
    state = state.apply(state.tr.removeMark(5, 10, markType));
    expect(state.doc.rangeHasMark(5, 10, markType)).toBe(false);
  });

  it('renders the cloze mark to a `<span class="cloze">` DOM spec (toDOM)', () => {
    const markType = clozeMark();
    const spec = markType.spec.toDOM?.(markType.create({ clozeIndex: 3 }), false);
    expect(Array.isArray(spec)).toBe(true);
    const out = spec as [string, Record<string, string>, number];
    expect(out[0]).toBe("span");
    expect(out[1].class).toBe(CLOZE_MARK_CLASS);
    expect(out[1]["data-cloze-index"]).toBe("3");
  });

  it("targets `span.cloze` in its parse rule", () => {
    expect(schema.marks[CLOZE_MARK_NAME]?.spec.parseDOM?.[0]?.tag).toBe("span.cloze");
  });
});
