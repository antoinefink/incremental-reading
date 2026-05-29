/**
 * Global shell keyboard shortcuts (T004).
 *
 * Wires the keyboard-first chrome described in the charter:
 *   - ⌘K / Ctrl+K  → toggle the command palette
 *   - ?            → toggle the cheat sheet
 *   - g then <key> → quick-navigate (g q → /queue, g r → /review, …)
 *
 * Shortcuts are suppressed while the user is typing in an input/textarea/
 * contenteditable so they never hijack text entry. The `g`-prefix uses a short
 * pending window (matching the kit's 700ms) rather than a global mutable, kept
 * in a ref so re-renders don't reset it.
 *
 * This is UI-interaction wiring, not domain logic — navigation is delegated to
 * the caller via `onNavigate`.
 */
import { useEffect, useRef } from "react";
import { GOTO_MAP } from "./nav";

export type ShellShortcutHandlers = {
  toggleCommandPalette: () => void;
  toggleCheatSheet: () => void;
  onNavigate: (to: string) => void;
};

/** Window (ms) after pressing `g` during which a letter triggers navigation. */
const GOTO_WINDOW_MS = 700;

export function useShellShortcuts({
  toggleCommandPalette,
  toggleCheatSheet,
  onNavigate,
}: ShellShortcutHandlers): void {
  // Latest handlers without re-binding the listener every render.
  const handlers = useRef({ toggleCommandPalette, toggleCheatSheet, onNavigate });
  handlers.current = { toggleCommandPalette, toggleCheatSheet, onNavigate };

  // Whether `g` was pressed recently (the goto-prefix is armed).
  const gotoArmed = useRef(false);
  const gotoTimer = useRef<number | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase() ?? "";
      const typing = tag === "input" || tag === "textarea" || !!target?.isContentEditable;

      // ⌘K / Ctrl+K works even while typing (it's the universal launcher).
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        handlers.current.toggleCommandPalette();
        return;
      }

      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === "?") {
        e.preventDefault();
        handlers.current.toggleCheatSheet();
        return;
      }

      if (gotoArmed.current) {
        const to = GOTO_MAP[e.key.toLowerCase()];
        gotoArmed.current = false;
        if (gotoTimer.current !== null) window.clearTimeout(gotoTimer.current);
        if (to) {
          e.preventDefault();
          handlers.current.onNavigate(to);
        }
        return;
      }

      if (e.key === "g") {
        gotoArmed.current = true;
        if (gotoTimer.current !== null) window.clearTimeout(gotoTimer.current);
        gotoTimer.current = window.setTimeout(() => {
          gotoArmed.current = false;
        }, GOTO_WINDOW_MS);
      }
    }

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (gotoTimer.current !== null) window.clearTimeout(gotoTimer.current);
    };
  }, []);
}
