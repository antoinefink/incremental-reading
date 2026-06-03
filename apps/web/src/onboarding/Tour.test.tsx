import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { getTourSteps, TourLayer } from "./Tour";

describe("getTourSteps", () => {
  it("walks the whole loop and targets only real routes", () => {
    const steps = getTourSteps();
    expect(steps.map((s) => s.key)).toEqual([
      "schedulers",
      "source",
      "read",
      "extract",
      "distill",
      "review",
      "handoff",
    ]);
    const realRoutes = new Set(["/", "/queue", "/inbox", "/review"]);
    for (const s of steps) expect(realRoutes.has(s.route), s.route).toBe(true);
  });
});

describe("TourLayer", () => {
  it("renders nothing with no active index", () => {
    const { container } = render(
      <TourLayer index={null} onNext={() => {}} onPrev={() => {}} onSkip={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders the rail + the active step and advances", () => {
    const onNext = vi.fn();
    const onSkip = vi.fn();
    render(<TourLayer index={0} onNext={onNext} onPrev={() => {}} onSkip={onSkip} />);
    expect(screen.getByText("Guided setup")).toBeInTheDocument();
    expect(screen.getByText("Two clocks")).toBeInTheDocument();
    expect(screen.getByText("Two questions, two clocks")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(onNext).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Skip tour" }));
    expect(onSkip).toHaveBeenCalled();
  });

  it("labels the last step's primary action 'Finish'", () => {
    render(<TourLayer index={6} onNext={() => {}} onPrev={() => {}} onSkip={() => {}} />);
    expect(screen.getByRole("button", { name: "Finish" })).toBeInTheDocument();
  });
});
