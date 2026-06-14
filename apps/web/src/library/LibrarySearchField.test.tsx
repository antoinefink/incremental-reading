/**
 * LibrarySearchField tests (U1).
 *
 * The isolated `/search` input owns its raw text + the 150 ms debounce, emitting
 * only the debounced value upward. These assert:
 *  - typing updates the visible value on EVERY keystroke (controlled, no dropped chars);
 *  - N fast keystrokes within the debounce window emit `onDebouncedChange` ONCE (the last);
 *  - an external sync (route `q` change / reset) resets the visible text + refocuses;
 *  - the testid / placeholder / type contract is unchanged.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LibrarySearchField } from "./LibrarySearchField";

afterEach(() => {
  vi.useRealTimers();
});

function input() {
  return screen.getByTestId("library-search-input") as HTMLInputElement;
}

describe("LibrarySearchField", () => {
  it("preserves the testid, placeholder, and search type contract", () => {
    render(<LibrarySearchField syncQuery="" syncToken={0} onDebouncedChange={vi.fn()} />);
    const el = input();
    expect(el.getAttribute("type")).toBe("search");
    expect(el.getAttribute("placeholder")).toBe("Search sources, extracts, cards, concepts…");
    // The wrapping markup CSS selector is preserved.
    expect(el.closest(".lib-searchbar")).not.toBeNull();
  });

  it("updates the visible value on every keystroke (controlled, no dropped chars)", () => {
    render(<LibrarySearchField syncQuery="" syncToken={0} onDebouncedChange={vi.fn()} />);
    fireEvent.change(input(), { target: { value: "i" } });
    expect(input().value).toBe("i");
    fireEvent.change(input(), { target: { value: "in" } });
    expect(input().value).toBe("in");
    fireEvent.change(input(), { target: { value: "int" } });
    expect(input().value).toBe("int");
  });

  it("emits the debounced value ONCE for N fast keystrokes (the last value)", () => {
    vi.useFakeTimers();
    const onDebouncedChange = vi.fn();
    render(<LibrarySearchField syncQuery="" syncToken={0} onDebouncedChange={onDebouncedChange} />);
    onDebouncedChange.mockClear(); // ignore the initial mount emit of ""

    // Five fast keystrokes inside the 150 ms window.
    for (const value of ["i", "in", "int", "inte", "intel"]) {
      fireEvent.change(input(), { target: { value } });
      act(() => {
        vi.advanceTimersByTime(20); // < 150 ms each → never fires mid-typing
      });
    }
    expect(onDebouncedChange).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(150); // quiet period elapses
    });
    expect(onDebouncedChange).toHaveBeenCalledTimes(1);
    expect(onDebouncedChange).toHaveBeenCalledWith("intel");
  });

  it("emits the latest raw text even when onDebouncedChange identity changes between keystrokes", () => {
    vi.useFakeTimers();
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(
      <LibrarySearchField syncQuery="" syncToken={0} onDebouncedChange={first} />,
    );
    fireEvent.change(input(), { target: { value: "ab" } });
    // The parent re-renders with a NEW emitter identity before the debounce fires.
    rerender(<LibrarySearchField syncQuery="" syncToken={0} onDebouncedChange={second} />);
    act(() => {
      vi.advanceTimersByTime(150);
    });
    // The newest emitter is used; the value is the latest raw text.
    expect(second).toHaveBeenCalledWith("ab");
  });

  it("resets the visible text and refocuses when the external sync token changes", () => {
    const onDebouncedChange = vi.fn();
    const { rerender } = render(
      <LibrarySearchField syncQuery="memory" syncToken={1} onDebouncedChange={onDebouncedChange} />,
    );
    expect(input().value).toBe("memory");

    // The user types, diverging the field from the route value…
    fireEvent.change(input(), { target: { value: "memory palace" } });
    expect(input().value).toBe("memory palace");
    input().blur();
    expect(document.activeElement).not.toBe(input());

    // …then an external navigation resets the route `q` (token bumps) → field re-syncs.
    rerender(
      <LibrarySearchField
        syncQuery="intelligence"
        syncToken={2}
        onDebouncedChange={onDebouncedChange}
      />,
    );
    expect(input().value).toBe("intelligence");
    expect(document.activeElement).toBe(input());
  });

  it("re-syncs and refocuses on a token bump even when syncQuery is unchanged (route reset to same q)", () => {
    const { rerender } = render(
      <LibrarySearchField syncQuery="memory" syncToken={1} onDebouncedChange={vi.fn()} />,
    );
    fireEvent.change(input(), { target: { value: "memory leak" } });
    input().blur();

    // Same syncQuery, new token (e.g. a route reset that clears filters but keeps q).
    rerender(<LibrarySearchField syncQuery="memory" syncToken={2} onDebouncedChange={vi.fn()} />);
    expect(input().value).toBe("memory");
    expect(document.activeElement).toBe(input());
  });

  it("does NOT re-sync (overwrite typed text) when only the emitter identity changes", () => {
    const { rerender } = render(
      <LibrarySearchField syncQuery="memory" syncToken={1} onDebouncedChange={vi.fn()} />,
    );
    fireEvent.change(input(), { target: { value: "memory leak" } });
    // A parent re-render with a fresh emitter but the SAME token must not clobber text.
    rerender(<LibrarySearchField syncQuery="memory" syncToken={1} onDebouncedChange={vi.fn()} />);
    expect(input().value).toBe("memory leak");
  });
});
