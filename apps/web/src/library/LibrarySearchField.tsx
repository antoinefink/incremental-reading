/**
 * Isolated, memoized `/search` input (U1).
 *
 * The Collection Explorer search box used to be an inline controlled `<input>`
 * whose `value` lived in {@link LibraryScreen} state. Every keystroke called
 * `setRawQuery`, which synchronously re-rendered the whole screen — the grouped
 * result list (each row re-running `highlight()`) and the concept-heavy filterbar
 * — even though none of that data changes on a keystroke. That reconciliation
 * cost is the typing "stutter".
 *
 * This component owns the fast-updating raw text and its 150 ms debounce locally
 * and only emits the debounced value upward via {@link onDebouncedChange}. Because
 * the raw text no longer lives in the parent, a keystroke re-renders ONLY this
 * field; the parent (and its heavy subtree) re-renders at most every 150 ms when
 * the debounced query actually changes. UI-only: no SQL, no IPC, no domain logic.
 */

import { memo, useEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";

const SEARCH_DEBOUNCE_MS = 150;

export type LibrarySearchFieldProps = {
  /**
   * The externally-driven query (the route `q`). When this value changes — or when
   * {@link syncToken} changes — the field's visible text is reset to it and the
   * input refocuses, mirroring the previous route-sync + focus behavior.
   */
  readonly syncQuery: string;
  /**
   * A monotonically-changing token that forces an external sync even when
   * {@link syncQuery} is unchanged (e.g. a route reset to the same `q`). Sync
   * happens whenever EITHER `syncQuery` or this token changes.
   */
  readonly syncToken: number;
  /** Emitted (at most every {@link SEARCH_DEBOUNCE_MS}) with the latest raw text. */
  readonly onDebouncedChange: (value: string) => void;
};

function LibrarySearchFieldImpl({
  syncQuery,
  syncToken,
  onDebouncedChange,
}: LibrarySearchFieldProps) {
  const [value, setValue] = useState(syncQuery);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Keep the latest emitter in a ref so the debounce effect depends only on the
  // raw text — a new `onDebouncedChange` identity must not restart the timer or
  // re-emit a stale value.
  const emitRef = useRef(onDebouncedChange);
  useEffect(() => {
    emitRef.current = onDebouncedChange;
  }, [onDebouncedChange]);

  // External sync (route `q` change / reset): reset the visible text to the route
  // query and refocus — equivalent to the previous LibraryScreen route effect that
  // reset rawQuery + focused the input. Keyed on `syncToken` so a reset to the same
  // `q` still re-syncs and refocuses. We intentionally do NOT depend on `syncQuery`
  // alone, so typing (which diverges `value` from `syncQuery`) never triggers a sync.
  // biome-ignore lint/correctness/useExhaustiveDependencies: syncToken is the sync trigger; syncQuery is read at sync time.
  useEffect(() => {
    setValue(syncQuery);
    inputRef.current?.focus();
  }, [syncToken]);

  // Debounce the raw text into the upward-emitted query. Mirrors the original
  // LibraryScreen debounce shape (150 ms, cleared on each change/unmount).
  useEffect(() => {
    const id = setTimeout(() => emitRef.current(value), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [value]);

  return (
    <div className="lib-searchbar">
      <Icon name="search" size={15} />
      <input
        ref={inputRef}
        type="search"
        data-testid="library-search-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Search sources, extracts, cards, concepts…"
        // biome-ignore lint/a11y/noAutofocus: search is the screen's primary action
        autoFocus
      />
    </div>
  );
}

export const LibrarySearchField = memo(LibrarySearchFieldImpl);
