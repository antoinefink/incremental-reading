/**
 * TrashScreen component tests (T044).
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
 * Collaborators are mocked so the test exercises ONLY this component's wiring.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrashItemSummary } from "../lib/appApi";

const h = vi.hoisted(() => {
  const item: TrashItemSummary = {
    id: "el-1",
    type: "extract",
    title: "Spaced repetition beats massed practice",
    deletedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    originStatus: "active",
    sourceTitle: "On Memory",
  };
  return {
    item,
    listTrash: vi.fn(),
    restoreFromTrash: vi.fn(),
    purgeFromTrash: vi.fn(),
    emptyTrash: vi.fn(),
    undoLast: vi.fn(),
  };
});

vi.mock("../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../lib/appApi")>("../lib/appApi");
  return {
    ...actual,
    isDesktop: () => true,
    appApi: {
      listTrash: h.listTrash,
      restoreFromTrash: h.restoreFromTrash,
      purgeFromTrash: h.purgeFromTrash,
      emptyTrash: h.emptyTrash,
      undoLast: h.undoLast,
    },
  };
});

import { TrashScreen } from "./TrashScreen";

beforeEach(() => {
  vi.clearAllMocks();
  h.listTrash.mockResolvedValue({ items: [h.item] });
  h.restoreFromTrash.mockResolvedValue({ item: { id: "el-1", status: "active" } });
  h.purgeFromTrash.mockResolvedValue({ purged: 1 });
  h.emptyTrash.mockResolvedValue({ purged: 1 });
  h.undoLast.mockResolvedValue({ undone: true, opType: "restore_element", label: "x", count: 1 });
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

  it("requires a confirm before emptying the whole trash", async () => {
    render(<TrashScreen />);
    await screen.findByTestId("trash-row");
    fireEvent.click(screen.getByTestId("trash-empty"));
    expect(h.emptyTrash).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("trash-empty-yes"));
    await waitFor(() => expect(h.emptyTrash).toHaveBeenCalled());
  });

  it("shows the empty state when there is nothing to recover", async () => {
    h.listTrash.mockResolvedValue({ items: [] });
    render(<TrashScreen />);
    expect(await screen.findByTestId("trash-empty-state")).toBeTruthy();
    expect(screen.getByText("Trash is empty")).toBeTruthy();
  });
});
