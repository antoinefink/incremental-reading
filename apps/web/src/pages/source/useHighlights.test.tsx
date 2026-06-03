import type { SelectionLocation } from "@interleave/editor";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentMarkPayload } from "../../lib/appApi";

const h = vi.hoisted(() => ({
  desktop: true,
  listDocumentMarks: vi.fn(),
  addDocumentMark: vi.fn(),
  removeDocumentMark: vi.fn(),
}));

vi.mock("../../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../../lib/appApi")>("../../lib/appApi");
  return {
    ...actual,
    isDesktop: () => h.desktop,
    appApi: {
      listDocumentMarks: h.listDocumentMarks,
      addDocumentMark: h.addDocumentMark,
      removeDocumentMark: h.removeDocumentMark,
    },
  };
});

import { useHighlights } from "./useHighlights";

function mark(id: string, blockId: string, range: readonly [number, number]): DocumentMarkPayload {
  return { id, elementId: "src-1", blockId, markType: "highlight", range, attrs: null };
}

function location(overrides: Partial<SelectionLocation> = {}): SelectionLocation {
  return {
    blockIds: ["blk-a"],
    startOffset: 2,
    endOffset: 7,
    selectedText: "alpha",
    crossBlock: false,
    ...overrides,
  };
}

beforeEach(() => {
  h.desktop = true;
  h.listDocumentMarks.mockReset();
  h.addDocumentMark.mockReset();
  h.removeDocumentMark.mockReset();
  h.listDocumentMarks.mockResolvedValue({ marks: [mark("m-1", "blk-a", [2, 7])] });
  h.addDocumentMark.mockResolvedValue({ mark: mark("m-new", "blk-a", [2, 7]) });
  h.removeDocumentMark.mockResolvedValue({ removed: true });
});

describe("useHighlights", () => {
  it("loads persisted highlight marks as reader decorations", async () => {
    const { result } = renderHook(() => useHighlights("src-1"));

    await waitFor(() => expect(result.current.highlights).toHaveLength(1));
    expect(h.listDocumentMarks).toHaveBeenCalledWith({ elementId: "src-1", markType: "highlight" });
    expect(result.current.highlights[0]).toEqual({
      markId: "m-1",
      blockId: "blk-a",
      start: 2,
      end: 7,
    });
  });

  it("persists one highlight row per selected block and refreshes", async () => {
    h.listDocumentMarks
      .mockResolvedValueOnce({ marks: [] })
      .mockResolvedValueOnce({ marks: [mark("m-2", "blk-a", [2, Number.MAX_SAFE_INTEGER])] });
    const { result } = renderHook(() => useHighlights("src-1"));
    await waitFor(() => expect(h.listDocumentMarks).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.add(
        location({ blockIds: ["blk-a", "blk-b", "blk-c"], startOffset: 2, endOffset: 5 }),
      );
    });

    expect(h.addDocumentMark).toHaveBeenNthCalledWith(1, {
      elementId: "src-1",
      blockId: "blk-a",
      markType: "highlight",
      range: [2, Number.MAX_SAFE_INTEGER],
    });
    expect(h.addDocumentMark).toHaveBeenNthCalledWith(2, {
      elementId: "src-1",
      blockId: "blk-b",
      markType: "highlight",
      range: [0, Number.MAX_SAFE_INTEGER],
    });
    expect(h.addDocumentMark).toHaveBeenNthCalledWith(3, {
      elementId: "src-1",
      blockId: "blk-c",
      markType: "highlight",
      range: [0, 5],
    });
    expect(h.listDocumentMarks).toHaveBeenCalledTimes(2);
  });

  it("skips degenerate ranges and removes marks by id", async () => {
    const { result } = renderHook(() => useHighlights("src-1"));
    await waitFor(() => expect(result.current.highlights).toHaveLength(1));

    await act(async () => {
      await result.current.add(location({ startOffset: 3, endOffset: 3 }));
    });
    expect(h.addDocumentMark).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.remove("m-1");
    });
    expect(h.removeDocumentMark).toHaveBeenCalledWith({ markId: "m-1" });
  });

  it("does not call IPC outside desktop mode", () => {
    h.desktop = false;
    const { result } = renderHook(() => useHighlights("src-1"));

    expect(result.current.highlights).toEqual([]);
    expect(h.listDocumentMarks).not.toHaveBeenCalled();
  });
});
