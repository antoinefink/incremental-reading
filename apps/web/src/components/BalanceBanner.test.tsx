/**
 * BalanceBanner component tests (T046).
 *
 * The balance math lives MAIN-side (`packages/local-db` `AnalyticsService.computeBalance`
 * + `@interleave/core` `judgeBalance`); this asserts the RENDERER seam only:
 *  - the banner shows ONLY when the mocked `balance.get` payload is `imbalanced`,
 *    and surfaces the four weekly numbers;
 *  - it is HIDDEN when the snapshot is `ok`;
 *  - it respects the `balanceWarnings = false` toggle (hidden even when imbalanced);
 *  - the danger variant carries `data-severity="danger"`.
 *
 * `appApi` + the router's `useNavigate` are mocked so the test exercises only this
 * component's wiring.
 */

import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings, BalanceGetResult } from "../lib/appApi";

const h = vi.hoisted(() => {
  const imbalanced: BalanceGetResult = {
    asOf: "2026-05-30T18:00:00.000Z",
    windowDays: 7,
    sourcesImported: 9,
    extractsCreated: 2,
    cardsCreated: 1,
    reviewsDueThisWeek: 14,
    imbalanced: true,
    severity: "warn",
  };
  const settings = { balanceWarnings: true } as unknown as AppSettings;
  return {
    imbalanced,
    settings,
    getBalance: vi.fn(),
    getAppSettings: vi.fn(),
    navigateSpy: vi.fn(),
  };
});

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => h.navigateSpy,
}));

vi.mock("../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../lib/appApi")>("../lib/appApi");
  return {
    ...actual,
    isDesktop: () => true,
    appApi: { getBalance: h.getBalance, getAppSettings: h.getAppSettings },
  };
});

import { BalanceBanner } from "./BalanceBanner";

beforeEach(() => {
  vi.clearAllMocks();
  h.getBalance.mockResolvedValue(h.imbalanced);
  h.getAppSettings.mockResolvedValue({ settings: h.settings });
});

describe("BalanceBanner (T046)", () => {
  it("shows the banner with the four weekly numbers when imbalanced", async () => {
    render(<BalanceBanner />);
    const banner = await screen.findByTestId("balance-banner");
    expect(banner.getAttribute("data-severity")).toBe("warn");
    expect(screen.getByTestId("balance-sources").textContent).toBe("9");
    expect(screen.getByTestId("balance-extracts").textContent).toBe("2");
    expect(screen.getByTestId("balance-cards").textContent).toBe("1");
    expect(screen.getByTestId("balance-reviews").textContent).toBe("14");
  });

  it("renders the danger variant for a severe imbalance", async () => {
    h.getBalance.mockResolvedValue({ ...h.imbalanced, severity: "danger" });
    render(<BalanceBanner />);
    const banner = await screen.findByTestId("balance-banner");
    expect(banner.getAttribute("data-severity")).toBe("danger");
  });

  it("is hidden when the week is balanced (severity ok)", async () => {
    h.getBalance.mockResolvedValue({ ...h.imbalanced, imbalanced: false, severity: "ok" });
    const { container } = render(<BalanceBanner />);
    // Let the async load settle, then assert nothing rendered.
    await waitFor(() => expect(h.getBalance).toHaveBeenCalled());
    expect(screen.queryByTestId("balance-banner")).toBeNull();
    expect(container.querySelector("[data-testid='balance-banner']")).toBeNull();
  });

  it("respects the balanceWarnings off toggle (hidden even when imbalanced)", async () => {
    h.getAppSettings.mockResolvedValue({
      settings: { balanceWarnings: false } as unknown as AppSettings,
    });
    render(<BalanceBanner />);
    await waitFor(() => expect(h.getAppSettings).toHaveBeenCalled());
    expect(screen.queryByTestId("balance-banner")).toBeNull();
  });
});
