/**
 * Reader decoration plugin tests (T018).
 *
 * The reader overlays a `.readpoint` divider + `mark.extracted` display markers on
 * the live editor as ProseMirror DECORATIONS (not DOM mutation), anchored to the
 * stable block ids (T016). These tests run headlessly against an `EditorState`
 * built with the constrained schema + the {@link ReaderDecorations} plugin: they
 * push inputs through {@link setReaderDecorations}'s meta and assert the resulting
 * `DecorationSet` carries the right node/widget decorations — no DOM/browser, so
 * they run in plain Vitest. (The end-to-end DOM rendering is covered by the
 * Playwright reader spec.)
 */

import { Node as PmNode } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { DecorationSet } from "@tiptap/pm/view";
import { describe, expect, it } from "vitest";
import { fillMissingBlockIds } from "./block-id";
import type { newBlockId } from "./block-ids";
import {
  createReaderDecorationsPlugin,
  type ReaderDecorationState,
  readerDecorationsKey,
} from "./reader-decorations";
import { buildSchema } from "./schema";

// One schema (the constrained one, with the `blockId` attribute) shared by all
// tests — building it via the package's own `buildSchema` keeps a single
// prosemirror-model instance (mixing compile paths loads two and throws).
const schema = buildSchema();

/** Build a headless EditorState with the reader-decoration plugin installed. */
function buildState(docJson: unknown): EditorState {
  return EditorState.create({
    schema,
    doc: PmNode.fromJSON(schema, docJson),
    plugins: [createReaderDecorationsPlugin()],
  });
}

/** A deterministic, monotonic minter so test expectations are stable. */
function counterMinter(prefix = "id") {
  let n = 0;
  return () => `${prefix}_${String(n++).padStart(3, "0")}` as ReturnType<typeof newBlockId>;
}

/** Run the REAL filler over plain doc JSON → the runtime id distribution (one per row). */
function fillOnce(json: unknown, mint = counterMinter()): unknown {
  let state = EditorState.create({ schema, doc: PmNode.fromJSON(schema, json) });
  const tr = fillMissingBlockIds(state, mint);
  if (tr) state = state.apply(tr);
  return state.doc.toJSON();
}

/** The blockId on the FIRST node of a given type in filled doc JSON. */
function firstBlockIdOfType(json: unknown, type: string): string {
  const doc = PmNode.fromJSON(schema, json);
  let id: string | null = null;
  doc.descendants((node) => {
    if (id) return false;
    if (node.type.name === type) {
      id = (node.attrs.blockId as string | null) ?? null;
      return false;
    }
    return true;
  });
  if (!id) throw new Error(`no ${type} with a blockId in fixture`);
  return id;
}

const PARA = (text: string, blockId: string) => ({
  type: "paragraph",
  attrs: { blockId },
  content: [{ type: "text", text }],
});

const DOC = {
  type: "doc",
  content: [PARA("first", "b1"), PARA("second", "b2"), PARA("third", "b3")],
};

/** A fully-defaulted decoration-input state; spread + override the fields a test needs. */
const BASE: ReaderDecorationState = {
  firstUnreadBlockId: null,
  readPointBlockId: null,
  extractedBlockIds: [],
  highlights: [],
  processed: [],
  flashedBlockId: null,
};

/** Apply a decoration-input meta to the state (mirrors `setReaderDecorations`). */
function withInputs(state: EditorState, inputs: Partial<ReaderDecorationState>): EditorState {
  const tr = state.tr.setMeta(readerDecorationsKey, { state: { ...BASE, ...inputs } });
  return state.apply(tr);
}

/** A structural view of a decoration's runtime internals (not in the public types). */
interface DecorationInternal {
  readonly type?: { readonly attrs?: Record<string, string> };
  readonly spec?: { readonly key?: string };
}

/** Read the plugin's current decoration set (its `decorations` prop output). */
function decorationsOf(state: EditorState): DecorationSet {
  const plugin = readerDecorationsKey.get(state);
  const set = plugin?.props.decorations?.call(plugin, state) as DecorationSet | null | undefined;
  return set ?? DecorationSet.empty;
}

describe("ReaderDecorations plugin", () => {
  it("draws no decorations when no inputs are pushed", () => {
    const state = buildState(DOC);
    const set = decorationsOf(state);
    expect(set.find()).toHaveLength(0);
  });

  it("adds the `extracted` class to extracted blocks only", () => {
    const state = withInputs(buildState(DOC), {
      firstUnreadBlockId: null,
      readPointBlockId: null,
      extractedBlockIds: ["b2"],
    });
    const decos = decorationsOf(state).find();
    // One node decoration carrying the `extracted` class (node-decoration attrs
    // live on `decoration.type.attrs`).
    const extracted = decos.filter((d) =>
      (d as unknown as DecorationInternal).type?.attrs?.class?.includes("extracted"),
    );
    expect(extracted).toHaveLength(1);
  });

  it("inserts a widget divider before the first unread block", () => {
    const state = withInputs(buildState(DOC), {
      firstUnreadBlockId: "b2",
      readPointBlockId: "b1",
      extractedBlockIds: [],
    });
    const decos = decorationsOf(state).find();
    // A widget decoration keyed to the read-point divider exists.
    const widget = decos.filter(
      (d) => (d as unknown as DecorationInternal).spec?.key === "readpoint-divider",
    );
    expect(widget).toHaveLength(1);
  });

  it("marks the read-point block with the resume-anchor attribute", () => {
    const state = withInputs(buildState(DOC), {
      firstUnreadBlockId: "b2",
      readPointBlockId: "b1",
      extractedBlockIds: [],
    });
    const decos = decorationsOf(state).find();
    const anchor = decos.filter(
      (d) => (d as unknown as DecorationInternal).type?.attrs?.["data-readpoint-block"] === "true",
    );
    expect(anchor).toHaveLength(1);
  });

  it("re-derives decorations after the inputs change (idempotent push)", () => {
    let state = withInputs(buildState(DOC), {
      firstUnreadBlockId: "b2",
      readPointBlockId: null,
      extractedBlockIds: ["b1"],
    });
    expect(decorationsOf(state).find()).not.toHaveLength(0);
    // Clear the inputs again → no decorations.
    state = withInputs(state, {
      firstUnreadBlockId: null,
      readPointBlockId: null,
      extractedBlockIds: [],
    });
    expect(decorationsOf(state).find()).toHaveLength(0);
  });

  it("overlays a persisted highlight as an inline `hl` decoration with its mark id", () => {
    const state = withInputs(buildState(DOC), {
      highlights: [{ markId: "m1", blockId: "b2", start: 0, end: 6 }],
    });
    const decos = decorationsOf(state).find();
    const inline = decos.filter(
      (d) => (d as unknown as DecorationInternal).type?.attrs?.class === "hl",
    );
    expect(inline).toHaveLength(1);
    expect((inline[0] as unknown as DecorationInternal).type?.attrs?.["data-mark-id"]).toBe("m1");
  });

  it("clamps a highlight range to the block text length", () => {
    // "first" is 5 chars; an end of 999 must clamp so the decoration never runs
    // past the block (a stale/over-long range can't produce a bad position).
    const state = withInputs(buildState(DOC), {
      highlights: [{ markId: "m1", blockId: "b1", start: 0, end: 999 }],
    });
    const inline = decorationsOf(state)
      .find()
      .filter((d) => (d as unknown as DecorationInternal).type?.attrs?.class === "hl");
    expect(inline).toHaveLength(1);
    // The decoration's `to` must not exceed the block's text end (b1 text = "first").
    const deco = inline[0];
    if (!deco) throw new Error("expected one highlight decoration");
    expect(deco.to - deco.from).toBe(5);
  });

  it("drops a degenerate highlight (end <= start) without throwing", () => {
    const state = withInputs(buildState(DOC), {
      highlights: [{ markId: "m1", blockId: "b1", start: 3, end: 3 }],
    });
    const inline = decorationsOf(state)
      .find()
      .filter((d) => (d as unknown as DecorationInternal).type?.attrs?.class === "hl");
    expect(inline).toHaveLength(0);
  });

  it("rings the flashed block with the `jumped` class (T022 jump-to-source)", () => {
    const state = withInputs(buildState(DOC), { flashedBlockId: "b3" });
    const decos = decorationsOf(state).find();
    const jumped = decos.filter((d) =>
      (d as unknown as DecorationInternal).type?.attrs?.class?.includes("jumped"),
    );
    expect(jumped).toHaveLength(1);
    // And it carries the `data-jumped` flag for DOM-side assertions.
    const flagged = decos.filter(
      (d) => (d as unknown as DecorationInternal).type?.attrs?.["data-jumped"] === "true",
    );
    expect(flagged).toHaveLength(1);
  });

  it("clears the flash when `flashedBlockId` is reset to null", () => {
    let state = withInputs(buildState(DOC), { flashedBlockId: "b1" });
    expect(
      decorationsOf(state)
        .find()
        .filter((d) => (d as unknown as DecorationInternal).type?.attrs?.class?.includes("jumped")),
    ).toHaveLength(1);
    state = withInputs(state, { flashedBlockId: null });
    expect(
      decorationsOf(state)
        .find()
        .filter((d) => (d as unknown as DecorationInternal).type?.attrs?.class?.includes("jumped")),
    ).toHaveLength(0);
  });

  it("dims a processed block with the `dimmed` class + its mark id (T026)", () => {
    const state = withInputs(buildState(DOC), {
      processed: [{ markId: "p1", blockId: "b2" }],
    });
    const decos = decorationsOf(state).find();
    const dimmed = decos.filter((d) =>
      (d as unknown as DecorationInternal).type?.attrs?.class?.includes("dimmed"),
    );
    expect(dimmed).toHaveLength(1);
    // The restore button reads the backing `document_marks.id` off this attr.
    expect(
      (dimmed[0] as unknown as DecorationInternal).type?.attrs?.["data-processed-mark-id"],
    ).toBe("p1");
  });

  it("removes the dimming when the processed input is cleared (reversible)", () => {
    let state = withInputs(buildState(DOC), {
      processed: [{ markId: "p1", blockId: "b2" }],
    });
    expect(
      decorationsOf(state)
        .find()
        .filter((d) => (d as unknown as DecorationInternal).type?.attrs?.class?.includes("dimmed")),
    ).toHaveLength(1);
    state = withInputs(state, { processed: [] });
    expect(
      decorationsOf(state)
        .find()
        .filter((d) => (d as unknown as DecorationInternal).type?.attrs?.class?.includes("dimmed")),
    ).toHaveLength(0);
  });

  describe("nested rows (list item / blockquote) — one decoration per row", () => {
    // A doc with the runtime id distribution: one id on the listItem, one on the
    // blockquote, none on their inner paragraphs.
    const NESTED = fillOnce({
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [{ type: "paragraph", content: [{ type: "text", text: "hello world" }] }],
            },
          ],
        },
        {
          type: "blockquote",
          content: [{ type: "paragraph", content: [{ type: "text", text: "quoted text" }] }],
        },
      ],
    });
    const LI_ID = firstBlockIdOfType(NESTED, "listItem");
    const BQ_ID = firstBlockIdOfType(NESTED, "blockquote");

    it("renders a list-row highlight as exactly ONE inline `hl` decoration (not two overlapping)", () => {
      // The duplicate-id bug wrote two `document_marks` rows for one row and the
      // reader drew two overlapping `<mark class="hl">` over the same text. With one
      // id per row there is exactly ONE highlight decoration.
      const state = withInputs(buildState(NESTED), {
        highlights: [{ markId: "m1", blockId: LI_ID, start: 0, end: 5 }],
      });
      const inline = decorationsOf(state)
        .find()
        .filter((d) => (d as unknown as DecorationInternal).type?.attrs?.class === "hl");
      expect(inline).toHaveLength(1);
      expect((inline[0] as unknown as DecorationInternal).type?.attrs?.["data-mark-id"]).toBe("m1");
    });

    it("marks a list row extracted exactly ONCE (single node decoration on the row)", () => {
      const state = withInputs(buildState(NESTED), { extractedBlockIds: [LI_ID] });
      const extracted = decorationsOf(state)
        .find()
        .filter((d) =>
          (d as unknown as DecorationInternal).type?.attrs?.class?.includes("extracted"),
        );
      expect(extracted).toHaveLength(1);
    });

    it("highlights a blockquote row as exactly ONE inline `hl` decoration", () => {
      const state = withInputs(buildState(NESTED), {
        highlights: [{ markId: "m2", blockId: BQ_ID, start: 0, end: 6 }],
      });
      const inline = decorationsOf(state)
        .find()
        .filter((d) => (d as unknown as DecorationInternal).type?.attrs?.class === "hl");
      expect(inline).toHaveLength(1);
    });
  });

  describe("multi-text-run rows — highlight in the 2nd run maps to the right characters", () => {
    // Finding (major): the inline-highlight mapping anchored to the FIRST text run
    // only, so a highlight in the 2nd paragraph of a multi-paragraph blockquote /
    // list item rendered shifted by the inter-run token count. These assert the
    // decoration's absolute [from,to] cover EXACTLY the stored textContent range,
    // computed independently of the mapping under test.

    /** Absolute [from,to] of a textContent range in a block, via its text nodes. */
    function absRangeOfTextRange(
      json: unknown,
      blockId: string,
      start: number,
      end: number,
    ): [number, number] {
      const doc = PmNode.fromJSON(schema, json);
      let blockNode: PmNode | null = null;
      let blockPos = -1;
      doc.descendants((node, pos) => {
        if (blockNode) return false;
        if ((node.attrs.blockId as string | null | undefined) === blockId) {
          blockNode = node;
          blockPos = pos;
          return false;
        }
        return true;
      });
      if (!blockNode || blockPos < 0) throw new Error(`no block ${blockId}`);
      const contentStart = blockPos + 1;
      let consumed = 0;
      let from = -1;
      let to = -1;
      // Anchor an offset AT a run boundary to the START of the NEXT run (strict `<`),
      // skipping the inter-run tokens — matching `blockOffsetToPos`, so the
      // independently-computed expectation agrees with the production mapping.
      (blockNode as PmNode).descendants((child, relPos) => {
        if (!child.isText || typeof child.text !== "string") return true;
        const len = child.text.length;
        if (from < 0 && start < consumed + len) from = contentStart + relPos + (start - consumed);
        if (to < 0 && end < consumed + len) to = contentStart + relPos + (end - consumed);
        consumed += len;
        return false;
      });
      // An end exactly at the block text end anchors to the end of the last run.
      if (to < 0) to = contentStart + (blockNode as PmNode).content.size;
      if (from < 0) throw new Error("range out of block text");
      return [from, to];
    }

    const MULTI_BQ = fillOnce({
      type: "doc",
      content: [
        {
          type: "blockquote",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "alpha line" }] },
            { type: "paragraph", content: [{ type: "text", text: "beta line" }] },
          ],
        },
      ],
    });
    const MULTI_BQ_ID = firstBlockIdOfType(MULTI_BQ, "blockquote");

    it("places a 2nd-paragraph blockquote highlight over the exact textContent range", () => {
      // textContent "alpha linebeta line"; highlight "beta" = [10,14]. The old math
      // would have shifted this by the inter-run token count and covered "ta l".
      const state = withInputs(buildState(MULTI_BQ), {
        highlights: [{ markId: "m1", blockId: MULTI_BQ_ID, start: 10, end: 14 }],
      });
      const inline = decorationsOf(state)
        .find()
        .filter((d) => (d as unknown as DecorationInternal).type?.attrs?.class === "hl");
      expect(inline).toHaveLength(1);
      const deco = inline[0];
      if (!deco) throw new Error("expected one highlight decoration");
      const [expectFrom, expectTo] = absRangeOfTextRange(MULTI_BQ, MULTI_BQ_ID, 10, 14);
      expect(deco.from).toBe(expectFrom);
      expect(deco.to).toBe(expectTo);
      // And the covered slice of the actual document text is exactly "beta".
      const doc = PmNode.fromJSON(schema, MULTI_BQ);
      expect(doc.textBetween(deco.from, deco.to)).toBe("beta");
    });

    const MULTI_LI = fillOnce({
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "first para" }] },
                { type: "paragraph", content: [{ type: "text", text: "second para" }] },
              ],
            },
          ],
        },
      ],
    });
    const MULTI_LI_ID = firstBlockIdOfType(MULTI_LI, "listItem");

    it("places a 2nd-paragraph list-item highlight over the exact textContent range", () => {
      // textContent "first parasecond para"; highlight "second" = [10,16].
      const state = withInputs(buildState(MULTI_LI), {
        highlights: [{ markId: "m1", blockId: MULTI_LI_ID, start: 10, end: 16 }],
      });
      const inline = decorationsOf(state)
        .find()
        .filter((d) => (d as unknown as DecorationInternal).type?.attrs?.class === "hl");
      expect(inline).toHaveLength(1);
      const deco = inline[0];
      if (!deco) throw new Error("expected one highlight decoration");
      const doc = PmNode.fromJSON(schema, MULTI_LI);
      expect(doc.textBetween(deco.from, deco.to)).toBe("second");
    });
  });
});
