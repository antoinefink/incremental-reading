/**
 * OptimizationPanel component tests (T080).
 *
 * The fit + scoring + apply live MAIN-side (`packages/scheduler` /
 * `packages/local-db`); this asserts the RENDERER seam only:
 *  - Run calls `optimization.suggest` and renders the calibration + workload preview;
 *  - the insufficient-data state shows when `sufficientData` is false;
 *  - Apply calls `optimization.apply` with the suggested params (echoed unchanged) and
 *    shows the applied confirmation;
 *  - Dismiss clears the suggestion WITHOUT calling apply (nothing is persisted);
 *  - the copy says "estimated from your history", never "optimal".
 *
 * `appApi` is mocked so the test exercises only this component's wiring.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OptimizationSuggestResult } from "../lib/appApi";

const h = vi.hoisted(() => {
  const sufficient: OptimizationSuggestResult = {
    params: Array.from({ length: 21 }, (_, i) => 0.4 + i * 0.05),
    baseline: { logLoss: 0.512, rmse: 0.08, reviewsScored: 640 },
    suggested: { logLoss: 0.401, rmse: 0.05, reviewsScored: 640 },
    improvement: 0.111,
    reviewsScored: 640,
    method: "history-calibration",
    sufficientData: true,
    workload: {
      before: [
        { date: "2026-06-02", count: 10 },
        { date: "2026-06-03", count: 8 },
      ],
      after: [
        { date: "2026-06-02", count: 13 },
        { date: "2026-06-03", count: 9 },
      ],
      deltaDueNext7: 12,
      deltaDueNext30: 30,
    },
  };
  return {
    sufficient,
    suggestOptimization: vi.fn(),
    applyOptimization: vi.fn(),
  };
});

vi.mock("../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../lib/appApi")>("../lib/appApi");
  return {
    ...actual,
    isDesktop: () => true,
    appApi: {
      suggestOptimization: h.suggestOptimization,
      applyOptimization: h.applyOptimization,
    },
  };
});

import { OptimizationPanel } from "./OptimizationPanel";

beforeEach(() => {
  vi.clearAllMocks();
  h.suggestOptimization.mockResolvedValue(h.sufficient);
  h.applyOptimization.mockResolvedValue({ applied: true });
});

describe("OptimizationPanel (T080)", () => {
  it("the copy is honest — 'estimated from your history', never 'optimal'", () => {
    render(<OptimizationPanel />);
    const panel = screen.getByTestId("optimization-panel");
    expect(panel.textContent?.toLowerCase()).toContain("estimated from your history");
    expect(panel.textContent?.toLowerCase()).not.toContain("optimal");
  });

  it("Run calls optimization.suggest and renders the calibration + workload preview", async () => {
    render(<OptimizationPanel />);
    fireEvent.click(screen.getByTestId("optimization-run"));
    await screen.findByTestId("optimization-result");
    expect(h.suggestOptimization).toHaveBeenCalledWith({ scope: { scope: "global" } });
    // The metric improvement is rendered (baseline → suggested + reviews).
    const result = screen.getByTestId("optimization-result");
    expect(result.textContent).toContain("0.512");
    expect(result.textContent).toContain("0.401");
    expect(result.textContent).toContain("640");
    // The workload deltas are surfaced.
    expect(screen.getByTestId("optimization-delta-7").textContent).toContain("+12");
    expect(screen.getByTestId("optimization-delta-30").textContent).toContain("+30");
    expect(screen.getByTestId("optimization-workload-spark")).toBeTruthy();
  });

  it("shows the insufficient-data empty state when sufficientData is false", async () => {
    h.suggestOptimization.mockResolvedValue({ ...h.sufficient, sufficientData: false });
    render(<OptimizationPanel />);
    fireEvent.click(screen.getByTestId("optimization-run"));
    await screen.findByTestId("optimization-insufficient");
    expect(screen.queryByTestId("optimization-result")).toBeNull();
  });

  it("Apply sends the suggested params unchanged and shows the applied confirmation", async () => {
    render(<OptimizationPanel />);
    fireEvent.click(screen.getByTestId("optimization-run"));
    await screen.findByTestId("optimization-result");
    fireEvent.click(screen.getByTestId("optimization-apply"));
    await screen.findByTestId("optimization-applied");
    expect(h.applyOptimization).toHaveBeenCalledWith({
      scope: { scope: "global" },
      params: h.sufficient.params,
    });
    // The result card is dismissed after applying.
    expect(screen.queryByTestId("optimization-result")).toBeNull();
  });

  it("Dismiss clears the suggestion WITHOUT calling apply (nothing persisted)", async () => {
    render(<OptimizationPanel />);
    fireEvent.click(screen.getByTestId("optimization-run"));
    await screen.findByTestId("optimization-result");
    fireEvent.click(screen.getByTestId("optimization-dismiss"));
    await waitFor(() => expect(screen.queryByTestId("optimization-result")).toBeNull());
    expect(h.applyOptimization).not.toHaveBeenCalled();
  });

  it("surfaces an error when the suggest fails", async () => {
    h.suggestOptimization.mockRejectedValue(new Error("boom"));
    render(<OptimizationPanel />);
    fireEvent.click(screen.getByTestId("optimization-run"));
    const err = await screen.findByTestId("optimization-error");
    expect(err.textContent).toContain("boom");
  });
});
