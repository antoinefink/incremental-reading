/**
 * Onboarding tests (T050).
 *
 * The first-run welcome shows ONCE — only when the `ui.seenOnboarding` flag is
 * unset AND the collection is empty — and dismissing it persists the flag in the
 * settings table (so it survives an app restart). This asserts the renderer seam:
 *  - shown on a fresh, empty collection;
 *  - hidden once the flag is set (returning user);
 *  - hidden when the collection already has elements;
 *  - dismissing writes `ui.seenOnboarding = true`.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Onboarding, SEEN_ONBOARDING_KEY } from "./Onboarding";

const h = vi.hoisted(() => ({
  getSettings: vi.fn(),
  updateSetting: vi.fn(),
  listInspectableElements: vi.fn(),
  navigateSpy: vi.fn(() => Promise.resolve()),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => h.navigateSpy,
}));

vi.mock("../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../lib/appApi")>("../lib/appApi");
  return {
    ...actual,
    isDesktop: () => true,
    appApi: {
      getSettings: h.getSettings,
      updateSetting: h.updateSetting,
      listInspectableElements: h.listInspectableElements,
    },
  };
});

describe("Onboarding", () => {
  it("shows on a fresh, empty collection and persists the flag on dismiss", async () => {
    h.getSettings.mockResolvedValue({ settings: {} });
    h.listInspectableElements.mockResolvedValue({ elements: [] });
    h.updateSetting.mockResolvedValue({ key: SEEN_ONBOARDING_KEY, value: true });

    render(<Onboarding />);

    const dismiss = await screen.findByTestId("onboarding-dismiss");
    fireEvent.click(dismiss);

    await waitFor(() =>
      expect(h.updateSetting).toHaveBeenCalledWith({ key: SEEN_ONBOARDING_KEY, value: true }),
    );
  });

  it("stays hidden for a returning user (flag set)", async () => {
    h.getSettings.mockResolvedValue({ settings: { [SEEN_ONBOARDING_KEY]: true } });
    h.listInspectableElements.mockResolvedValue({ elements: [] });

    const { container } = render(<Onboarding />);
    await waitFor(() => expect(h.getSettings).toHaveBeenCalled());
    expect(container.querySelector('[data-testid="onboarding"]')).toBeNull();
  });

  it("stays hidden when the collection already has elements", async () => {
    h.getSettings.mockResolvedValue({ settings: {} });
    h.listInspectableElements.mockResolvedValue({
      elements: [
        {
          id: "e1",
          type: "source",
          status: "active",
          stage: "raw_source",
          priority: 0.5,
          title: "Existing",
          dueAt: null,
        },
      ],
    });

    const { container } = render(<Onboarding />);
    await waitFor(() => expect(h.listInspectableElements).toHaveBeenCalled());
    expect(container.querySelector('[data-testid="onboarding"]')).toBeNull();
  });
});
