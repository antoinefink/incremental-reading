/**
 * Inspector "Expiry" section tests (T090).
 *
 * The claim-lifetime fields + the derived expiry status are computed MAIN-side
 * (`@interleave/core` `deriveExpiryStatus`); this asserts the RENDERER seam only:
 *  - the section renders the derived status badge + the lifetime `MetaRow`s;
 *  - a card with no lifetime shows the calm empty state + an "Add expiry" affordance;
 *  - opening the editor and saving calls `cards.setLifetime` with the entered fields
 *    and then fires `onChanged` so the inspector re-reads (the badge/banner update).
 *
 * `appApi` is mocked so the test exercises only this component's wiring — no IPC/SQLite.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FactLifetimeSummary } from "../../lib/appApi";

const h = vi.hoisted(() => ({ setCardLifetime: vi.fn() }));

vi.mock("../../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../../lib/appApi")>("../../lib/appApi");
  return {
    ...actual,
    isDesktop: () => true,
    appApi: { setCardLifetime: h.setCardLifetime },
  };
});

import { ExpirySection } from "./Inspector";

const EXPIRED: FactLifetimeSummary = {
  status: "expired",
  factStability: "slow",
  validFrom: "2019-11-05",
  validUntil: "2020-01-01",
  jurisdiction: "global",
  softwareVersion: null,
  reviewBy: "2020-01-01",
};

const EMPTY: FactLifetimeSummary = {
  status: "fresh",
  factStability: null,
  validFrom: null,
  validUntil: null,
  jurisdiction: null,
  softwareVersion: null,
  reviewBy: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.setCardLifetime.mockResolvedValue({ card: {}, lifetime: EMPTY });
});

describe("Inspector ExpirySection (T090)", () => {
  it("renders the derived status badge + the lifetime rows for an expired card", () => {
    render(<ExpirySection cardId="card-1" lifetime={EXPIRED} onChanged={vi.fn()} />);
    const badge = screen.getByTestId("inspector-expiry-badge");
    expect(badge).toHaveAttribute("data-expiry-status", "expired");
    expect(badge).toHaveTextContent(/expired/i);
    // The lifetime fields are shown.
    const section = screen.getByTestId("expiry-section");
    expect(section).toHaveTextContent("2020-01-01");
    expect(section).toHaveTextContent("global");
    expect(section).toHaveTextContent(/slow-changing/i);
  });

  it("shows the empty state + an Add expiry affordance for a card with no lifetime", () => {
    render(<ExpirySection cardId="card-1" lifetime={EMPTY} onChanged={vi.fn()} />);
    expect(screen.getByTestId("inspector-expiry-empty")).toBeInTheDocument();
    expect(screen.getByTestId("inspector-expiry-badge")).toHaveAttribute(
      "data-expiry-status",
      "fresh",
    );
    expect(screen.getByTestId("inspector-expiry-edit")).toHaveTextContent(/add expiry/i);
  });

  it("opens the editor, saves the entered fields via cards.setLifetime, and fires onChanged", async () => {
    const onChanged = vi.fn();
    render(<ExpirySection cardId="card-1" lifetime={EMPTY} onChanged={onChanged} />);

    fireEvent.click(screen.getByTestId("inspector-expiry-edit"));
    fireEvent.change(screen.getByTestId("inspector-expiry-valid-until"), {
      target: { value: "2025-01-01" },
    });
    fireEvent.change(screen.getByTestId("inspector-expiry-review-by"), {
      target: { value: "2025-06-01" },
    });
    fireEvent.change(screen.getByTestId("inspector-expiry-stability"), {
      target: { value: "volatile" },
    });
    fireEvent.change(screen.getByTestId("inspector-expiry-jurisdiction"), {
      target: { value: "US-CA" },
    });
    fireEvent.click(screen.getByTestId("inspector-expiry-save"));

    await waitFor(() => {
      expect(h.setCardLifetime).toHaveBeenCalledWith(
        expect.objectContaining({
          cardId: "card-1",
          validUntil: "2025-01-01",
          reviewBy: "2025-06-01",
          factStability: "volatile",
          jurisdiction: "US-CA",
        }),
      );
    });
    expect(onChanged).toHaveBeenCalled();
  });
});
