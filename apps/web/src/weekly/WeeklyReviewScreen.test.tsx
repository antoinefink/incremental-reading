import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  getWeeklyReviewSummary: vi.fn(),
  updateWeeklyReviewProgress: vi.fn(),
  completeWeeklyReview: vi.fn(),
  dismissWeeklyReview: vi.fn(),
  parkedResurfacingApply: vi.fn(),
  chronicPostponesApply: vi.fn(),
}));

vi.mock("../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../lib/appApi")>("../lib/appApi");
  return {
    ...actual,
    appApi: {
      getWeeklyReviewSummary: h.getWeeklyReviewSummary,
      updateWeeklyReviewProgress: h.updateWeeklyReviewProgress,
      completeWeeklyReview: h.completeWeeklyReview,
      dismissWeeklyReview: h.dismissWeeklyReview,
      maintenance: {
        parkedResurfacingApply: h.parkedResurfacingApply,
        chronicPostponesApply: h.chronicPostponesApply,
      },
    },
  };
});

import { WeeklyReviewScreen } from "./WeeklyReviewScreen";

const SUMMARY = {
  asOf: "2026-06-12T12:00:00.000Z",
  enabled: true,
  cadenceDays: 7,
  session: {
    id: "weekly-1",
    taskType: "weekly_review",
    title: "Weekly review",
    note: null,
    status: "scheduled",
    dueAt: "2026-06-12T12:00:00.000Z",
    priority: 0.875,
    linkedElement: null,
  },
  due: true,
  window: {
    start: "2026-06-06T00:00:00.000Z",
    end: "2026-06-12T12:00:00.000Z",
    days: 7,
  },
  progress: {
    taskId: "weekly-1",
    windowStart: "2026-06-06T00:00:00.000Z",
    windowEnd: "2026-06-12T12:00:00.000Z",
    sections: {
      ledger: "pending",
      integrity: "pending",
      parked: "pending",
      chronic: "pending",
      fallow: "pending",
    },
  },
  ledger: {
    sources: 2,
    extracts: 1,
    cards: 1,
    maturedCards: 0,
    priorityMisses: [],
  },
  integrity: {
    asOf: "2026-06-12T12:00:00.000Z",
    windowDays: 7,
    bands: [],
    topics: [],
    sacrificed: [],
    resting: [],
    thresholdFlags: {
      aBandDeferredRecently: false,
      postponeDebtHigh: false,
      bandShareInflation: false,
    },
  },
  decisions: {
    parked: {
      rows: [
        {
          element: {
            id: "parked-1",
            type: "source",
            title: "Parked source",
            priority: 0.875,
            priorityLabel: "A",
            createdAt: "2026-06-01T00:00:00.000Z",
          },
          parkedAt: "2026-03-01T00:00:00.000Z",
          ageDays: 103,
        },
      ],
      totalDue: 1,
      limit: 8,
      asOf: "2026-06-12T12:00:00.000Z",
    },
    chronic: {
      rows: [
        {
          element: {
            id: "chronic-1",
            type: "extract",
            title: "Chronic extract",
            priority: 0.625,
            priorityLabel: "B",
            status: "scheduled",
            dueAt: "2026-06-12T12:00:00.000Z",
            createdAt: "2026-06-01T00:00:00.000Z",
          },
          scheduler: "attention",
          postponeCount: 5,
        },
      ],
      totalDue: 1,
      threshold: 5,
      limit: 8,
    },
    fallowSuggestions: [],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  h.getWeeklyReviewSummary.mockResolvedValue(SUMMARY);
  h.updateWeeklyReviewProgress.mockResolvedValue(SUMMARY.progress);
  h.completeWeeklyReview.mockResolvedValue({ task: null, progress: null });
  h.dismissWeeklyReview.mockResolvedValue({ task: SUMMARY.session, progress: SUMMARY.progress });
  h.parkedResurfacingApply.mockResolvedValue({ applied: 1, skipped: [], batchId: "p1" });
  h.chronicPostponesApply.mockResolvedValue({ applied: 1, skipped: [], batchId: "c1" });
});

describe("WeeklyReviewScreen", () => {
  it("applies parked and chronic decisions through the existing maintenance commands", async () => {
    render(<WeeklyReviewScreen />);
    expect(await screen.findByTestId("weekly-review")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Queue"));
    fireEvent.click(screen.getByText("Apply parked decisions"));
    await waitFor(() =>
      expect(h.parkedResurfacingApply).toHaveBeenCalledWith({
        decisions: [{ id: "parked-1", kind: "queueNow" }],
      }),
    );
    expect(h.updateWeeklyReviewProgress).toHaveBeenCalledWith({
      taskId: "weekly-1",
      sections: { parked: "done" },
    });

    fireEvent.click(screen.getByText("Demote"));
    fireEvent.click(screen.getByText("Apply chronic decisions"));
    await waitFor(() =>
      expect(h.chronicPostponesApply).toHaveBeenCalledWith({
        decisions: [{ id: "chronic-1", kind: "demote" }],
      }),
    );
    expect(h.updateWeeklyReviewProgress).toHaveBeenCalledWith({
      taskId: "weekly-1",
      sections: { chronic: "done" },
    });
  });
});
