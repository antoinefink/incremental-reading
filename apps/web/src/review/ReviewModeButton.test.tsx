/**
 * ReviewModeButton tests (T096) — the "Review these" entry affordance.
 *
 * Asserts the renderer seam of a mode-entry button:
 *  - it resolves its subset count via `review.modeCount` and renders the size;
 *  - on click it routes to `/review` with the typed selector serialized into loose
 *    search params (the renderer NEVER computes the selection);
 *  - it is OMITTED on an empty subset (a calm empty state, never a dead button).
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reviewModeSearch } from "./ReviewModeButton";

const h = vi.hoisted(() => ({
  navigateSpy: vi.fn(),
  reviewModeCount: vi.fn(),
}));

vi.mock("../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../lib/appApi")>("../lib/appApi");
  return {
    ...actual,
    isDesktop: () => true,
    appApi: { reviewModeCount: h.reviewModeCount },
  };
});

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => h.navigateSpy,
}));

import { ReviewModeButton } from "./ReviewModeButton";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("reviewModeSearch", () => {
  it("serializes each selector kind into the loose /review search object", () => {
    expect(reviewModeSearch({ kind: "concept", conceptId: "c1" })).toEqual({
      mode: "concept",
      conceptId: "c1",
    });
    expect(reviewModeSearch({ kind: "leech" })).toEqual({ mode: "leech" });
    expect(reviewModeSearch({ kind: "search", query: "memory" })).toEqual({
      mode: "search",
      query: "memory",
    });
    expect(reviewModeSearch({ kind: "random", size: 12, seed: 7 })).toEqual({
      mode: "random",
      size: "12",
      seed: "7",
    });
    expect(reviewModeSearch({ kind: "stale" }, "2026-06-01T00:00:00.000Z")).toEqual({
      mode: "stale",
      asOf: "2026-06-01T00:00:00.000Z",
    });
  });
});

describe("ReviewModeButton", () => {
  it("shows the subset count and routes to /review in the chosen mode on click", async () => {
    h.reviewModeCount.mockResolvedValue({ total: 5, label: "Concept" });
    render(<ReviewModeButton selector={{ kind: "concept", conceptId: "c1" }} />);

    const btn = await screen.findByTestId("review-mode-button");
    expect(btn).toHaveTextContent("Review 5 cards");

    fireEvent.click(btn);
    expect(h.navigateSpy).toHaveBeenCalledWith({
      to: "/review",
      search: { mode: "concept", conceptId: "c1" },
    });
  });

  it("is OMITTED when the subset is empty (a calm empty state, never a dead button)", async () => {
    h.reviewModeCount.mockResolvedValue({ total: 0, label: "Leeches" });
    render(
      <ReviewModeButton selector={{ kind: "leech" }} hideWhileLoading testId="leech-review-mode" />,
    );

    await waitFor(() => {
      expect(h.reviewModeCount).toHaveBeenCalled();
    });
    expect(screen.queryByTestId("leech-review-mode")).not.toBeInTheDocument();
  });
});
