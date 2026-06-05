import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { type ProcessShortcutHandlers, useProcessShortcuts } from "./useProcessShortcuts";

function makeHandlers(overrides: Partial<ProcessShortcutHandlers> = {}): ProcessShortcutHandlers {
  return {
    canProcess: true,
    next: vi.fn(),
    postpone: vi.fn(),
    markDone: vi.fn(),
    dismiss: vi.fn(),
    delete: vi.fn(),
    raise: vi.fn(),
    lower: vi.fn(),
    open: vi.fn(),
    canUndo: false,
    undo: vi.fn(),
    isCard: false,
    revealed: false,
    reveal: vi.fn(),
    grade: vi.fn(),
    ...overrides,
  };
}

function Host({
  enabled = true,
  handlers,
}: {
  enabled?: boolean;
  handlers: ProcessShortcutHandlers;
}) {
  useProcessShortcuts(handlers, enabled);
  return (
    <div>
      <input data-testid="field" />
      <div data-testid="editable" contentEditable />
    </div>
  );
}

describe("useProcessShortcuts", () => {
  it("dispatches the non-card process queue controls", () => {
    const h = makeHandlers();
    render(<Host handlers={h} />);

    fireEvent.keyDown(window, { key: "n" });
    fireEvent.keyDown(window, { key: "ArrowRight" });
    fireEvent.keyDown(window, { key: " " });
    expect(h.next).toHaveBeenCalledTimes(3);

    fireEvent.keyDown(window, { key: "p" });
    expect(h.postpone).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: "d" });
    expect(h.markDone).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: "x" });
    expect(h.dismiss).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: "Backspace" });
    fireEvent.keyDown(window, { key: "Delete" });
    expect(h.delete).toHaveBeenCalledTimes(2);

    fireEvent.keyDown(window, { key: "+" });
    fireEvent.keyDown(window, { key: "=" });
    expect(h.raise).toHaveBeenCalledTimes(2);

    fireEvent.keyDown(window, { key: "-" });
    expect(h.lower).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: "o" });
    fireEvent.keyDown(window, { key: "Enter" });
    expect(h.open).toHaveBeenCalledTimes(2);
  });

  it("does not hijack typing, contenteditable, modifier chords, or disabled state", () => {
    const h = makeHandlers();
    const { getByTestId, rerender } = render(<Host handlers={h} />);
    const editable = getByTestId("editable");
    Object.defineProperty(editable, "isContentEditable", { value: true, configurable: true });

    fireEvent.keyDown(getByTestId("field"), { key: "n" });
    fireEvent.keyDown(editable, { key: "p" });
    fireEvent.keyDown(window, { key: "d", metaKey: true });
    fireEvent.keyDown(window, { key: "x", ctrlKey: true });
    fireEvent.keyDown(window, { key: "o", altKey: true });

    expect(h.next).not.toHaveBeenCalled();
    expect(h.postpone).not.toHaveBeenCalled();
    expect(h.markDone).not.toHaveBeenCalled();
    expect(h.dismiss).not.toHaveBeenCalled();
    expect(h.open).not.toHaveBeenCalled();

    rerender(<Host handlers={h} enabled={false} />);
    fireEvent.keyDown(window, { key: "n" });
    expect(h.next).not.toHaveBeenCalled();
  });

  it("captures command undo only while a local process undo is pending", () => {
    const globalUndo = vi.fn();
    window.addEventListener("keydown", globalUndo);
    const noUndo = makeHandlers({ canUndo: false });
    try {
      const { rerender } = render(<Host handlers={noUndo} />);

      const first = new KeyboardEvent("keydown", {
        key: "z",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(first);
      expect(noUndo.undo).not.toHaveBeenCalled();
      expect(first.defaultPrevented).toBe(false);
      expect(globalUndo).toHaveBeenCalledTimes(1);

      const withUndo = makeHandlers({ canUndo: true });
      rerender(<Host handlers={withUndo} />);
      globalUndo.mockClear();

      const second = new KeyboardEvent("keydown", {
        key: "z",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(second);
      expect(withUndo.undo).toHaveBeenCalledTimes(1);
      expect(second.defaultPrevented).toBe(true);
      expect(globalUndo).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", globalUndo);
    }
  });

  it("leaves non-undo process keys inert on the done state", () => {
    const h = makeHandlers({ canProcess: false, canUndo: true });
    render(<Host handlers={h} />);

    fireEvent.keyDown(window, { key: "d" });
    fireEvent.keyDown(window, { key: "p" });
    fireEvent.keyDown(window, { key: "n" });

    expect(h.markDone).not.toHaveBeenCalled();
    expect(h.postpone).not.toHaveBeenCalled();
    expect(h.next).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "z", metaKey: true });
    expect(h.undo).toHaveBeenCalledTimes(1);
  });

  it("uses card semantics: Space reveals, 1-4 grade only after reveal", () => {
    const unrevealed = makeHandlers({ isCard: true, revealed: false });
    const { rerender } = render(<Host handlers={unrevealed} />);

    fireEvent.keyDown(window, { key: " " });
    expect(unrevealed.reveal).toHaveBeenCalledTimes(1);
    expect(unrevealed.next).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "3" });
    expect(unrevealed.grade).not.toHaveBeenCalled();

    const revealed = makeHandlers({ isCard: true, revealed: true });
    rerender(<Host handlers={revealed} />);

    fireEvent.keyDown(window, { key: "1" });
    fireEvent.keyDown(window, { key: "2" });
    fireEvent.keyDown(window, { key: "3" });
    fireEvent.keyDown(window, { key: "4" });
    expect(revealed.grade).toHaveBeenNthCalledWith(1, "again");
    expect(revealed.grade).toHaveBeenNthCalledWith(2, "hard");
    expect(revealed.grade).toHaveBeenNthCalledWith(3, "good");
    expect(revealed.grade).toHaveBeenNthCalledWith(4, "easy");

    fireEvent.keyDown(window, { key: " " });
    expect(revealed.next).not.toHaveBeenCalled();
    expect(revealed.reveal).not.toHaveBeenCalled();
  });
});
