import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BudgetMeter } from "./BudgetMeter";

describe("BudgetMeter", () => {
  it("renders within-budget usage without an over-budget segment", () => {
    const { container, getByText, queryByTestId } = render(<BudgetMeter used={4} target={10} />);

    expect(getByText("/ 10 today")).toBeInTheDocument();
    expect(queryByTestId("budget-over")).not.toBeInTheDocument();
    expect(container.querySelector(".budget__used")).toHaveStyle({ width: "40%" });
    expect(container.querySelector(".budget__over")).not.toBeInTheDocument();
  });

  it("splits usage between within-budget and over-budget segments", () => {
    const { container, getByTestId, getByText } = render(<BudgetMeter used={12} target={10} />);

    expect(getByTestId("budget-over")).toHaveTextContent("2 over budget");
    expect(getByText("Over budget")).toBeInTheDocument();
    expect(container.querySelector(".budget__used")).toHaveStyle({ width: `${(10 / 12) * 100}%` });
    expect(container.querySelector(".budget__over")).toHaveStyle({ width: `${(2 / 12) * 100}%` });
  });

  it("handles a zero target without invalid widths", () => {
    const { container } = render(<BudgetMeter used={0} target={0} />);

    expect(container.querySelector(".budget__used")).toHaveStyle({ width: "0%" });
    expect(container.querySelector(".budget__over")).not.toBeInTheDocument();
  });
});
