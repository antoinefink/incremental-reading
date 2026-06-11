/**
 * ReviewScreen in TARGETED MODE tests (T096).
 *
 * The mode SELECTION lives MAIN-side (`ReviewModeService` → `review.modeDeck`); this
 * asserts the RENDERER seam of the mode session:
 *  - with a `mode` in the loose search params, the screen fetches the FROZEN mode
 *    deck ONCE (`review.modeDeck`), renders the calm mode header + subset size, and
 *    walks the deck — revealing + grading through the UNCHANGED `review.preview` /
 *    `review.grade` (a mode card is graded exactly like a daily card);
 *  - the completion summary makes clear the session was TARGETED;
 *  - with NO mode the daily due session runs unchanged (no regression — the screen
 *    falls back to `review.sessionNext`);
 *  - a truncated deck surfaces the "first N of M" honesty note;
 *  - an empty subset shows the calm targeted empty state.
 *
 * Collaborators are mocked so the test exercises ONLY this component's wiring.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewCardView, ReviewModeDeckResult } from "../lib/appApi";

const h = vi.hoisted(() => {
  const card = (id: string, prompt: string, answer: string): ReviewCardView => ({
    id,
    kind: "qa",
    prompt,
    answer,
    cloze: null,
    priority: 0.6,
    stage: "active_card",
    concept: "Spaced repetition",
    sourceTitle: "A source",
    sourceLocationLabel: null,
    ref: null,
    sourceRef: null,
    expiry: null,
    schedulerSignals: {
      kind: "fsrs",
      retrievability: 0.8,
      stability: 9,
      difficulty: 5,
      reps: 2,
      lapses: 0,
      fsrsState: "review",
    },
    leech: false,
    lapses: 0,
    flagged: false,
    siblingGroupId: null,
    fallowContext: null,
    occlusion: null,
    mediaRef: null,
    mediaSource: null,
    youtubeId: null,
  });
  return {
    navigateSpy: vi.fn(),
    selectSpy: vi.fn(),
    navigateToLocationSpy: vi.fn(),
    reviewSessionNext: vi.fn(),
    reviewModeDeck: vi.fn(),
    reviewModeCount: vi.fn(),
    reviewPreview: vi.fn(),
    reviewGrade: vi.fn(),
    getInspectorData: vi.fn(),
    suspendCard: vi.fn(),
    deleteCard: vi.fn(),
    semanticContradictions: vi.fn(),
    // The current loose search params (mutable so each test sets the mode it wants).
    search: { mode: undefined } as Record<string, string | undefined>,
    cardA: card("card-a", "Prompt A?", "Answer A."),
    cardB: card("card-b", "Prompt B?", "Answer B."),
  };
});

vi.mock("../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../lib/appApi")>("../lib/appApi");
  return {
    ...actual,
    isDesktop: () => true,
    appApi: {
      reviewSessionNext: h.reviewSessionNext,
      reviewModeDeck: h.reviewModeDeck,
      reviewModeCount: h.reviewModeCount,
      reviewPreview: h.reviewPreview,
      reviewGrade: h.reviewGrade,
      getInspectorData: h.getInspectorData,
      suspendCard: h.suspendCard,
      deleteCard: h.deleteCard,
      semanticContradictions: h.semanticContradictions,
    },
  };
});

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => h.navigateSpy,
  useSearch: () => h.search,
}));

vi.mock("../shell/selection", () => ({
  useSelection: () => ({ selectedId: null, select: h.selectSpy }),
}));

vi.mock("../reader/navigateToLocation", () => ({
  useNavigateToLocation: () => h.navigateToLocationSpy,
}));

import { ReviewScreen } from "./ReviewScreen";

const PREVIEWS = {
  again: { dueAt: "2099-01-01T00:00:00.000Z", scheduledDays: 0.007, label: "10m" },
  hard: { dueAt: "2099-01-01T00:00:00.000Z", scheduledDays: 2, label: "2d" },
  good: { dueAt: "2099-01-01T00:00:00.000Z", scheduledDays: 10, label: "10d" },
  easy: { dueAt: "2099-01-01T00:00:00.000Z", scheduledDays: 30, label: "1mo" },
};

function deck(
  cards: ReviewCardView[],
  extra: Partial<ReviewModeDeckResult> = {},
): ReviewModeDeckResult {
  return { deck: cards, total: cards.length, label: "Concept", truncated: false, ...extra };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.search = { mode: undefined };
  h.reviewPreview.mockResolvedValue({ intervals: PREVIEWS });
  h.suspendCard.mockResolvedValue({});
  h.deleteCard.mockResolvedValue({});
  h.semanticContradictions.mockResolvedValue({ flags: [] });
  h.reviewGrade.mockResolvedValue({
    reviewLog: {
      id: "rl_1",
      elementId: "card-a",
      rating: "good",
      reviewedAt: "2026-06-01T08:00:00.000Z",
      promptMs: 0,
      responseMs: 1200,
      nextDueAt: "2099-01-01T00:00:00.000Z",
    },
    reviewState: {
      dueAt: "2099-01-01T00:00:00.000Z",
      stability: 18,
      difficulty: 5,
      reps: 3,
      lapses: 0,
      fsrsState: "review",
      lastReviewedAt: "2026-06-01T08:00:00.000Z",
    },
  });
});

describe("ReviewScreen — targeted mode (T096)", () => {
  it("with a concept mode, fetches the mode deck once + renders the mode header + subset size", async () => {
    h.search = { mode: "concept", conceptId: "concept-1" };
    h.reviewModeDeck.mockResolvedValue(deck([h.cardA, h.cardB]));
    render(<ReviewScreen />);

    await screen.findByTestId("review-card");
    // The mode header is shown with the calm label + subset size.
    expect(screen.getByTestId("review-mode-header")).toBeInTheDocument();
    expect(screen.getByTestId("review-mode-label")).toHaveTextContent("Concept");
    expect(screen.getByTestId("review-mode-count")).toHaveTextContent("Reviewing 2 cards");
    // It walked the MODE deck (not the daily session).
    expect(h.reviewModeDeck).toHaveBeenCalledTimes(1);
    expect(h.reviewModeDeck).toHaveBeenCalledWith(
      expect.objectContaining({ selector: { kind: "concept", conceptId: "concept-1" } }),
    );
    expect(h.reviewSessionNext).not.toHaveBeenCalled();
  });

  it("reveals + grades a mode card through the UNCHANGED review.grade / review.preview", async () => {
    h.search = { mode: "concept", conceptId: "concept-1" };
    h.reviewModeDeck.mockResolvedValue(deck([h.cardA, h.cardB]));
    render(<ReviewScreen />);

    await screen.findByTestId("review-card");
    fireEvent.click(screen.getByTestId("review-reveal"));
    await screen.findByTestId("review-answer");
    // Previews come from the unchanged review.preview.
    expect(h.reviewPreview).toHaveBeenCalledWith(expect.objectContaining({ cardId: "card-a" }));
    await waitFor(() => {
      expect(screen.getByTestId("review-interval-good")).toHaveTextContent("10d");
    });

    fireEvent.click(screen.getByTestId("review-grade-good"));
    // The grade reuses the unchanged review.grade — a mode card is graded like any card.
    await waitFor(() => {
      expect(h.reviewGrade).toHaveBeenCalledWith(
        expect.objectContaining({ cardId: "card-a", rating: "good" }),
      );
    });
    // The deck advances to the second card (NO second mode-deck fetch — it's frozen).
    await waitFor(() => {
      expect(screen.getByTestId("review-card")).toHaveAttribute("data-card-id", "card-b");
    });
    expect(h.reviewModeDeck).toHaveBeenCalledTimes(1);
  });

  it("shows a TARGETED completion summary after grading the whole subset", async () => {
    h.search = { mode: "concept", conceptId: "concept-1" };
    h.reviewModeDeck.mockResolvedValue(deck([h.cardA]));
    render(<ReviewScreen />);

    await screen.findByTestId("review-card");
    fireEvent.click(screen.getByTestId("review-reveal"));
    await screen.findByTestId("review-answer");
    fireEvent.click(screen.getByTestId("review-grade-good"));

    const body = await screen.findByTestId("review-summary-body");
    expect(body).toHaveTextContent(/Concept subset/i);
    // The back-to-daily affordance is offered in mode.
    expect(screen.getByTestId("review-back-daily")).toBeInTheDocument();
  });

  it("surfaces the truncation note when the deck was capped", async () => {
    h.search = { mode: "concept", conceptId: "concept-1" };
    h.reviewModeDeck.mockResolvedValue(deck([h.cardA, h.cardB], { total: 900, truncated: true }));
    render(<ReviewScreen />);

    await screen.findByTestId("review-card");
    expect(screen.getByTestId("review-mode-count")).toHaveTextContent("the first 2 cards of 900");
  });

  it("shows the calm targeted empty state for an empty subset", async () => {
    h.search = { mode: "stale" };
    h.reviewModeDeck.mockResolvedValue({ deck: [], total: 0, label: "Stale", truncated: false });
    render(<ReviewScreen />);

    const empty = await screen.findByTestId("review-empty");
    expect(empty).toHaveTextContent(/No cards in this subset/i);
    expect(screen.getByTestId("review-empty-back-daily")).toBeInTheDocument();
  });

  it("with NO mode, runs the daily due session unchanged (no regression)", async () => {
    h.search = { mode: undefined };
    h.reviewSessionNext.mockResolvedValue({ card: h.cardA, remaining: 0, total: 1 });
    render(<ReviewScreen />);

    await screen.findByTestId("review-card");
    // The daily session read ran; the mode deck did NOT.
    expect(h.reviewSessionNext).toHaveBeenCalled();
    expect(h.reviewModeDeck).not.toHaveBeenCalled();
    // No mode header in the daily session.
    expect(screen.queryByTestId("review-mode-header")).not.toBeInTheDocument();
  });
});
