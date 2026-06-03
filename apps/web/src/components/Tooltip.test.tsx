import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Tooltip } from "./Tooltip";

// The bubble is portaled to document.body; React Testing Library's automatic
// afterEach cleanup unmounts the tree (and the portal with it) between cases, so
// no manual teardown is needed — clearing document.body here would race that
// unmount and throw a "node to be removed is not a child" error.

function renderButton(props?: { disabled?: boolean }) {
  return render(
    <Tooltip label="Raise priority" disabled={props?.disabled ?? false}>
      <button type="button" aria-label="Raise priority">
        icon
      </button>
    </Tooltip>,
  );
}

describe("Tooltip", () => {
  it("does not render the bubble until the trigger is hovered or focused", () => {
    renderButton();
    expect(screen.queryByTestId("tooltip")).toBeNull();
  });

  it("shows the bubble on hover and hides it on mouse-leave", () => {
    renderButton();
    const wrap = screen.getByRole("button").parentElement as HTMLElement;
    fireEvent.mouseEnter(wrap);
    expect(screen.getByTestId("tooltip")).toHaveTextContent("Raise priority");
    fireEvent.mouseLeave(wrap);
    expect(screen.queryByTestId("tooltip")).toBeNull();
  });

  it("shows on keyboard focus and hides on blur", () => {
    renderButton();
    const button = screen.getByRole("button");
    fireEvent.focus(button);
    expect(screen.getByTestId("tooltip")).toBeInTheDocument();
    fireEvent.blur(button);
    expect(screen.queryByTestId("tooltip")).toBeNull();
  });

  it("hides on Escape", () => {
    renderButton();
    fireEvent.focus(screen.getByRole("button"));
    expect(screen.getByTestId("tooltip")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("tooltip")).toBeNull();
  });

  it("never renders the bubble when disabled, even on hover", () => {
    renderButton({ disabled: true });
    fireEvent.mouseEnter(screen.getByRole("button").parentElement as HTMLElement);
    expect(screen.queryByTestId("tooltip")).toBeNull();
  });

  it("marks the bubble aria-hidden so it does not double-announce the button's name", () => {
    renderButton();
    fireEvent.focus(screen.getByRole("button"));
    const bubble = screen.getByTestId("tooltip");
    expect(bubble).toHaveAttribute("aria-hidden", "true");
    // The bubble is purely visual; the accessible name still comes from the
    // trigger's own aria-label (no competing tooltip role on a hidden node).
    expect(bubble).not.toHaveAttribute("role");
    expect(screen.getByRole("button", { name: "Raise priority" })).toBeInTheDocument();
  });
});
