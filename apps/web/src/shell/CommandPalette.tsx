/**
 * ⌘K command palette (T004).
 *
 * A filterable, keyboard-driven launcher rebuilt from the kit's CommandPalette:
 * type to filter, ↑/↓ to move, Enter to run, Esc to close. Choosing an item
 * navigates to its route. Pure UI — the catalogue is static config from
 * `nav.ts`; navigation is delegated to the caller.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { Kbd } from "./Kbd";
import { COMMAND_ITEMS, type CommandContext, type CommandItem } from "./nav";
import type { PaletteActionId } from "./shortcuts";

export type CommandPaletteProps = {
  open: boolean;
  onClose: () => void;
  /** Navigate to a route path (a registered TanStack Router path). */
  onNavigate: (to: string) => void;
  /**
   * Run a registry-backed ACTION command (T048). The shell supplies a handler that
   * dispatches the SAME typed `window.appApi` command as the matching on-screen
   * button (no second mutation path).
   */
  onAction: (actionId: PaletteActionId) => void;
  /** Whether an element is selected — gates context-scoped action commands (T048). */
  hasSelection: boolean;
};

export function CommandPalette({
  open,
  onClose,
  onNavigate,
  onAction,
  hasSelection,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const ctx = useMemo<CommandContext>(() => ({ hasSelection }), [hasSelection]);

  const filtered = useMemo(
    () =>
      COMMAND_ITEMS.filter(
        (i) => (i.when ? i.when(ctx) : true) && i.label.toLowerCase().includes(query.toLowerCase()),
      ),
    [query, ctx],
  );

  /**
   * Run a chosen command (T048): navigate to its route (if any), run its
   * registry-backed action (if any), then dispatch its optional CustomEvent — e.g.
   * "New manual note…" navigates to `/inbox` and opens its modal; "Open source"
   * runs the open-source action; "Start review" navigates AND (no-op action). The
   * action runs after navigation so the target screen is mounted to receive it.
   */
  const runItem = useCallback(
    (item: CommandItem) => {
      const navigated = Boolean(item.to);
      if (item.to) onNavigate(item.to);
      onClose();
      if (item.actionId) {
        const id = item.actionId;
        // When the command also navigated, defer the action one tick so the route
        // has applied before the action reads the (possibly new) screen state;
        // action-only commands run synchronously.
        if (navigated) window.setTimeout(() => onAction(id), 0);
        else onAction(id);
      }
      if (item.event) {
        const eventName = item.event;
        window.setTimeout(() => window.dispatchEvent(new CustomEvent(eventName)), 0);
      }
    },
    [onNavigate, onClose, onAction],
  );

  // Reset + focus when opened.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelected(0);
    const id = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(id);
  }, [open]);

  // Keyboard handling while open.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelected((s) => Math.min(s + 1, filtered.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelected((s) => Math.max(s - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const item = filtered[selected];
        if (item) runItem(item);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, filtered, selected, onClose, runItem]);

  if (!open) return null;

  let lastGroup: string | null = null;

  return (
    <div className="shell-cmdk-overlay" data-testid="command-palette">
      {/* Backdrop is a real button so click-to-dismiss is keyboard-accessible
          (Esc also closes via the global handler above). */}
      <button
        type="button"
        className="shell-overlay-backdrop"
        aria-label="Close command palette"
        tabIndex={-1}
        onClick={onClose}
      />
      <div className="shell-cmdk" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="shell-cmdk__input">
          <Icon name="search" size={18} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(0);
            }}
            placeholder="Search, import, or run command…"
            aria-label="Command palette search"
          />
          <Kbd keys="Esc" />
        </div>
        <div className="shell-cmdk__list">
          {filtered.length === 0 && (
            <div className="shell-cmdk__group">No commands match “{query}”</div>
          )}
          {filtered.map((item, i) => {
            const showHead = item.group !== lastGroup;
            lastGroup = item.group;
            return (
              <div key={item.label}>
                {showHead && <div className="shell-cmdk__group">{item.group}</div>}
                <button
                  type="button"
                  className={
                    selected === i ? "shell-cmdk__item shell-cmdk__item--on" : "shell-cmdk__item"
                  }
                  onMouseEnter={() => setSelected(i)}
                  onClick={() => runItem(item)}
                >
                  <Icon name={item.icon} size={16} />
                  <span className="shell-grow">{item.label}</span>
                  {item.kbd && <Kbd keys={item.kbd} />}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
