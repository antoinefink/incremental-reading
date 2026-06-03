import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CheatSheet } from "./CheatSheet";

describe("CheatSheet", () => {
  it("renders nothing when closed", () => {
    const { queryByTestId } = render(<CheatSheet open={false} onClose={vi.fn()} />);

    expect(queryByTestId("cheat-sheet")).not.toBeInTheDocument();
  });

  it("renders shortcut groups and closes from Escape, backdrop, and close button", () => {
    const onClose = vi.fn();
    const { getByLabelText, getByRole, getByTestId, getByText } = render(
      <CheatSheet open onClose={onClose} />,
    );

    expect(getByTestId("cheat-sheet")).toBeInTheDocument();
    expect(getByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
    expect(getByText("Navigation")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(getByLabelText("Close keyboard shortcuts"));
    fireEvent.click(getByLabelText("Close"));
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});
