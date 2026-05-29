/**
 * Jump-to-source navigation (T022) — the renderer side of actionable lineage.
 *
 * An extract (or card) carries a `source_locations` anchor that the inspector
 * surfaces as a {@link LocationSummary} (source element id + ordered stable block
 * ids + offsets + label + snapshot — all riding along on `inspector.get`, no
 * extra IPC). "Jump to source" turns that into a navigation: open the source
 * reader for `sourceElementId` and ask it to scroll + flash the originating
 * paragraph.
 *
 * Cross-route mechanism: we navigate to `/source/$id` with a `jump` search param
 * carrying the target stable block id (+ caret offset). The reader reads that
 * param once its editor is ready and runs the scroll/flash via the editor
 * package's {@link jumpToSource} (so the editor/ProseMirror logic stays out of
 * React). The search param is the resume signal even when the source is already
 * open, and it survives an app restart of the route (the jump re-runs on load).
 *
 * No SQL / no DB here — the location comes from the typed bridge; this hook only
 * routes. Resolution is by STABLE block id, never an absolute position, so the
 * jump lands correctly after edits / re-imports.
 */

import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import type { LocationSummary } from "../lib/appApi";

/** The reader's `jump` search param shape (the scroll/flash target). */
export interface JumpSearch {
  /** The stable block id to scroll to + flash. */
  readonly block: string;
  /** Caret offset within that block; optional. */
  readonly offset?: number;
  /** The human-readable location label, for the "Jumped to source · …" toast. */
  readonly label?: string;
  /** A nonce so re-clicking "Jump" on an already-open source re-triggers the jump. */
  readonly n?: number;
}

/** Build the `jump` search payload from a location's first spanned block. */
export function jumpSearchForLocation(location: LocationSummary): JumpSearch | null {
  const block = location.blockIds[0];
  if (!block) return null;
  const search: JumpSearch = {
    block,
    offset: location.startOffset ?? 0,
    // A fresh nonce makes the search param change even when navigating to the same
    // source/block again, so the reader's jump effect re-fires.
    n: Date.now(),
  };
  return location.label ? { ...search, label: location.label } : search;
}

/**
 * Returns a callback that navigates to a location's source reader and asks it to
 * scroll/flash the originating block. No-op for a location with no block ids
 * (e.g. a page/timestamp-only location) — the inspector still shows the snapshot.
 */
export function useNavigateToLocation(): (location: LocationSummary) => void {
  const navigate = useNavigate();
  return useCallback(
    (location: LocationSummary) => {
      const jump = jumpSearchForLocation(location);
      void navigate({
        to: "/source/$id",
        params: { id: location.sourceElementId },
        // The source route declares no `validateSearch`; arbitrary search is allowed.
        search: (jump ?? {}) as Record<string, unknown>,
      });
    },
    [navigate],
  );
}
