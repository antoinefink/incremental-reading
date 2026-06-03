import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Coachmark, HelpLink, InlineHint, OnceCoach } from "./Contextual";
import { type HelpContextValue, HelpProvider } from "./HelpContext";

function provide(overrides: Partial<HelpContextValue>): HelpContextValue {
  return {
    tipsEnabled: true,
    setTipsEnabled: () => {},
    isSeen: () => false,
    markSeen: () => {},
    resetTips: () => {},
    openHelp: () => {},
    startTour: () => {},
    ...overrides,
  };
}

describe("HelpLink", () => {
  it("opens help to its slug", () => {
    const openHelp = vi.fn();
    render(
      <HelpProvider value={provide({ openHelp })}>
        <HelpLink slug="two-schedulers" />
      </HelpProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open help" }));
    expect(openHelp).toHaveBeenCalledWith("two-schedulers");
  });

  it("renders an inline variant with custom label", () => {
    render(
      <HelpProvider value={provide({})}>
        <HelpLink slug="lineage" variant="inline">
          About lineage
        </HelpLink>
      </HelpProvider>,
    );
    expect(screen.getByRole("button", { name: /About lineage/ })).toBeInTheDocument();
  });
});

describe("InlineHint", () => {
  it("renders its text and an optional help link", () => {
    const openHelp = vi.fn();
    render(
      <HelpProvider value={provide({ openHelp })}>
        <InlineHint slug="read-points" slugLabel="Read-points">
          Press Space to mark your spot.
        </InlineHint>
      </HelpProvider>,
    );
    expect(screen.getByText(/mark your spot/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Read-points/ }));
    expect(openHelp).toHaveBeenCalledWith("read-points");
  });
});

describe("Coachmark", () => {
  it("renders a centered, one-off coachmark and fires its action", () => {
    const onNext = vi.fn();
    render(
      <HelpProvider value={provide({})}>
        <Coachmark title="Two schedulers" placement="center" onNext={onNext}>
          Cards vs attention.
        </Coachmark>
      </HelpProvider>,
    );
    expect(screen.getByText("Two schedulers")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(onNext).toHaveBeenCalled();
  });
});

describe("OnceCoach", () => {
  it("is hidden when tips are disabled", () => {
    render(
      <HelpProvider value={provide({ tipsEnabled: false })}>
        <OnceCoach id="c1" title="Tip" placement="center">
          body
        </OnceCoach>
      </HelpProvider>,
    );
    expect(screen.queryByText("Tip")).not.toBeInTheDocument();
  });

  it("is hidden when already seen", () => {
    render(
      <HelpProvider value={provide({ isSeen: (id) => id === "c1" })}>
        <OnceCoach id="c1" title="Tip" placement="center">
          body
        </OnceCoach>
      </HelpProvider>,
    );
    expect(screen.queryByText("Tip")).not.toBeInTheDocument();
  });

  it("marks itself seen when dismissed", () => {
    const markSeen = vi.fn();
    render(
      <HelpProvider value={provide({ markSeen })}>
        <OnceCoach id="c1" title="Tip" placement="center">
          body
        </OnceCoach>
      </HelpProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(markSeen).toHaveBeenCalledWith("c1");
  });
});
