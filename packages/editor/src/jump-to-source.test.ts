import type { Editor } from "@tiptap/core";
import { Node as PmNode } from "@tiptap/pm/model";
import { EditorState, type Transaction } from "@tiptap/pm/state";
import { afterEach, describe, expect, it, vi } from "vitest";
import { flashBlock, JUMP_FLASH_MS, jumpToSource, scrollBlockIntoView } from "./jump-to-source";
import { createReaderDecorationsPlugin, readerDecorationsKey } from "./reader-decorations";
import { buildSchema } from "./schema";

const schema = buildSchema();

const docJson = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      attrs: { blockId: "b1" },
      content: [{ type: "text", text: "First block" }],
    },
    {
      type: "paragraph",
      attrs: { blockId: "b2" },
      content: [{ type: "text", text: "Second block" }],
    },
  ],
};

function makeEditor() {
  let state = EditorState.create({
    schema,
    doc: PmNode.fromJSON(schema, docJson),
    plugins: [createReaderDecorationsPlugin()],
  });
  const selections: number[] = [];
  const editor = {
    get state() {
      return state;
    },
    commands: {
      setTextSelection: (pos: number) => {
        selections.push(pos);
        return true;
      },
    },
    view: {
      dom: { querySelector: vi.fn() },
      dispatch: (tr: Transaction) => {
        state = state.apply(tr);
      },
    },
  } as unknown as Editor;

  return { editor, selections, state: () => state };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("scrollBlockIntoView", () => {
  it("finds a stable block id and clamps the stored offset", () => {
    const { editor, selections } = makeEditor();
    const result = scrollBlockIntoView(editor, "b1", { offset: 999, scroll: false });

    expect(result).toEqual({ kind: "jumped", blockId: "b1", offset: "First block".length });
    expect(selections).toHaveLength(1);
    expect(selections[0]).toBeGreaterThan(0);
  });

  it("falls back to the document start when the block is missing", () => {
    const { editor, selections } = makeEditor();
    const result = scrollBlockIntoView(editor, "missing", { offset: 4, scroll: false });

    expect(result).toEqual({ kind: "fallback", reason: "missing-block" });
    expect(selections).toEqual([0]);
  });
});

describe("flashBlock", () => {
  it("sets and clears the transient flashed block decoration", () => {
    vi.useFakeTimers();
    const { editor, state } = makeEditor();

    const dispose = flashBlock(editor, "b2", 25);
    expect(readerDecorationsKey.getState(state())?.flashedBlockId).toBe("b2");

    vi.advanceTimersByTime(25);
    expect(readerDecorationsKey.getState(state())?.flashedBlockId).toBeNull();
    dispose();
  });

  it("uses the documented default flash duration", () => {
    expect(JUMP_FLASH_MS).toBe(1800);
  });
});

describe("jumpToSource", () => {
  it("scrolls and flashes in one call", () => {
    vi.useFakeTimers();
    const { editor, state } = makeEditor();

    const { result, dispose } = jumpToSource(editor, "b1", { offset: 2, scroll: false });

    expect(result).toEqual({ kind: "jumped", blockId: "b1", offset: 2 });
    expect(readerDecorationsKey.getState(state())?.flashedBlockId).toBe("b1");
    dispose();
  });
});
