/**
 * Shell sidebar live-count badges hook.
 *
 * Wires the Queue / Inbox / Review nav badges to REAL `window.appApi` data
 * instead of hardcoded placeholder numbers:
 *  - `queue`  — the full due set (cards + attention items): `queue.list()` →
 *    `counts.all`;
 *  - `review` — the due FSRS-card count specifically: `queue.list()` →
 *    `counts.card` (Review only reviews cards, never attention items);
 *  - `inbox`  — the number of inbox-status sources: `inbox.list()` → length.
 *
 * One `queue.list()` call yields both the Queue and Review counts (no extra
 * round-trip). The counts refresh on mount, whenever a command-level undo fires
 * (`UNDO_EVENT`), and whenever another surface requests a queue refresh. Outside
 * the desktop shell (browser / Vite-only) there is no SQLite, so the hook returns
 * an empty map and every badge hides — it never invents a count. No domain logic
 * lives here: the counts are computed main-side (the queue/inbox repositories);
 * this only awaits the typed IPC promises.
 */

import { useEffect, useState } from "react";
import { listenQueueRefresh } from "../components/queue/queueRefresh";
import { appApi, isDesktop } from "../lib/appApi";
import { UNDO_EVENT } from "./nav";

/** Live sidebar badge counts, keyed by nav id. Absent keys / `0` hide the badge. */
export interface NavBadgeCounts {
  /** Total due items (cards + attention), or `undefined` until loaded. */
  readonly queue?: number;
  /** Inbox-status sources awaiting triage, or `undefined` until loaded. */
  readonly inbox?: number;
  /** Due FSRS cards (the Review deck), or `undefined` until loaded. */
  readonly review?: number;
}

/**
 * Load the live Queue / Inbox / Review counts for the sidebar badges, refreshing
 * on mount, `UNDO_EVENT`, and the cross-surface queue refresh event. Returns an
 * empty map outside the desktop shell so every badge hides (no invented counts).
 */
export function useNavBadges(): NavBadgeCounts {
  const [counts, setCounts] = useState<NavBadgeCounts>({});

  useEffect(() => {
    if (!isDesktop()) return;
    let cancelled = false;

    const refresh = () => {
      void appApi
        .listQueue()
        .then((res) => {
          if (cancelled) return;
          setCounts((prev) => ({
            ...prev,
            queue: res.counts.all,
            review: res.counts.card,
          }));
        })
        .catch(() => {});
      void appApi
        .listInbox()
        .then((res) => {
          if (!cancelled) setCounts((prev) => ({ ...prev, inbox: res.items.length }));
        })
        .catch(() => {});
    };

    refresh();
    window.addEventListener(UNDO_EVENT, refresh);
    const unlistenQueueRefresh = listenQueueRefresh(refresh);
    return () => {
      cancelled = true;
      window.removeEventListener(UNDO_EVENT, refresh);
      unlistenQueueRefresh();
    };
  }, []);

  return counts;
}
