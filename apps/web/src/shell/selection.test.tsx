import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SelectionProvider, useSelection } from "./selection";

function SelectionConsumer() {
  const { selectedId, select } = useSelection();
  return (
    <div>
      <span data-testid="selected">{selectedId ?? "none"}</span>
      <button type="button" onClick={() => select("el-1")}>
        Select
      </button>
      <button type="button" onClick={() => select(null)}>
        Clear
      </button>
    </div>
  );
}

describe("SelectionProvider", () => {
  it("stores and clears the selected element id", () => {
    const { getByText, getByTestId } = render(
      <SelectionProvider>
        <SelectionConsumer />
      </SelectionProvider>,
    );

    expect(getByTestId("selected")).toHaveTextContent("none");
    fireEvent.click(getByText("Select"));
    expect(getByTestId("selected")).toHaveTextContent("el-1");
    fireEvent.click(getByText("Clear"));
    expect(getByTestId("selected")).toHaveTextContent("none");
  });

  it("throws when used outside the provider", () => {
    expect(() => render(<SelectionConsumer />)).toThrow(
      "useSelection must be used within a <SelectionProvider>",
    );
  });
});
