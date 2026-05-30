/**
 * Global shell shortcut tests (T048).
 *
 * `useShellShortcuts` is the global keyboard seam. These tests render a tiny host
 * that mounts the hook with spy handlers, dispatch real `keydown`s, and assert:
 *
 *  - the element-targeted keys fire the SAME handlers the shell wires to the
 *    inspector buttons: `o` → onOpenSource, `u` → onOpenParent, `+`/`=` →
 *    onRaisePriority, `-` → onLowerPriority, `/` → onSearch;
 *  - `g` then `q` quick-navigates; `⌘K` toggles the palette;
 *  - typing in an input SUPPRESSES the single-letter actions, but `⌘K` STILL WINS
 *    while typing (the universal launcher);
 *  - a mounted per-screen scope (via `activeScope`) makes the global element keys
 *    DEFER, so the scope hook owns them with no double-fire.
 *
 * The hook only dispatches; the real `appApi` calls live behind these handlers
 * (tested where they are wired). No DB, no network — pure interaction wiring.
 */

import { fireEvent, render } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pushActiveScope } from "./activeScope";
import { type ShellShortcutHandlers, useShellShortcuts } from "./useShellShortcuts";

function makeHandlers(): ShellShortcutHandlers {
  return {
    toggleCommandPalette: vi.fn(),
    toggleCheatSheet: vi.fn(),
    onNavigate: vi.fn(),
    onUndo: vi.fn(),
    onSearch: vi.fn(),
    onOpenSource: vi.fn(),
    onOpenParent: vi.fn(),
    onRaisePriority: vi.fn(),
    onLowerPriority: vi.fn(),
  };
}

function Host({ handlers }: { handlers: ShellShortcutHandlers }) {
  useShellShortcuts(handlers);
  return (
    <div>
      <input data-testid="field" />
    </div>
  );
}

describe("useShellShortcuts — global element actions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("o / u / + / - / dispatch the matching handler", () => {
    const h = makeHandlers();
    render(<Host handlers={h} />);

    fireEvent.keyDown(window, { key: "o" });
    expect(h.onOpenSource).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: "u" });
    expect(h.onOpenParent).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: "+" });
    fireEvent.keyDown(window, { key: "=" });
    expect(h.onRaisePriority).toHaveBeenCalledTimes(2);

    fireEvent.keyDown(window, { key: "-" });
    expect(h.onLowerPriority).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: "/" });
    expect(h.onSearch).toHaveBeenCalledTimes(1);
  });

  it("⌘K toggles the palette; g then q navigates", () => {
    const h = makeHandlers();
    render(<Host handlers={h} />);

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(h.toggleCommandPalette).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: "g" });
    fireEvent.keyDown(window, { key: "q" });
    expect(h.onNavigate).toHaveBeenCalledWith("/queue");
  });

  it("suppresses single-letter actions while typing, but ⌘K still wins", () => {
    const h = makeHandlers();
    const { getByTestId } = render(<Host handlers={h} />);
    const field = getByTestId("field");

    // Typing in the input: the element actions are suppressed.
    fireEvent.keyDown(field, { key: "o" });
    fireEvent.keyDown(field, { key: "+" });
    fireEvent.keyDown(field, { key: "/" });
    expect(h.onOpenSource).not.toHaveBeenCalled();
    expect(h.onRaisePriority).not.toHaveBeenCalled();
    expect(h.onSearch).not.toHaveBeenCalled();

    // …but ⌘K is the universal launcher and works even while typing.
    fireEvent.keyDown(field, { key: "k", metaKey: true });
    expect(h.toggleCommandPalette).toHaveBeenCalledTimes(1);
  });

  it("defers element actions to a mounted per-screen scope (no double-fire)", () => {
    const h = makeHandlers();
    render(<Host handlers={h} />);

    // Simulate the queue process loop being active (it owns `o`/`+`/`-`).
    const release = pushActiveScope("queue");
    fireEvent.keyDown(window, { key: "o" });
    fireEvent.keyDown(window, { key: "+" });
    expect(h.onOpenSource).not.toHaveBeenCalled();
    expect(h.onRaisePriority).not.toHaveBeenCalled();

    // …and once the scope unmounts, the global keys are live again.
    release();
    fireEvent.keyDown(window, { key: "o" });
    expect(h.onOpenSource).toHaveBeenCalledTimes(1);
  });

  it("⌘Z triggers undo outside a field, but not while typing", () => {
    const h = makeHandlers();
    const { getByTestId } = render(<Host handlers={h} />);

    fireEvent.keyDown(window, { key: "z", metaKey: true });
    expect(h.onUndo).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(getByTestId("field"), { key: "z", metaKey: true });
    expect(h.onUndo).toHaveBeenCalledTimes(1); // unchanged — field undo is native
  });
});

// A leak guard: a host that mounts + unmounts should leave no scope active so other
// tests' global keys are unaffected.
function ScopedHost() {
  useEffect(() => pushActiveScope("review"), []);
  return null;
}

describe("activeScope cleanup", () => {
  it("releases its scope on unmount", () => {
    const { unmount } = render(<ScopedHost />);
    unmount();
    // After unmount the global keys must be live again.
    const h = makeHandlers();
    render(<Host handlers={h} />);
    fireEvent.keyDown(window, { key: "o" });
    expect(h.onOpenSource).toHaveBeenCalledTimes(1);
  });
});
