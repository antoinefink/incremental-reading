/**
 * RecoveryPanel tests (T078 — the catch-up & vacation overload tools UI).
 *
 * Pins: catch-up opens a READ-ONLY preview that shows the COST (the before/after per-day load
 * curve + a slips summary) before Apply; Apply calls the apply command and reports the moved
 * count to the parent; vacation takes a date range, previews the cost (suspended vs shifted),
 * and applies; the renderer never plans/spreads (all main-side) and always shows the cost first.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  previewCatchUp: vi.fn(),
  applyCatchUp: vi.fn(),
  previewVacation: vi.fn(),
  applyVacation: vi.fn(),
  onApplied: vi.fn(),
}));

vi.mock("../../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../../lib/appApi")>("../../lib/appApi");
  return {
    ...actual,
    isDesktop: () => true,
    appApi: {
      previewCatchUp: h.previewCatchUp,
      applyCatchUp: h.applyCatchUp,
      previewVacation: h.previewVacation,
      applyVacation: h.applyVacation,
    },
  };
});

import { RecoveryPanel } from "./RecoveryPanel";

const CATCHUP_PREVIEW = {
  budget: 10,
  spreadDays: 7,
  cost: {
    moved: 12,
    newTailDueAt: "2027-06-04T12:00:00.000Z",
    daysAdded: 3,
    loadBefore: [
      { date: "2027-06-01", count: 22 },
      { date: "2027-06-02", count: 0 },
    ],
    loadAfter: [
      { date: "2027-06-01", count: 10 },
      { date: "2027-06-02", count: 10 },
    ],
    slips: [
      {
        id: "t1",
        title: "Topic 1",
        fromDueAt: "2027-05-01T12:00:00.000Z",
        toDueAt: "2027-06-02T12:00:00.000Z",
        slipDays: 9,
      },
    ],
  },
};

const VACATION_PREVIEW = {
  awayStart: "2027-06-10T00:00:00.000Z",
  awayEnd: "2027-06-20T23:59:59.000Z",
  suspendedCount: 1,
  shiftedCount: 3,
  cost: {
    moved: 3,
    newTailDueAt: "2027-06-23T12:00:00.000Z",
    daysAdded: 2,
    loadBefore: [{ date: "2027-06-21", count: 3 }],
    loadAfter: [{ date: "2027-06-21", count: 2 }],
    slips: [],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  h.previewCatchUp.mockResolvedValue(CATCHUP_PREVIEW);
  h.applyCatchUp.mockResolvedValue({ moved: 12, suspended: 0, batchId: "b1" });
  h.previewVacation.mockResolvedValue(VACATION_PREVIEW);
  h.applyVacation.mockResolvedValue({ moved: 3, suspended: 1, batchId: "b2" });
});

describe("RecoveryPanel — catch-up", () => {
  it("opens a read-only preview showing the cost (load curve + slips) before Apply", async () => {
    const user = userEvent.setup();
    render(<RecoveryPanel asOf="2027-06-01T12:00:00.000Z" onApplied={h.onApplied} />);

    await user.click(screen.getByTestId("recovery-catchup-open"));
    await waitFor(() => expect(h.previewCatchUp).toHaveBeenCalledTimes(1));
    expect(h.previewCatchUp).toHaveBeenCalledWith({ asOf: "2027-06-01T12:00:00.000Z" });

    // The COST is explicit: the before/after load curve + the slips summary.
    expect(screen.getByTestId("recovery-loadcurve")).toBeInTheDocument();
    expect(screen.getByTestId("recovery-catchup-slips")).toHaveTextContent(
      "1 item now due up to 9 days later",
    );
    // No apply happened just by previewing.
    expect(h.applyCatchUp).not.toHaveBeenCalled();

    // Apply reports the moved count to the parent.
    await user.click(screen.getByTestId("recovery-catchup-apply"));
    await waitFor(() => expect(h.applyCatchUp).toHaveBeenCalledTimes(1));
    expect(h.onApplied).toHaveBeenCalledWith("Spread", 12);
  });
});

describe("RecoveryPanel — vacation", () => {
  it("takes a date range, previews the cost, then applies", async () => {
    const user = userEvent.setup();
    render(<RecoveryPanel asOf="2027-06-01T12:00:00.000Z" onApplied={h.onApplied} />);

    await user.click(screen.getByTestId("recovery-vacation-open"));
    // Set the away range.
    const start = screen.getByTestId("recovery-away-start");
    const end = screen.getByTestId("recovery-away-end");
    await user.clear(start);
    await user.type(start, "2027-06-10");
    await user.clear(end);
    await user.type(end, "2027-06-20");

    await user.click(screen.getByTestId("recovery-vacation-preview-btn"));
    await waitFor(() => expect(h.previewVacation).toHaveBeenCalledTimes(1));
    // The away window crossed the bridge as ISO instants (start-of-day → end-of-day).
    expect(h.previewVacation).toHaveBeenCalledWith({
      awayStart: "2027-06-10T00:00:00.000Z",
      awayEnd: "2027-06-20T23:59:59.000Z",
      asOf: "2027-06-01T12:00:00.000Z",
    });

    // The cost is explicit (suspended vs shifted + the curve) before Apply.
    expect(screen.getByTestId("recovery-vacation-preview")).toHaveTextContent(
      "1 suspended · 3 shifted",
    );
    expect(screen.getByTestId("recovery-loadcurve")).toBeInTheDocument();
    expect(h.applyVacation).not.toHaveBeenCalled();

    // Apply reports moved + suspended to the parent.
    await user.click(screen.getByTestId("recovery-vacation-apply"));
    await waitFor(() => expect(h.applyVacation).toHaveBeenCalledTimes(1));
    expect(h.onApplied).toHaveBeenCalledWith("Adjusted", 4);
  });

  it("rejects an inverted away range without calling the bridge", async () => {
    const user = userEvent.setup();
    render(<RecoveryPanel asOf="2027-06-01T12:00:00.000Z" onApplied={h.onApplied} />);
    await user.click(screen.getByTestId("recovery-vacation-open"));
    const start = screen.getByTestId("recovery-away-start");
    const end = screen.getByTestId("recovery-away-end");
    await user.clear(start);
    await user.type(start, "2027-06-20");
    await user.clear(end);
    await user.type(end, "2027-06-10");
    await user.click(screen.getByTestId("recovery-vacation-preview-btn"));
    expect(screen.getByTestId("recovery-error")).toBeInTheDocument();
    expect(h.previewVacation).not.toHaveBeenCalled();
  });
});
