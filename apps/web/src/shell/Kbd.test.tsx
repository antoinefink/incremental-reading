import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Kbd } from "./Kbd";

describe("Kbd", () => {
  it("renders one key cap for a single key", () => {
    const { container, getByText } = render(<Kbd keys="?" />);

    expect(getByText("?")).toHaveClass("shell-kbd");
    expect(container.querySelectorAll(".shell-kbd")).toHaveLength(1);
  });

  it("renders adjacent key caps for a chord", () => {
    const { container, getByText } = render(<Kbd keys={["Cmd", "K"]} />);

    expect(getByText("Cmd")).toHaveClass("shell-kbd");
    expect(getByText("K")).toHaveClass("shell-kbd");
    expect(container.querySelectorAll(".shell-kbd")).toHaveLength(2);
  });
});
