/**
 * OverloadBanner tests (T077 — the queue's overload valve UI).
 *
 * Pins: the banner is hidden within budget; over budget it shows "N over today's budget"
 * + an "Auto-postpone N" action; the action fetches the READ-ONLY preview and shows what
 * moves (from→to); confirming calls apply and reports the postponed count to the parent.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  previewAutoPostpone: vi.fn(),
  applyAutoPostpone: vi.fn(),
  onPostponed: vi.fn(),
}));

vi.mock("../../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../../lib/appApi")>("../../lib/appApi");
  return {
    ...actual,
    isDesktop: () => true,
    appApi: {
      previewAutoPostpone: h.previewAutoPostpone,
      applyAutoPostpone: h.applyAutoPostpone,
    },
  };
});

import { OverloadBanner } from "./OverloadBanner";

const PREVIEW = {
  overBudget: 2,
  target: 10,
  used: 12,
  overBudgetMinutes: 2,
  targetMinutes: 10,
  usedMinutes: 12,
  confidence: "default" as const,
  remainingAfter: 10,
  remainingMinutesAfter: 9,
  willPostpone: [
    {
      id: "topic-1",
      title: "Low topic",
      type: "topic",
      priority: 0.375,
      scheduler: "attention" as const,
      fromDueAt: "2027-06-01T12:00:00.000Z",
      toDueAt: "2027-06-08T12:00:00.000Z",
      reason: "low-priority-topic" as const,
      estimatedMinutes: 10,
      estimateConfidence: "default" as const,
    },
    {
      id: "card-1",
      title: "Mature low card",
      type: "card",
      priority: 0.375,
      scheduler: "fsrs" as const,
      fromDueAt: "2027-06-01T12:00:00.000Z",
      toDueAt: "2027-06-08T12:00:00.000Z",
      reason: "low-priority-mature-card" as const,
      estimatedMinutes: 2,
      estimateConfidence: "default" as const,
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  h.previewAutoPostpone.mockResolvedValue(PREVIEW);
  h.applyAutoPostpone.mockResolvedValue({
    postponed: 2,
    postponedMinutes: 12,
    remainingMinutesAfter: 9,
    batchId: "batch-1",
  });
});

describe("OverloadBanner", () => {
  it("renders nothing when the queue is within budget", () => {
    const { container } = render(
      <OverloadBanner used={5} target={10} onPostponed={h.onPostponed} />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId("queue-overload-banner")).toBeNull();
  });

  it("shows the over-budget count + Auto-postpone action when over budget", () => {
    render(<OverloadBanner used={12} target={10} onPostponed={h.onPostponed} />);
    expect(screen.getByTestId("queue-overload-banner")).toBeInTheDocument();
    expect(screen.getByTestId("queue-overload-count")).toHaveTextContent(
      "2 min over today's budget",
    );
    expect(screen.getByTestId("queue-auto-postpone")).toHaveTextContent("Auto-postpone");
  });

  it("opens the preview (read-only) listing what moves, then applies on confirm", async () => {
    const user = userEvent.setup();
    render(<OverloadBanner used={12} target={10} onPostponed={h.onPostponed} />);

    await user.click(screen.getByTestId("queue-auto-postpone"));
    await waitFor(() => expect(h.previewAutoPostpone).toHaveBeenCalledTimes(1));

    // The preview lists each victim, with a from→to move label.
    const rows = await screen.findAllByTestId("queue-postpone-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Low topic");
    expect(rows[0]).toHaveTextContent("+7d");
    // Preview is read-only — no apply yet.
    expect(h.applyAutoPostpone).not.toHaveBeenCalled();

    // Confirm applies and reports the count to the parent.
    await user.click(screen.getByTestId("queue-postpone-confirm"));
    await waitFor(() => expect(h.applyAutoPostpone).toHaveBeenCalledTimes(1));
    expect(h.onPostponed).toHaveBeenCalledWith(2);
  });

  it("forwards the asOf clock to the preview + apply commands", async () => {
    const user = userEvent.setup();
    render(
      <OverloadBanner
        used={12}
        target={10}
        asOf="2027-06-01T12:00:00.000Z"
        onPostponed={h.onPostponed}
      />,
    );
    await user.click(screen.getByTestId("queue-auto-postpone"));
    await waitFor(() =>
      expect(h.previewAutoPostpone).toHaveBeenCalledWith({ asOf: "2027-06-01T12:00:00.000Z" }),
    );
    await user.click(screen.getByTestId("queue-postpone-confirm"));
    await waitFor(() =>
      expect(h.applyAutoPostpone).toHaveBeenCalledWith({ asOf: "2027-06-01T12:00:00.000Z" }),
    );
  });

  it("forwards visible queue filters to preview + apply commands", async () => {
    const user = userEvent.setup();
    render(
      <OverloadBanner
        used={12}
        target={10}
        filters={{ statuses: ["scheduled"], concept: "memory" }}
        onPostponed={h.onPostponed}
      />,
    );
    await user.click(screen.getByTestId("queue-auto-postpone"));
    await waitFor(() =>
      expect(h.previewAutoPostpone).toHaveBeenCalledWith({
        statuses: ["scheduled"],
        concept: "memory",
      }),
    );
    await user.click(screen.getByTestId("queue-postpone-confirm"));
    await waitFor(() =>
      expect(h.applyAutoPostpone).toHaveBeenCalledWith({
        statuses: ["scheduled"],
        concept: "memory",
      }),
    );
  });
});
