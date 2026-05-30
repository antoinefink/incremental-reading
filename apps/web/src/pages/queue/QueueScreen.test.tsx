/**
 * QueueScreen component tests (T029).
 *
 * The queue read (sorting/filtering/budget) lives in `packages/local-db` and is
 * covered by the QueueQuery Vitest there; this asserts the RENDERER seam:
 *  - it renders one `qitem` per due row with the right `SchedulerChip` side for a
 *    card (FSRS) vs an extract (attention) — the load-bearing two-scheduler split;
 *  - a filter chip narrows the visible list;
 *  - clicking a row selects it in the shell inspector (`useSelection().select`);
 *  - the `next-action` opens the row (source → reader, card → review).
 *
 * The collaborators are mocked so the test exercises ONLY this component's wiring:
 * `window.appApi.queue.list` is a fake whose payload is rendered, and the router +
 * selection seams are stubbed. No SQLite/IPC — the renderer is a pure UI consumer.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QueueItemSummary, QueueListResult } from "../../lib/appApi";

const h = vi.hoisted(() => {
  const cardRow: QueueItemSummary = {
    id: "card-1",
    type: "card",
    status: "scheduled",
    stage: "active_card",
    priority: 0.875, // A — protected
    title: "Chollet's definition of intelligence",
    dueAt: "2026-05-29T08:00:00.000Z",
    scheduler: "fsrs",
    schedulerSignals: {
      kind: "fsrs",
      retrievability: 0.82,
      stability: 9.4,
      stage: "active_card",
      postponed: 0,
    },
    sourceTitle: "On the Measure of Intelligence",
    author: "François Chollet",
    concept: null,
    cardType: "qa",
    protected: true,
    due: "overdue",
    dueLabel: "Overdue",
  };
  const extractRow: QueueItemSummary = {
    id: "extract-1",
    type: "extract",
    status: "active",
    stage: "clean_extract",
    priority: 0.625, // B
    title: "Intelligence = skill-acquisition efficiency",
    dueAt: "2026-05-30T06:00:00.000Z",
    scheduler: "attention",
    schedulerSignals: {
      kind: "attention",
      retrievability: null,
      stability: null,
      stage: "clean_extract",
      postponed: 1,
    },
    sourceTitle: "On the Measure of Intelligence",
    author: "François Chollet",
    concept: null,
    cardType: null,
    protected: false,
    due: "today",
    dueLabel: "Due today",
  };
  const sourceRow: QueueItemSummary = {
    id: "source-1",
    type: "source",
    status: "active",
    stage: "raw_source",
    priority: 0.875,
    title: "The Bitter Lesson",
    dueAt: "2026-05-29T08:00:00.000Z",
    scheduler: "attention",
    schedulerSignals: {
      kind: "attention",
      retrievability: null,
      stability: null,
      stage: "raw_source",
      postponed: 0,
    },
    sourceTitle: "The Bitter Lesson",
    author: "Rich Sutton",
    concept: null,
    cardType: null,
    protected: true,
    due: "overdue",
    dueLabel: "Overdue",
  };
  const result: QueueListResult = {
    items: [cardRow, sourceRow, extractRow],
    counts: {
      all: 3,
      card: 1,
      source: 1,
      extract: 1,
      topic: 0,
      task: 0,
      highPriority: 2,
      overdue: 2,
      protected: 2,
    },
    budget: { used: 3, target: 30 },
  };
  return {
    navigateSpy: vi.fn(),
    selectSpy: vi.fn(),
    listQueue: vi.fn().mockResolvedValue(result),
  };
});

vi.mock("../../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../../lib/appApi")>("../../lib/appApi");
  return {
    ...actual,
    isDesktop: () => true,
    appApi: { listQueue: h.listQueue },
  };
});

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => h.navigateSpy,
  useSearch: () => ({}),
}));

vi.mock("../../shell/selection", () => ({
  useSelection: () => ({ selectedId: null, select: h.selectSpy }),
}));

import { QueueScreen } from "./QueueScreen";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("QueueScreen", () => {
  it("renders one qitem per due row", async () => {
    render(<QueueScreen />);
    await waitFor(() => expect(screen.getAllByTestId("queue-item")).toHaveLength(3));
  });

  it("renders the correct SchedulerChip side for a card (FSRS) vs an extract (attention)", async () => {
    render(<QueueScreen />);
    await screen.findAllByTestId("queue-item");

    const card = screen
      .getAllByTestId("queue-item")
      .find((el) => el.getAttribute("data-element-id") === "card-1");
    const extract = screen
      .getAllByTestId("queue-item")
      .find((el) => el.getAttribute("data-element-id") === "extract-1");

    expect(card?.querySelector('[data-scheduler="fsrs"]')).not.toBeNull();
    expect(extract?.querySelector('[data-scheduler="attention"]')).not.toBeNull();
  });

  it("marks A-priority rows with the --protected accent bar", async () => {
    render(<QueueScreen />);
    await screen.findAllByTestId("queue-item");
    const card = screen
      .getAllByTestId("queue-item")
      .find((el) => el.getAttribute("data-element-id") === "card-1");
    const extract = screen
      .getAllByTestId("queue-item")
      .find((el) => el.getAttribute("data-element-id") === "extract-1");
    expect(card?.className).toContain("qitem--protected");
    expect(extract?.className).not.toContain("qitem--protected");
  });

  it("narrows the list when a filter chip is clicked", async () => {
    render(<QueueScreen />);
    await waitFor(() => expect(screen.getAllByTestId("queue-item")).toHaveLength(3));

    fireEvent.click(screen.getByTestId("queue-filter-card"));
    await waitFor(() => expect(screen.getAllByTestId("queue-item")).toHaveLength(1));
    expect(screen.getByTestId("queue-item").getAttribute("data-element-type")).toBe("card");
  });

  it("shows a filtered-empty state when a filter matches nothing", async () => {
    render(<QueueScreen />);
    await screen.findAllByTestId("queue-item");
    fireEvent.click(screen.getByTestId("queue-filter-task"));
    await screen.findByTestId("queue-empty-filtered");
  });

  it("selects a row in the shell inspector when clicked", async () => {
    render(<QueueScreen />);
    await screen.findAllByTestId("queue-item");
    const extract = screen
      .getAllByTestId("queue-item")
      .find((el) => el.getAttribute("data-element-id") === "extract-1");
    if (extract) fireEvent.click(extract);
    expect(h.selectSpy).toHaveBeenCalledWith("extract-1");
  });

  it("opens a source row in the reader via its next-action", async () => {
    render(<QueueScreen />);
    await screen.findAllByTestId("queue-item");
    const source = screen
      .getAllByTestId("queue-item")
      .find((el) => el.getAttribute("data-element-id") === "source-1");
    const open = source?.querySelector('[data-testid="queue-open"]') as HTMLElement;
    fireEvent.click(open);
    expect(h.navigateSpy).toHaveBeenCalledWith({
      to: "/source/$id",
      params: { id: "source-1" },
    });
  });

  it("renders the BudgetMeter with the items-due / target gauge", async () => {
    render(<QueueScreen />);
    await screen.findByTestId("budget-meter");
    expect(screen.getByTestId("budget-meter")).toHaveTextContent("3");
    expect(screen.getByTestId("budget-meter")).toHaveTextContent("30 today");
  });
});
