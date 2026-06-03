import { fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  desktop: true,
  listInspectableElements: vi.fn(),
}));

vi.mock("../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../lib/appApi")>("../lib/appApi");
  return {
    ...actual,
    isDesktop: () => h.desktop,
    appApi: {
      listInspectableElements: h.listInspectableElements,
    },
  };
});

import { AddToNote } from "./AddToNote";

const elements = [
  {
    id: "note-1",
    type: "synthesis_note",
    status: "active",
    stage: "synthesis",
    priority: 1,
    title: "Note",
    dueAt: null,
  },
  {
    id: "ext-1",
    type: "extract",
    status: "active",
    stage: "clean_extract",
    priority: 1,
    title: "Useful extract",
    dueAt: null,
  },
  {
    id: "card-1",
    type: "card",
    status: "active",
    stage: "active_card",
    priority: 1,
    title: "Useful card",
    dueAt: null,
  },
  {
    id: "card-2",
    type: "card",
    status: "active",
    stage: "active_card",
    priority: 1,
    title: "Already linked",
    dueAt: null,
  },
  {
    id: "src-1",
    type: "source",
    status: "active",
    stage: "raw_source",
    priority: 1,
    title: "Source",
    dueAt: null,
  },
];

beforeEach(() => {
  h.desktop = true;
  h.listInspectableElements.mockReset();
  h.listInspectableElements.mockResolvedValue({ elements });
});

describe("AddToNote", () => {
  it("lists only unlinked extracts/cards and supports filtering", async () => {
    const { getByLabelText, getAllByTestId, getByText, queryByText } = render(
      <AddToNote noteId="note-1" excludeIds={["card-2"]} onPick={vi.fn()} onClose={vi.fn()} />,
    );

    await waitFor(() => expect(getAllByTestId("synthesis-picker-item")).toHaveLength(2));
    expect(getByText("Useful extract")).toBeInTheDocument();
    expect(getByText("Useful card")).toBeInTheDocument();
    expect(queryByText("Already linked")).toBeNull();
    expect(queryByText("Source")).toBeNull();

    fireEvent.change(getByLabelText("Filter extracts and cards"), { target: { value: "card" } });
    expect(queryByText("Useful extract")).toBeNull();
    expect(getByText("Useful card")).toBeInTheDocument();
  });

  it("picks a candidate, closes, and closes from Escape/backdrop", async () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    const { getAllByTestId, getByLabelText } = render(
      <AddToNote noteId="note-1" excludeIds={[]} onPick={onPick} onClose={onClose} />,
    );

    await waitFor(() => expect(getAllByTestId("synthesis-picker-item").length).toBeGreaterThan(0));
    fireEvent.click(getAllByTestId("synthesis-picker-item")[0] as HTMLElement);
    expect(onPick).toHaveBeenCalledWith("ext-1");
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(getByLabelText("Close add-to-note picker"));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("renders an empty state outside desktop mode", () => {
    h.desktop = false;
    const { getByText } = render(
      <AddToNote noteId="note-1" excludeIds={[]} onPick={vi.fn()} onClose={vi.fn()} />,
    );

    expect(getByText("No extracts or cards to add.")).toBeInTheDocument();
    expect(h.listInspectableElements).not.toHaveBeenCalled();
  });
});
