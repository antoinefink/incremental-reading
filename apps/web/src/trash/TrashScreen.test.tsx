/**
 * TrashScreen component tests (T044, extended for T135 / U8).
 *
 * The soft-delete / restore / purge logic lives MAIN-side (`packages/local-db`
 * `TrashRepository` + `ElementRepository`); this asserts the RENDERER seam:
 *  - the trash list loads from `appApi.listTrash()` and renders each row with its
 *    title + "{type} · from {source} · deleted {when}" meta;
 *  - **Restore** calls `appApi.restoreFromTrash`, then re-reads the list;
 *  - permanent delete requires a CONFIRM before calling `appApi.purgeFromTrash`;
 *  - **Empty trash** requires a CONFIRM before calling `appApi.emptyTrash`;
 *  - the empty state renders when there is nothing to recover.
 *
 * T135 / U8: branch grouping (rows sharing a delete `batchId` restore as one unit),
 * the inline purge-guard recovery block, and the Empty-Trash skipped-count surfacing.
 *
 * Collaborators are mocked so the test exercises ONLY this component's wiring.
 */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrashItemSummary } from "../lib/appApi";
import { groupTrashRows } from "./TrashScreen";

function row(overrides: Partial<TrashItemSummary> = {}): TrashItemSummary {
  return {
    id: "el-1",
    type: "extract",
    title: "Spaced repetition beats massed practice",
    deletedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    originStatus: "active",
    sourceTitle: "On Memory",
    deleteBatchId: null,
    ...overrides,
  };
}

const h = vi.hoisted(() => ({
  listTrash: vi.fn(),
  restoreFromTrash: vi.fn(),
  restoreBatchFromTrash: vi.fn(),
  softDeleteSubtree: vi.fn(),
  purgeFromTrash: vi.fn(),
  emptyTrash: vi.fn(),
  undoLast: vi.fn(),
}));

vi.mock("../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../lib/appApi")>("../lib/appApi");
  return {
    ...actual,
    isDesktop: () => true,
    appApi: {
      listTrash: h.listTrash,
      restoreFromTrash: h.restoreFromTrash,
      restoreBatchFromTrash: h.restoreBatchFromTrash,
      softDeleteSubtree: h.softDeleteSubtree,
      purgeFromTrash: h.purgeFromTrash,
      emptyTrash: h.emptyTrash,
      undoLast: h.undoLast,
    },
  };
});

import { TrashScreen } from "./TrashScreen";

beforeEach(() => {
  vi.clearAllMocks();
  h.listTrash.mockResolvedValue({ items: [row()] });
  h.restoreFromTrash.mockResolvedValue({ item: { id: "el-1", status: "active" } });
  h.restoreBatchFromTrash.mockResolvedValue({
    restored: ["a", "b"],
    skipped: [],
    rootRestored: true,
  });
  h.softDeleteSubtree.mockResolvedValue({ batchId: "b", affected: [], skipped: [] });
  h.purgeFromTrash.mockResolvedValue({ purged: 1, blocked: false, liveDependents: 0 });
  h.emptyTrash.mockResolvedValue({ purged: 1, skipped: 0 });
  h.undoLast.mockResolvedValue({ undone: true, opType: "restore_element", label: "x", count: 1 });
});

describe("groupTrashRows", () => {
  it("folds rows sharing a batchId (2+) into one group, keeps singles", () => {
    const rows = [
      row({ id: "leaf", deleteBatchId: null }),
      row({ id: "root", deleteBatchId: "batch-1" }),
      row({ id: "child", deleteBatchId: "batch-1" }),
      row({ id: "lonely", deleteBatchId: "batch-2" }), // single member → not grouped
    ];
    const entries = groupTrashRows(rows);
    expect(entries.map((e) => e.kind)).toEqual(["single", "group", "single"]);
    const group = entries.find((e) => e.kind === "group");
    expect(group?.kind === "group" && group.members).toHaveLength(2);
    expect(group?.kind === "group" && group.batchId).toBe("batch-1");
  });
});

describe("TrashScreen", () => {
  it("lists trashed items with their type, source, and deletion time", async () => {
    render(<TrashScreen />);
    expect(await screen.findByTestId("trash-row")).toBeTruthy();
    expect(screen.getByTestId("trash-row-title").textContent).toContain("Spaced repetition");
    const meta = screen.getByTestId("trash-row").textContent ?? "";
    expect(meta).toContain("extract");
    expect(meta).toContain("from On Memory");
    expect(meta).toContain("deleted");
  });

  it("restores an item via appApi.restoreFromTrash and re-reads the list", async () => {
    render(<TrashScreen />);
    await screen.findByTestId("trash-row");
    fireEvent.click(screen.getByTestId("trash-restore"));
    await waitFor(() => expect(h.restoreFromTrash).toHaveBeenCalledWith({ id: "el-1" }));
    // The list is re-read after the action (initial load + reload).
    await waitFor(() => expect(h.listTrash.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it("requires a confirm before permanently deleting one item", async () => {
    render(<TrashScreen />);
    await screen.findByTestId("trash-row");
    // The first click only ARMS the confirm — it does not purge.
    fireEvent.click(screen.getByTestId("trash-purge"));
    expect(h.purgeFromTrash).not.toHaveBeenCalled();
    // Confirming purges.
    fireEvent.click(screen.getByTestId("trash-purge-yes"));
    await waitFor(() => expect(h.purgeFromTrash).toHaveBeenCalledWith({ id: "el-1" }));
  });

  // -------------------------------------------------------------------------
  // T135 / U8 — branch grouping.
  // -------------------------------------------------------------------------

  it("groups a branch delete into one entry with a child count + source, restoring as a unit (Covers R7/R10)", async () => {
    h.listTrash.mockResolvedValue({
      items: [
        row({ id: "root", title: "Mid-tree extract", deleteBatchId: "batch-9" }),
        row({ id: "sub", title: "Sub-extract", deleteBatchId: "batch-9" }),
        row({ id: "card", title: "Card", deleteBatchId: "batch-9" }),
      ],
    });
    render(<TrashScreen />);

    const group = await screen.findByTestId("trash-group");
    expect(within(group).getByTestId("trash-group-title").textContent).toContain(
      "Mid-tree extract",
    );
    expect(within(group).getByTestId("trash-group-count").textContent).toContain("3 items");
    expect(group.textContent).toContain("from On Memory");
    // Individual single rows are NOT shown for the grouped members.
    expect(screen.queryByTestId("trash-row-title")).toBeNull();

    // One Restore restores the whole batch via restoreBatch (root-first, atomic).
    fireEvent.click(within(group).getByTestId("trash-group-restore"));
    await waitFor(() =>
      expect(h.restoreBatchFromTrash).toHaveBeenCalledWith({ batchId: "batch-9" }),
    );
  });

  // -------------------------------------------------------------------------
  // T135 / U8 — purge-guard inline recovery (R12).
  // -------------------------------------------------------------------------

  it("shows the inline recovery block with working actions when a purge is blocked (Covers R12)", async () => {
    h.purgeFromTrash.mockResolvedValue({ purged: 0, blocked: true, liveDependents: 2 });
    render(<TrashScreen />);
    await screen.findByTestId("trash-row");
    fireEvent.click(screen.getByTestId("trash-purge"));
    fireEvent.click(screen.getByTestId("trash-purge-yes"));
    await waitFor(() => expect(h.purgeFromTrash).toHaveBeenCalledWith({ id: "el-1" }));

    // The dead-end error is replaced by the inline recovery block (not a trash-error).
    const guard = await screen.findByTestId("trash-purge-guard");
    expect(guard.textContent).toContain("still has live descendants");
    expect(screen.queryByTestId("trash-error")).toBeNull();
    // The row is still present (not reloaded away after a blocked purge).
    expect(screen.getByTestId("trash-row")).toBeTruthy();

    // "Delete branch" soft-cascades the whole live branch.
    fireEvent.click(screen.getByTestId("trash-guard-delete-branch"));
    await waitFor(() =>
      expect(h.softDeleteSubtree).toHaveBeenCalledWith({ id: "el-1", includeSubtree: true }),
    );
  });

  it("the recovery block's Restore restores the blocked row (Covers R12)", async () => {
    h.purgeFromTrash.mockResolvedValue({ purged: 0, blocked: true, liveDependents: 1 });
    render(<TrashScreen />);
    await screen.findByTestId("trash-row");
    fireEvent.click(screen.getByTestId("trash-purge"));
    fireEvent.click(screen.getByTestId("trash-purge-yes"));
    await screen.findByTestId("trash-purge-guard");

    fireEvent.click(screen.getByTestId("trash-guard-restore"));
    await waitFor(() => expect(h.restoreFromTrash).toHaveBeenCalledWith({ id: "el-1" }));
  });

  // -------------------------------------------------------------------------
  // T135 / U8 — Empty Trash skipped-count.
  // -------------------------------------------------------------------------

  it("requires a confirm before emptying the whole trash", async () => {
    render(<TrashScreen />);
    await screen.findByTestId("trash-row");
    fireEvent.click(screen.getByTestId("trash-empty"));
    expect(h.emptyTrash).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("trash-empty-yes"));
    await waitFor(() => expect(h.emptyTrash).toHaveBeenCalled());
  });

  it("surfaces the Empty-Trash skipped count (Covers R12/AE7)", async () => {
    h.emptyTrash.mockResolvedValue({ purged: 3, skipped: 1 });
    render(<TrashScreen />);
    await screen.findByTestId("trash-row");
    fireEvent.click(screen.getByTestId("trash-empty"));
    fireEvent.click(screen.getByTestId("trash-empty-yes"));
    const message = await screen.findByTestId("trash-error");
    expect(message.textContent).toContain("Emptied 3");
    expect(message.textContent).toContain("1 kept");
  });

  it("shows the empty state when there is nothing to recover", async () => {
    h.listTrash.mockResolvedValue({ items: [] });
    render(<TrashScreen />);
    expect(await screen.findByTestId("trash-empty-state")).toBeTruthy();
    expect(screen.getByText("Trash is empty")).toBeTruthy();
  });
});
