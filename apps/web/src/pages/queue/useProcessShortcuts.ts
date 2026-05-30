/**
 * Process-queue keyboard controls (T031).
 *
 * The "Process queue" loop is built to be mouse-free: this hook binds the loop's
 * CORE keys so a user can grind through ten mixed elements one-handed. The full
 * shortcut catalog + command palette is T048 (and the global `g`-nav / ⌘K live in
 * the shell's `useShellShortcuts`); this only owns the keys that drive THIS loop.
 *
 *   n / → / Space  → next / skip (advance the cursor without mutating)
 *   p              → postpone the current item
 *   d              → mark done
 *   x              → dismiss
 *   ⌫ / Delete     → delete (soft, undoable)
 *   + / =          → raise priority
 *   -              → lower priority
 *   o / Enter      → open the current item in full (the only navigation)
 *
 * Like the shell shortcuts, keys are suppressed while the user is typing in an
 * input/textarea/contenteditable so they never hijack text entry, and chorded
 * modifier presses (⌘/Ctrl/Alt) are ignored so the shell's ⌘K still wins. This is
 * pure UI-interaction wiring — every handler delegates to the loop, which routes
 * through the SAME typed `appApi` mutation path as the queue list (no new channel).
 */

import { useEffect, useRef } from "react";

/** The actions the loop exposes to the keyboard. */
export interface ProcessShortcutHandlers {
  next(): void;
  postpone(): void;
  markDone(): void;
  dismiss(): void;
  delete(): void;
  raise(): void;
  lower(): void;
  open(): void;
}

/**
 * Bind the loop's core keys. `enabled` gates the listener (so it is inert on the
 * done state / outside the desktop shell). Handlers are read through a ref so the
 * listener never re-binds on every render.
 */
export function useProcessShortcuts(handlers: ProcessShortcutHandlers, enabled: boolean): void {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    if (!enabled) return;
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase() ?? "";
      const typing = tag === "input" || tag === "textarea" || !!target?.isContentEditable;
      // Never hijack text entry, and let the shell's ⌘K / chorded keys through.
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;

      const h = ref.current;
      switch (e.key) {
        case "n":
        case "ArrowRight":
        case " ":
          e.preventDefault();
          h.next();
          break;
        case "p":
          e.preventDefault();
          h.postpone();
          break;
        case "d":
          e.preventDefault();
          h.markDone();
          break;
        case "x":
          e.preventDefault();
          h.dismiss();
          break;
        case "Backspace":
        case "Delete":
          e.preventDefault();
          h.delete();
          break;
        case "+":
        case "=":
          e.preventDefault();
          h.raise();
          break;
        case "-":
          e.preventDefault();
          h.lower();
          break;
        case "o":
        case "Enter":
          e.preventDefault();
          h.open();
          break;
        default:
          break;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}
