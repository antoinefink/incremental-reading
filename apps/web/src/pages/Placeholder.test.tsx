import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Placeholder } from "./Placeholder";

describe("Placeholder", () => {
  it("renders a route-scoped placeholder with icon, title, and body", () => {
    const { container, getByTestId, getByText } = render(
      <Placeholder icon="queue" routeId="queue" title="Daily Queue" body="Process what is due." />,
    );

    expect(getByTestId("route-queue")).toBeInTheDocument();
    expect(getByText("Daily Queue")).toBeInTheDocument();
    expect(getByText("Process what is due.")).toBeInTheDocument();
    expect(container.querySelector("svg")).not.toBeNull();
  });
});
