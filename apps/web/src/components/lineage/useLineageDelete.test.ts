/**
 * useLineageDelete controller test (T135 / U7).
 *
 * The load-bearing assertions: the BRANCH-delete snackbar Undo calls
 * `restoreBatchFromTrash({ batchId })` (KTD10 — order-independent), NOT `undoLast`; the
 * honorable topic "Rest" calls the fallow path and NEVER the extract-only `setFate`; the
 * kept-alive variants carry the `checkCircle` icon; the leaf path is a quiet single
 * soft-delete with an Undo via `undoLast`.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  desktop: true,
  softDeleteSubtree: vi.fn(),
  restoreBatchFromTrash: vi.fn(),
  undoLast: vi.fn(),
  setExtractFate: vi.fn(),
  fallowTopic: vi.fn(),
}));

vi.mock("../../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../../lib/appApi")>("../../lib/appApi");
  return {
    ...actual,
    isDesktop: () => h.desktop,
    appApi: {
      softDeleteSubtree: h.softDeleteSubtree,
      restoreBatchFromTrash: h.restoreBatchFromTrash,
      undoLast: h.undoLast,
      setExtractFate: h.setExtractFate,
      fallowTopic: h.fallowTopic,
    },
  };
});

import { useLineageDelete } from "./useLineageDelete";

const EXTRACT = { id: "ext-1", type: "extract", title: "An extract" };
const TOPIC = { id: "top-1", type: "topic", title: "A topic" };

beforeEach(() => {
  h.desktop = true;
  h.softDeleteSubtree
    .mockReset()
    .mockResolvedValue({ batchId: "batch-1", affected: [], skipped: [] });
  h.restoreBatchFromTrash
    .mockReset()
    .mockResolvedValue({ restored: [], skipped: [], rootRestored: true });
  h.undoLast
    .mockReset()
    .mockResolvedValue({ undone: true, opType: null, elementId: null, label: "", count: 1 });
  h.setExtractFate.mockReset().mockResolvedValue({ extract: {} });
  h.fallowTopic.mockReset().mockResolvedValue({ applied: 1, skipped: [], batchId: "fb-1" });
});

afterEach(() => vi.clearAllMocks());

describe("useLineageDelete", () => {
  it("quiet leaf delete soft-deletes the single node and raises an Undo snackbar (Covers R4)", async () => {
    const onAfter = vi.fn();
    const { result } = renderHook(() => useLineageDelete({ onAfter }));

    await act(async () => {
      await result.current.actions.quiet(EXTRACT);
    });

    expect(h.softDeleteSubtree).toHaveBeenCalledWith({ id: "ext-1", includeSubtree: false });
    expect(result.current.snackbar?.message).toBe("Extract deleted");
    expect(result.current.snackbar?.icon).toBe("trash");
    expect(onAfter).toHaveBeenCalledWith(EXTRACT, "quiet");

    // The leaf undo goes through the command-level undoLast.
    await act(async () => result.current.snackbar?.onUndo?.());
    await waitFor(() => expect(h.undoLast).toHaveBeenCalledTimes(1));
  });

  it("uses the host's quietDelete + suppresses its own snackbar when the host owns the undo", async () => {
    const quietDelete = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useLineageDelete({ quietDelete, hostOwnsQuietUndo: true }));

    await act(async () => {
      await result.current.actions.quiet(EXTRACT);
    });

    expect(quietDelete).toHaveBeenCalledWith(EXTRACT);
    expect(h.softDeleteSubtree).not.toHaveBeenCalled();
    expect(result.current.snackbar).toBeNull();
  });

  it("keep descendants tombstones the single node and reports kept count", async () => {
    const { result } = renderHook(() => useLineageDelete());

    await act(async () => {
      await result.current.actions.keepDescendants(EXTRACT, {
        extracts: 1,
        cards: 1,
        cardsWithHistory: 0,
        total: 2,
      });
    });

    expect(h.softDeleteSubtree).toHaveBeenCalledWith({ id: "ext-1", includeSubtree: false });
    expect(result.current.snackbar?.message).toBe("Extract removed — 2 items kept");
  });

  it("branch delete undo calls restoreBatch, NOT undoLast (Covers R10 / KTD10)", async () => {
    h.softDeleteSubtree.mockResolvedValue({
      batchId: "batch-xyz",
      affected: ["ext-1", "sub-1", "card-1"],
      skipped: [],
    });
    const { result } = renderHook(() => useLineageDelete());

    await act(async () => {
      await result.current.actions.deleteBranch(EXTRACT);
    });

    expect(h.softDeleteSubtree).toHaveBeenCalledWith({ id: "ext-1", includeSubtree: true });
    expect(result.current.snackbar?.message).toBe("Branch deleted (3 items)");

    await act(async () => result.current.snackbar?.onUndo?.());
    await waitFor(() =>
      expect(h.restoreBatchFromTrash).toHaveBeenCalledWith({ batchId: "batch-xyz" }),
    );
    // Crucially NOT the global undo (which would reverse an intervening action).
    expect(h.undoLast).not.toHaveBeenCalled();
  });

  it("a large branch gets a longer snackbar timeout", async () => {
    h.softDeleteSubtree.mockResolvedValue({
      batchId: "b",
      affected: Array.from({ length: 12 }, (_, i) => `n${i}`),
      skipped: [],
    });
    const { result } = renderHook(() => useLineageDelete());
    await act(async () => {
      await result.current.actions.deleteBranch(EXTRACT);
    });
    expect(result.current.snackbar?.timeoutMs).toBe(9000);
  });

  it("mark processed sets the extract done_without_card fate with the check icon (Covers R6)", async () => {
    const { result } = renderHook(() => useLineageDelete());
    await act(async () => {
      await result.current.actions.markProcessed(EXTRACT);
    });
    expect(h.setExtractFate).toHaveBeenCalledWith({ id: "ext-1", fate: "done_without_card" });
    expect(result.current.snackbar?.message).toBe("Extract marked done");
    expect(result.current.snackbar?.icon).toBe("checkCircle");
  });

  it("rest topic calls fallow and NEVER setFate (Covers R6 / KTD4)", async () => {
    const { result } = renderHook(() => useLineageDelete());
    await act(async () => {
      await result.current.actions.restTopic(TOPIC);
    });
    expect(h.fallowTopic).toHaveBeenCalledWith(
      expect.objectContaining({ topicId: "top-1", fallowUntil: expect.any(String) }),
    );
    expect(h.setExtractFate).not.toHaveBeenCalled();
    expect(result.current.snackbar?.message).toBe("Topic resting");
    expect(result.current.snackbar?.icon).toBe("checkCircle");
  });

  it("count-error fallthrough deletes safely with a no-undo error snackbar", async () => {
    const { result } = renderHook(() => useLineageDelete());
    await act(async () => {
      await result.current.actions.quietAfterCountError(EXTRACT, "read failed");
    });
    expect(h.softDeleteSubtree).toHaveBeenCalledWith({ id: "ext-1", includeSubtree: false });
    expect(result.current.snackbar?.message).toContain("couldn't check for descendants");
    expect(result.current.snackbar?.onUndo).toBeUndefined();
  });

  it("surfaces a mutation error as a no-undo snackbar", async () => {
    h.softDeleteSubtree.mockRejectedValue(new Error("db locked"));
    const { result } = renderHook(() => useLineageDelete());
    await act(async () => {
      await result.current.actions.keepDescendants(EXTRACT);
    });
    expect(result.current.snackbar?.message).toBe("db locked");
    expect(result.current.snackbar?.onUndo).toBeUndefined();
  });

  it("a FAILED branch-restore undo surfaces an error snackbar instead of silently closing (B2)", async () => {
    h.softDeleteSubtree.mockResolvedValue({
      batchId: "batch-err",
      affected: ["ext-1"],
      skipped: [],
    });
    h.restoreBatchFromTrash.mockRejectedValue(new Error("restore failed"));
    const { result } = renderHook(() => useLineageDelete());

    await act(async () => {
      await result.current.actions.deleteBranch(EXTRACT);
    });
    expect(result.current.snackbar?.onUndo).toBeDefined();

    await act(async () => result.current.snackbar?.onUndo?.());
    // The rejected restore is surfaced (not swallowed by the synchronous setSnackbar(null)).
    await waitFor(() => expect(result.current.snackbar?.message).toBe("restore failed"));
  });

  it("a FAILED keep-descendants undo (undoLast rejects) surfaces an error snackbar (B2)", async () => {
    h.undoLast.mockRejectedValue(new Error("undo failed"));
    const { result } = renderHook(() => useLineageDelete());

    await act(async () => {
      await result.current.actions.keepDescendants(EXTRACT, {
        extracts: 0,
        cards: 0,
        cardsWithHistory: 0,
        total: 1,
      });
    });
    await act(async () => result.current.snackbar?.onUndo?.());
    await waitFor(() => expect(result.current.snackbar?.message).toBe("undo failed"));
  });

  it("the in-flight guard resets after busy settles, so the action can fire again", async () => {
    const { result } = renderHook(() => useLineageDelete());

    await act(async () => {
      await result.current.actions.keepDescendants(EXTRACT);
    });
    // After the first action resolves, `busy` has settled back to false…
    expect(result.current.busy).toBe(false);
    expect(h.softDeleteSubtree).toHaveBeenCalledTimes(1);

    // …so a second invocation is NOT blocked by the in-flight guard (no deadlock).
    await act(async () => {
      await result.current.actions.keepDescendants(EXTRACT);
    });
    expect(h.softDeleteSubtree).toHaveBeenCalledTimes(2);
  });
});
