/**
 * ProcessQueue loop component tests (T031).
 *
 * The queue read (sorting/filtering/budget) lives in `packages/local-db`; this
 * asserts the RENDERER seam of the one-at-a-time loop:
 *  - it renders ONE item at a time (the current cursor item only);
 *  - acting on an item calls the SAME typed `queue.act` mutation path as the list
 *    (no new channel) and ADVANCES the cursor to the next item;
 *  - reaching the end shows the "Queue clear" done state;
 *  - the card surface shows its prompt + a reveal (full FSRS grading is M7).
 *
 * Collaborators are mocked so the test exercises ONLY this component's wiring:
 * `window.appApi.queue.list` returns a fixed payload, `queue.act` is a spy, and the
 * router + selection seams are stubbed. No SQLite/IPC — the renderer is a pure UI
 * consumer.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QueueItemSummary, QueueListResult } from "../../lib/appApi";

const h = vi.hoisted(() => {
  const mk = (over: Partial<QueueItemSummary> & { id: string }): QueueItemSummary => ({
    type: "extract",
    status: "scheduled",
    stage: "clean_extract",
    priority: 0.625,
    title: `Item ${over.id}`,
    dueAt: "2026-05-30T06:00:00.000Z",
    scheduler: "attention",
    schedulerSignals: {
      kind: "attention",
      retrievability: null,
      stability: null,
      stage: "clean_extract",
      postponed: 0,
    },
    sourceTitle: "On the Measure of Intelligence",
    author: "François Chollet",
    concept: null,
    cardType: null,
    protected: false,
    due: "today",
    dueLabel: "Due today",
    ...over,
  });
  const card = mk({
    id: "card-1",
    type: "card",
    scheduler: "fsrs",
    stage: "active_card",
    cardType: "qa",
    priority: 0.875,
    protected: true,
    title: "What does Chollet define intelligence as?",
    schedulerSignals: {
      kind: "fsrs",
      retrievability: 0.82,
      stability: 9.4,
      stage: "active_card",
      postponed: 0,
    },
  });
  const extractA = mk({ id: "extract-1", title: "skill-acquisition efficiency" });
  const source = mk({
    id: "source-1",
    type: "source",
    stage: "raw_source",
    title: "The Bitter Lesson",
  });
  const result: QueueListResult = {
    items: [card, source, extractA],
    counts: {
      all: 3,
      card: 1,
      source: 1,
      extract: 1,
      topic: 0,
      task: 0,
      highPriority: 2,
      overdue: 0,
      protected: 2,
    },
    budget: { used: 3, target: 30 },
  };
  return {
    navigateSpy: vi.fn(),
    selectSpy: vi.fn(),
    listQueue: vi.fn().mockResolvedValue(result),
    actOnQueueItem: vi.fn().mockResolvedValue({ item: null, removed: true, undo: null }),
    getDocument: vi
      .fn()
      .mockResolvedValue({ document: { plainText: "Body preview text." }, extractedBlockIds: [] }),
    getInspectorData: vi.fn().mockResolvedValue({ data: null }),
  };
});

vi.mock("../../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../../lib/appApi")>("../../lib/appApi");
  return {
    ...actual,
    isDesktop: () => true,
    appApi: {
      listQueue: h.listQueue,
      actOnQueueItem: h.actOnQueueItem,
      getDocument: h.getDocument,
      getInspectorData: h.getInspectorData,
    },
  };
});

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => h.navigateSpy,
  useSearch: () => ({}),
}));

vi.mock("../../shell/selection", () => ({
  useSelection: () => ({ selectedId: null, select: h.selectSpy }),
}));

// The seeded daily jitter (T029) is a presentation collaborator that reorders the
// queue by the calendar day — its shuffle is covered by `jitter.test.ts`. Stub it to
// the identity here so this test exercises ONLY the loop's cursor wiring against the
// deterministic input order (card-1 → source-1 → extract-1), instead of depending on
// today's wall-clock seed (which would make these assertions flaky day to day).
vi.mock("./jitter", () => ({
  jitterOrder: <T,>(rows: readonly T[]): T[] => [...rows],
  daySeed: () => "2026-01-01",
}));

import { ProcessQueue } from "./ProcessQueue";

beforeEach(() => {
  vi.clearAllMocks();
  h.actOnQueueItem.mockResolvedValue({ item: null, removed: true, undo: null });
});

/** The id of the single rendered process item (the cursor item), or null. */
function currentItemId(): string | null {
  return screen.queryByTestId("process-item")?.getAttribute("data-element-id") ?? null;
}

describe("ProcessQueue", () => {
  it("renders exactly ONE element at a time (the cursor item)", async () => {
    render(<ProcessQueue />);
    await screen.findByTestId("process-item");
    expect(screen.getAllByTestId("process-item")).toHaveLength(1);
  });

  it("shows the progress readout (N / total)", async () => {
    render(<ProcessQueue />);
    await screen.findByTestId("process-progress");
    expect(screen.getByTestId("process-progress")).toHaveTextContent("1 / 3");
  });

  it("advances to the next item after an action, using the queue.act path", async () => {
    render(<ProcessQueue />);
    await screen.findByTestId("process-item");
    const first = currentItemId();

    fireEvent.click(screen.getByTestId("process-action-markDone"));
    await waitFor(() =>
      expect(h.actOnQueueItem).toHaveBeenCalledWith({
        id: first,
        action: { kind: "markDone" },
      }),
    );
    // The cursor advanced: a DIFFERENT item is now shown (no return to a list).
    await waitFor(() => expect(currentItemId()).not.toBe(first));
    expect(h.navigateSpy).not.toHaveBeenCalled();
  });

  it("processes all items one at a time and reaches the done state", async () => {
    render(<ProcessQueue />);
    await screen.findByTestId("process-item");
    // Act on each of the three items in turn.
    for (let i = 0; i < 3; i++) {
      await screen.findByTestId("process-item");
      fireEvent.click(screen.getByTestId("process-action-markDone"));
      // wait for this action to register before the next
      await waitFor(() => expect(h.actOnQueueItem).toHaveBeenCalledTimes(i + 1));
    }
    await screen.findByTestId("process-done");
    expect(screen.getByTestId("process-done")).toHaveTextContent(/queue clear/i);
  });

  it("skip advances WITHOUT mutating (no queue.act call)", async () => {
    render(<ProcessQueue />);
    await screen.findByTestId("process-item");
    const first = currentItemId();
    fireEvent.click(screen.getByTestId("process-action-skip"));
    await waitFor(() => expect(currentItemId()).not.toBe(first));
    expect(h.actOnQueueItem).not.toHaveBeenCalled();
  });

  it("renders the card surface with a prompt + reveal for a card item", async () => {
    render(<ProcessQueue />);
    await screen.findByTestId("process-item");
    // The first item is the FSRS card.
    expect(currentItemId()).toBe("card-1");
    expect(screen.getByTestId("process-card-face")).toBeInTheDocument();
    expect(screen.getByTestId("process-card-reveal")).toBeInTheDocument();
    // Its chip is the FSRS side (the two-scheduler split holds in the loop).
    expect(
      screen.getByTestId("process-item").querySelector('[data-scheduler="fsrs"]'),
    ).not.toBeNull();
  });

  it("opens the current item in full via the open action (the only navigation)", async () => {
    render(<ProcessQueue />);
    await screen.findByTestId("process-item");
    // Advance past the card to the source item.
    fireEvent.click(screen.getByTestId("process-action-skip"));
    await waitFor(() => expect(currentItemId()).toBe("source-1"));
    fireEvent.click(screen.getByTestId("process-action-open"));
    expect(h.navigateSpy).toHaveBeenCalledWith({ to: "/source/$id", params: { id: "source-1" } });
  });
});
