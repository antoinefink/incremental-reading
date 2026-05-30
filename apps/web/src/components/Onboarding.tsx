/**
 * Onboarding (T050) — the minimal first-run welcome / empty-state.
 *
 * The shipped MVP must be approachable to a brand-new user the first time they
 * open the packaged app. This is the smallest honest version of that: a calm
 * welcome panel shown ONCE, on the very first launch, that names the core loop
 * (import → read → extract → card → review) and points the user at the single
 * first action — importing a source. Dismissing it (or starting the import)
 * persists a `ui.seenOnboarding` flag in the `settings` table so it never shows
 * again and the choice survives an app restart.
 *
 * It only appears when BOTH (a) the flag is unset AND (b) the collection is empty
 * — so a user who already has data (or who restarted mid-session) is never
 * interrupted. "Import your first source" routes to `/inbox` and opens its
 * New-source modal via the existing `NEW_SOURCE_EVENT` (the SAME path the ⌘K
 * "Paste text as source…" command uses — no second entry point).
 *
 * Architecture (non-negotiable): UI ONLY. It reads the empty signal via
 * `appApi.listInspectableElements()` and the flag via the generic
 * `appApi.getSettings` / `updateSetting` key/value surface; it never touches
 * SQLite or the filesystem. Renders `null` outside the desktop shell.
 *
 * Visual: the kit's centered empty-state family (`an-empty`) — a round icon, a
 * title, a short body, and primary/secondary actions.
 */

import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { appApi, isDesktop } from "../lib/appApi";
import { NEW_SOURCE_EVENT } from "../shell/nav";
import { Icon } from "./Icon";

/** Generic settings key persisting that the user has seen the welcome (survives restart). */
export const SEEN_ONBOARDING_KEY = "ui.seenOnboarding";

export function Onboarding() {
  // null = undetermined (don't flash); false = show; true = already seen / not empty.
  const [show, setShow] = useState<boolean | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!isDesktop()) {
      setShow(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const [{ settings }, { elements }] = await Promise.all([
          appApi.getSettings(),
          appApi.listInspectableElements(),
        ]);
        const seen = settings[SEEN_ONBOARDING_KEY] === true;
        if (!cancelled) setShow(!seen && elements.length === 0);
      } catch {
        // Never block the app on the welcome check.
        if (!cancelled) setShow(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const persistSeen = useCallback(async () => {
    try {
      await appApi.updateSetting({ key: SEEN_ONBOARDING_KEY, value: true });
    } catch {
      // Best-effort; worst case the welcome shows once more next launch.
    }
  }, []);

  const onDismiss = useCallback(() => {
    setShow(false);
    void persistSeen();
  }, [persistSeen]);

  const onImport = useCallback(() => {
    setShow(false);
    void persistSeen();
    void navigate({ to: "/inbox" }).then(() => {
      // Open the inbox's New-source modal via the same event the ⌘K command uses.
      window.dispatchEvent(new CustomEvent(NEW_SOURCE_EVENT));
    });
  }, [navigate, persistSeen]);

  if (show !== true) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
      data-testid="onboarding"
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-title"
    >
      <div className="w-full max-w-md rounded-lg border border-border bg-surface p-8 text-center shadow-lg">
        <span className="mx-auto mb-3 inline-flex h-14 w-14 items-center justify-center rounded-full border border-border bg-surface-2 text-accent">
          <Icon name="sparkle" size={24} />
        </span>
        <h2 id="onboarding-title" className="text-lg font-semibold text-text">
          Welcome to Interleave
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-text-2">
          Your local-first reading workspace. Import what you read, distill it into extracts, turn
          the best ideas into cards, and review them with spaced repetition — all on your machine,
          nothing in the cloud.
        </p>
        <ol className="mx-auto mt-4 flex max-w-xs flex-col gap-1.5 text-left text-sm text-text-2">
          <li className="flex items-center gap-2">
            <Icon name="inbox" size={15} className="text-text-3" /> Import a source
          </li>
          <li className="flex items-center gap-2">
            <Icon name="extract" size={15} className="text-text-3" /> Read &amp; extract what
            matters
          </li>
          <li className="flex items-center gap-2">
            <Icon name="card" size={15} className="text-text-3" /> Make cards &amp; review them
          </li>
        </ol>
        <div className="mt-6 flex items-center justify-center gap-2">
          <button
            type="button"
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-text-on-accent hover:opacity-90"
            data-testid="onboarding-import"
            onClick={onImport}
          >
            Import your first source
          </button>
          <button
            type="button"
            className="rounded-md border border-border px-4 py-2 text-sm font-medium text-text-2 hover:bg-surface-2"
            data-testid="onboarding-dismiss"
            onClick={onDismiss}
          >
            Explore on my own
          </button>
        </div>
      </div>
    </div>
  );
}
