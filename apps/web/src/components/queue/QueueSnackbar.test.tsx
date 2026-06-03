import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { QueueSnackbar } from "./QueueSnackbar";

describe("QueueSnackbar", () => {
  it("uses queue-specific test hooks while delegating to the shared snackbar", () => {
    const onUndo = vi.fn();
    const { getByTestId, getByText } = render(
      <QueueSnackbar message="Item dismissed" onClose={vi.fn()} onUndo={onUndo} />,
    );

    expect(getByTestId("queue-snackbar")).toHaveAttribute("role", "status");
    expect(getByText("Item dismissed")).toBeInTheDocument();
    fireEvent.click(getByTestId("queue-snackbar-undo"));
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it("renders nothing without a message", () => {
    const { queryByTestId } = render(<QueueSnackbar message={null} onClose={vi.fn()} />);

    expect(queryByTestId("queue-snackbar")).not.toBeInTheDocument();
  });
});
