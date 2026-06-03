import { fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReviewCardExpiry } from "../lib/appApi";
import { ExpiryBanner } from "./ExpiryBanner";

function expiry(overrides: Partial<ReviewCardExpiry>): ReviewCardExpiry {
  return {
    status: "expired",
    validUntil: null,
    reviewBy: null,
    jurisdiction: null,
    softwareVersion: null,
    ...overrides,
  };
}

describe("ExpiryBanner", () => {
  it("renders expired claims with context and the danger state", () => {
    const { getByTestId, getByText } = render(
      <ExpiryBanner
        expiry={expiry({
          status: "expired",
          validUntil: "2026-05-01",
          jurisdiction: "US",
          softwareVersion: "v2.1",
        })}
      />,
    );

    expect(getByTestId("review-expiry-banner")).toHaveAttribute("data-expiry-status", "expired");
    expect(getByTestId("review-expiry-banner")).toHaveClass("banner--expired");
    expect(getByText("This fact may be out of date (expired 2026-05-01)")).toBeInTheDocument();
    expect(getByText(/v2\.1 · US/)).toBeInTheDocument();
  });

  it("renders due-for-review claims with the review state", () => {
    const { getByTestId, getByText } = render(
      <ExpiryBanner expiry={expiry({ status: "due_for_review", reviewBy: "2026-06-10" })} />,
    );

    expect(getByTestId("review-expiry-banner")).toHaveAttribute(
      "data-expiry-status",
      "due_for_review",
    );
    expect(getByTestId("review-expiry-banner")).toHaveClass("banner--review");
    expect(getByText("Due for review by 2026-06-10")).toBeInTheDocument();
  });

  it("creates a verify task once and then disables the action", async () => {
    const onCreateTask = vi.fn(async () => {});
    const { getByTestId } = render(
      <ExpiryBanner expiry={expiry({ status: "expired" })} onCreateTask={onCreateTask} />,
    );

    const button = getByTestId("review-create-verify-task");
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(button).toBeDisabled());
    expect(button).toHaveTextContent("Verify task created");
    expect(onCreateTask).toHaveBeenCalledTimes(1);
  });
});
