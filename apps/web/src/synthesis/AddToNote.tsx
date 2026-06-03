/**
 * AddToNote (T095) — the "collect into a synthesis note" picker.
 *
 * A small modal that lists the live extracts/cards the user can COLLECT into a
 * synthesis note (the `references` material). Reads the typed `inspector.list`
 * surface (read-only), filters to extracts/cards not already linked, supports a
 * keyword filter, and fires `onPick(targetId)` which the parent routes through
 * `synthesis.link` (`add_relation`). The renderer holds no SQL — it only chooses
 * what to add.
 */

import { useEffect, useMemo, useState } from "react";
import { Icon } from "../components/Icon";
import { appApi, type ElementSummary, isDesktop } from "../lib/appApi";

/** Element types a synthesis note may collect (must match the main-side guard). */
const LINKABLE_TYPES = new Set(["extract", "card"]);

export function AddToNote({
  noteId,
  excludeIds,
  onPick,
  onClose,
}: {
  /** The synthesis note being added to (excluded from the candidate list). */
  readonly noteId: string;
  /** Already-linked target ids to hide from the candidate list. */
  readonly excludeIds: readonly string[];
  /** Add one candidate to the note (the parent links it via `synthesis.link`). */
  readonly onPick: (targetId: string) => void;
  readonly onClose: () => void;
}) {
  const [all, setAll] = useState<readonly ElementSummary[]>([]);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!isDesktop()) return;
    void appApi
      .listInspectableElements()
      .then((res) => setAll(res.elements))
      .catch(() => setAll([]));
  }, []);

  const exclude = useMemo(() => new Set([noteId, ...excludeIds]), [noteId, excludeIds]);

  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all
      .filter((e) => LINKABLE_TYPES.has(e.type) && !exclude.has(e.id))
      .filter((e) => (q ? e.title.toLowerCase().includes(q) : true))
      .slice(0, 200);
  }, [all, exclude, query]);

  // Close on Escape (keyboard-first hygiene).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="synthesis-picker-overlay" data-testid="synthesis-picker">
      <button
        type="button"
        className="shell-overlay-backdrop"
        aria-label="Close add-to-note picker"
        tabIndex={-1}
        onClick={onClose}
      />
      <div
        className="synthesis-picker"
        role="dialog"
        aria-modal="true"
        aria-label="Add an extract or card to this note"
      >
        <div className="synthesis-picker__head">
          <span className="synthesis-picker__title">Add to note</span>
          <button
            type="button"
            className="synthesis-picker__close"
            aria-label="Close"
            onClick={onClose}
          >
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="synthesis-picker__input">
          <Icon name="search" size={15} />
          <input
            // biome-ignore lint/a11y/noAutofocus: a picker modal is the focus target on open.
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter extracts &amp; cards…"
            aria-label="Filter extracts and cards"
            data-testid="synthesis-picker-filter"
          />
        </div>
        <div className="synthesis-picker__list">
          {candidates.length === 0 ? (
            <p className="dimmed synthesis-picker__empty">No extracts or cards to add.</p>
          ) : (
            candidates.map((c) => (
              <button
                type="button"
                key={c.id}
                className="synthesis-picker__item"
                data-testid="synthesis-picker-item"
                data-element-type={c.type}
                onClick={() => {
                  onPick(c.id);
                  onClose();
                }}
              >
                <Icon name={c.type === "card" ? "card" : "extract"} size={14} />
                <span className="synthesis-picker__item-title">{c.title}</span>
                <span className="synthesis-picker__item-type">{c.type}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
