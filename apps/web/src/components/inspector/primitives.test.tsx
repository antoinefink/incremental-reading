import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { SchedulerSignals } from "../../lib/appApi";
import { FsrsStats, SchedulerChip } from "./primitives";

/** A complete FSRS `SchedulerSignals` with the raw doubles from the screenshots. */
function fsrsSignals(overrides: Partial<SchedulerSignals> = {}): SchedulerSignals {
  return {
    kind: "fsrs",
    retrievability: 0.93,
    stability: 4.88681033,
    difficulty: 7.37018264,
    reps: 5,
    lapses: 1,
    fsrsState: "review",
    stage: "active_card",
    postponed: 0,
    lastProcessedAt: "2026-06-01T08:00:00.000Z",
    ...overrides,
  };
}

describe("SchedulerChip (FSRS)", () => {
  it("truncates the raw stability double for display but keeps full precision in the title", () => {
    const { container } = render(<SchedulerChip scheduler={fsrsSignals()} />);
    const stability = container.querySelector('span[title^="Stability"]') as HTMLElement;
    expect(stability.textContent).toBe("S 4.9d");
    // The exact value never reaches the visible chip…
    expect(container.textContent).not.toContain("4.88681033");
    // …but is preserved verbatim on hover.
    expect(stability).toHaveAttribute("title", "Stability 4.88681033 days");
  });

  it("rounds retrievability to a whole percent", () => {
    const { container } = render(
      <SchedulerChip scheduler={fsrsSignals({ retrievability: 0.934 })} />,
    );
    expect(container.textContent).toContain("93%");
  });

  it("omits the stability segment entirely for a brand-new card", () => {
    const { container } = render(
      <SchedulerChip scheduler={fsrsSignals({ stability: null, retrievability: null })} />,
    );
    expect(container.textContent).toContain("new");
    expect(container.querySelector('span[title^="Stability"]')).toBeNull();
  });
});

describe("FsrsStats", () => {
  it("truncates stability and difficulty in the cards, keeping full precision in the title", () => {
    const { container } = render(<FsrsStats scheduler={fsrsSignals()} />);
    const values = container.querySelectorAll(".fstat__v");
    const stability = values[0] as HTMLElement;
    const difficulty = values[1] as HTMLElement;
    const retrievability = values[2] as HTMLElement;

    expect(stability.textContent).toBe("4.9d");
    expect(stability).toHaveAttribute("title", "4.88681033 days");
    expect(difficulty.textContent).toBe("7.4/10");
    expect(difficulty).toHaveAttribute("title", "7.37018264 / 10");
    expect(retrievability.textContent).toBe("93%");

    // No absurd precision leaks into the visible readout.
    expect(container.textContent).not.toContain("4.88681033");
    expect(container.textContent).not.toContain("7.37018264");
  });

  it("renders an em dash for an unknown retrievability", () => {
    const { container } = render(<FsrsStats scheduler={fsrsSignals({ retrievability: null })} />);
    const retrievability = container.querySelectorAll(".fstat__v")[2] as HTMLElement;
    expect(retrievability.textContent).toBe("—");
  });

  it("falls back to 0 for a card with no stability/difficulty yet", () => {
    const { container } = render(
      <FsrsStats scheduler={fsrsSignals({ stability: null, difficulty: null })} />,
    );
    const values = container.querySelectorAll(".fstat__v");
    expect((values[0] as HTMLElement).textContent).toBe("0d");
    expect((values[1] as HTMLElement).textContent).toBe("0/10");
  });
});
