import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SNACKBAR_TIMEOUT_MS, Snackbar } from "./Snackbar";

afterEach(() => {
  vi.useRealTimers();
});

describe("Snackbar", () => {
  it("renders nothing for an empty message", () => {
    const { queryByTestId } = render(<Snackbar message={null} onClose={vi.fn()} />);

    expect(queryByTestId("snackbar")).not.toBeInTheDocument();
  });

  it("renders the message and optional undo action", () => {
    const onUndo = vi.fn();
    const { getByTestId, getByText } = render(
      <Snackbar message="Source deleted" onClose={vi.fn()} onUndo={onUndo} />,
    );

    expect(getByTestId("snackbar")).toHaveAttribute("role", "status");
    expect(getByText("Source deleted")).toBeInTheDocument();

    fireEvent.click(getByTestId("snackbar-undo"));
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it("auto-dismisses after the timeout", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(<Snackbar message="Source deleted" onClose={onClose} />);

    act(() => {
      vi.advanceTimersByTime(SNACKBAR_TIMEOUT_MS - 1);
    });
    expect(onClose).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("clears the timer when the message disappears", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const { rerender } = render(<Snackbar message="Source deleted" onClose={onClose} />);

    rerender(<Snackbar message={null} onClose={onClose} />);
    act(() => {
      vi.advanceTimersByTime(SNACKBAR_TIMEOUT_MS);
    });

    expect(onClose).not.toHaveBeenCalled();
  });
});
