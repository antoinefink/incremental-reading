/**
 * HomeScreen component tests (Home command center, `/`).
 *
 * The Home dashboard is READ-ONLY UI orchestration over two existing typed reads —
 * `appApi.listQueue()` and `appApi.getAnalytics()` (the domain work lives main-side
 * in `packages/local-db`). This asserts the RENDERER seam only:
 *  - the due counts + budget render from the mocked `listQueue`;
 *  - the streak + retention banner, the due-cards/topics/new metric tiles, and the
 *    reviews-per-day spark render from the mocked `getAnalytics`;
 *  - the empty "Queue clear" state shows when `counts.all === 0`;
 *  - the streak banner is hidden when `dayStreak === 0`;
 *  - the leech maintenance banner shows ONLY when `leeches > 0`;
 *  - "Start session" navigates to /process and a top-due preview row navigates to
 *    the right element route (source → /source/$id, extract → /extract/$id);
 *  - the non-desktop fallback still exposes data-testid="route-home" (the smoke E2E
 *    route marker).
 *
 * Collaborators (`appApi`, the router's `useNavigate`/`useSearch`) are mocked so the
 * test exercises ONLY this component's wiring — no SQLite/IPC.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalyticsGetResult, QueueItemSummary, QueueListResult } from "../../lib/appApi";

const h = vi.hoisted(() => {
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
  const extractRow: QueueItemSummary = {
    id: "extract-1",
    type: "extract",
    status: "active",
    stage: "clean_extract",
    priority: 0.625,
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
  const queue: QueueListResult = {
    items: [sourceRow, extractRow],
    counts: {
      all: 2,
      card: 0,
      source: 1,
      extract: 1,
      topic: 0,
      task: 0,
      highPriority: 1,
      overdue: 1,
      protected: 1,
    },
    budget: { used: 2, target: 30 },
  };
  const analytics: AnalyticsGetResult = {
    asOf: "2026-05-30T18:00:00.000Z",
    windowDays: 30,
    reviewsByDay: Array.from({ length: 30 }, (_, i) => ({
      date: `2026-05-${String(i + 1).padStart(2, "0")}`,
      count: i % 3,
    })),
    reviewsTotal: 124,
    reviewsPerDayAvg: 4.13,
    retention30d: 0.91,
    dueCards: 7,
    dueTopics: 3,
    newCards: 12,
    newExtracts: 9,
    deletions: 2,
    leeches: 1,
    dayStreak: 5,
  };
  return {
    queue,
    analytics,
    listQueue: vi.fn(),
    getAnalytics: vi.fn(),
    navigateSpy: vi.fn(),
    // Flipped per-test so the non-desktop fallback can be exercised without a
    // module reset (the global mock delegates `isDesktop` to this spy).
    isDesktop: vi.fn(() => true),
    sourceRow,
    extractRow,
  };
});

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => h.navigateSpy,
  useSearch: () => ({}),
}));

vi.mock("../../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../../lib/appApi")>("../../lib/appApi");
  return {
    ...actual,
    isDesktop: () => h.isDesktop(),
    appApi: { listQueue: h.listQueue, getAnalytics: h.getAnalytics },
  };
});

import { HomeScreen } from "./HomeScreen";

beforeEach(() => {
  vi.clearAllMocks();
  h.isDesktop.mockReturnValue(true);
  h.listQueue.mockResolvedValue(h.queue);
  h.getAnalytics.mockResolvedValue(h.analytics);
});

describe("HomeScreen", () => {
  it("renders the due counts + budget from the mocked listQueue", async () => {
    render(<HomeScreen />);
    expect(await screen.findByTestId("home-due-today")).toBeTruthy();
    expect(screen.getByTestId("home-due-today").textContent).toBe("2");
    expect(screen.getByTestId("home-overdue-count").textContent).toBe("1");
    expect(screen.getByTestId("home-protected-count").textContent).toBe("1");
    // The budget gauge renders used / target from the read.
    expect(screen.getByTestId("budget-meter").textContent).toContain("2");
    expect(screen.getByTestId("budget-meter").textContent).toContain("30");
  });

  it("renders the streak/retention banner, the metric tiles, and the spark from getAnalytics", async () => {
    render(<HomeScreen />);
    await screen.findByTestId("home-due-today");

    expect(screen.getByTestId("home-streak").textContent).toContain("5-day streak");
    expect(screen.getByTestId("home-streak-retention").textContent).toContain("91");

    expect(screen.getByTestId("metric-due").textContent).toContain("7");
    expect(screen.getByTestId("metric-topics").textContent).toContain("3");
    expect(screen.getByTestId("metric-new-cards").textContent).toContain("12");
    expect(screen.getByTestId("metric-new-extracts").textContent).toContain("9");

    // The spark renders one bar per window day.
    expect(screen.getByTestId("home-spark").querySelectorAll(".an-spark__bar").length).toBe(30);
  });

  it("renders a top-due preview (read-only) with the sorted items, not the full list", async () => {
    render(<HomeScreen />);
    await screen.findByTestId("home-preview");
    const rows = screen.getAllByTestId("home-preview-row");
    expect(rows).toHaveLength(2);
    // No actionable queue controls leak into the preview.
    expect(screen.queryByTestId("queue-actions")).toBeNull();
  });

  it("shows the empty 'Queue clear' state when counts.all === 0", async () => {
    h.listQueue.mockResolvedValue({
      ...h.queue,
      items: [],
      counts: { ...h.queue.counts, all: 0, overdue: 0, protected: 0 },
      budget: { used: 0, target: 30 },
    });
    render(<HomeScreen />);
    expect(await screen.findByTestId("home-empty")).toBeTruthy();
    expect(screen.queryByTestId("home-preview")).toBeNull();
  });

  it("hides the streak banner when dayStreak === 0", async () => {
    h.getAnalytics.mockResolvedValue({ ...h.analytics, dayStreak: 0 });
    render(<HomeScreen />);
    await screen.findByTestId("home-due-today");
    expect(screen.queryByTestId("home-streak")).toBeNull();
  });

  it("shows the leech banner only when leeches > 0", async () => {
    h.getAnalytics.mockResolvedValue({ ...h.analytics, leeches: 0 });
    render(<HomeScreen />);
    await screen.findByTestId("home-due-today");
    expect(screen.queryByTestId("home-banner-leeches")).toBeNull();
  });

  it("Start session navigates to /process", async () => {
    render(<HomeScreen />);
    await screen.findByTestId("home-due-today");
    fireEvent.click(screen.getByTestId("home-start-session"));
    expect(h.navigateSpy).toHaveBeenCalledWith({ to: "/process", search: {} });
  });

  it("a top-due preview row navigates to its element route (source → reader, extract → view)", async () => {
    render(<HomeScreen />);
    await screen.findByTestId("home-preview");
    const rows = screen.getAllByTestId("home-preview-row");
    const sourceRow = rows.find((r) => r.getAttribute("data-element-id") === "source-1");
    const extractRow = rows.find((r) => r.getAttribute("data-element-id") === "extract-1");

    fireEvent.click(sourceRow as HTMLElement);
    expect(h.navigateSpy).toHaveBeenCalledWith({ to: "/source/$id", params: { id: "source-1" } });

    fireEvent.click(extractRow as HTMLElement);
    expect(h.navigateSpy).toHaveBeenCalledWith({ to: "/extract/$id", params: { id: "extract-1" } });
  });

  it("'See full queue' navigates to /queue", async () => {
    render(<HomeScreen />);
    await screen.findByTestId("home-see-queue");
    fireEvent.click(screen.getByTestId("home-see-queue"));
    expect(h.navigateSpy).toHaveBeenCalledWith({ to: "/queue" });
  });
});

describe("HomeScreen — non-desktop fallback", () => {
  it("still exposes the route-home marker so the smoke E2E finds the route", async () => {
    h.isDesktop.mockReturnValue(false);
    render(<HomeScreen />);
    await waitFor(() => expect(screen.getByTestId("route-home")).toBeTruthy());
    // The fallback reads nothing through the bridge.
    expect(h.listQueue).not.toHaveBeenCalled();
    expect(h.getAnalytics).not.toHaveBeenCalled();
  });
});
