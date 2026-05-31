/**
 * Shell sidebar identity + streak hook.
 *
 * Wires the user chip and the streak indicator to REAL `window.appApi` data:
 *  - the owner identity from the persisted `displayName` setting
 *    (`settings.getAll()`), derived into a name + avatar initials via the pure
 *    `resolveVaultIdentity` helper;
 *  - the day streak + 30-day retention from the analytics snapshot
 *    (`analytics.get()` → `dayStreak` / `retention30d`).
 *
 * Both refresh on mount, whenever a setting changes (`SETTINGS_CHANGED_EVENT` —
 * e.g. the name is edited in `/settings`), and whenever a command-level undo
 * fires (`UNDO_EVENT`), since undoing a review/import changes the streak. Outside
 * the desktop shell (browser / Vite-only) there is no SQLite, so the hook degrades
 * to the neutral local-vault identity and a hidden streak — it never invents data.
 * No domain logic lives here: the streak/retention are computed main-side; this
 * only awaits the typed IPC promises and feeds the pure derivation helper.
 */

import { useEffect, useState } from "react";
import { appApi, isDesktop } from "../lib/appApi";
import { resolveVaultIdentity, type VaultIdentity } from "./identity";
import { SETTINGS_CHANGED_EVENT, UNDO_EVENT } from "./nav";

/** The streak/retention summary the sidebar shows, or `null` when unavailable. */
export interface StreakSummary {
  /** Consecutive-day review streak (`>= 0`). */
  readonly dayStreak: number;
  /** 30-day retention as a percentage `0`–`100`, or `null` when no reviews yet. */
  readonly retentionPct: number | null;
}

/** The resolved shell identity + streak the sidebar renders. */
export interface ShellIdentity {
  readonly identity: VaultIdentity;
  /** `null` until loaded / outside desktop — the streak chip hides when null. */
  readonly streak: StreakSummary | null;
}

/**
 * Load the local-vault identity + the streak/retention, refreshing on mount and
 * on `UNDO_EVENT`. Degrades to the neutral identity + a hidden streak outside
 * the desktop shell.
 */
export function useShellIdentity(): ShellIdentity {
  const [displayName, setDisplayName] = useState<string>("");
  const [streak, setStreak] = useState<StreakSummary | null>(null);

  useEffect(() => {
    if (!isDesktop()) return;
    let cancelled = false;

    const refresh = () => {
      void appApi
        .getAppSettings()
        .then(({ settings }) => {
          if (!cancelled) setDisplayName(settings.displayName);
        })
        .catch(() => {});
      void appApi
        .getAnalytics()
        .then((a) => {
          if (cancelled) return;
          setStreak({
            dayStreak: a.dayStreak,
            retentionPct: a.retention30d === null ? null : Math.round(a.retention30d * 100),
          });
        })
        .catch(() => {});
    };

    refresh();
    window.addEventListener(UNDO_EVENT, refresh);
    window.addEventListener(SETTINGS_CHANGED_EVENT, refresh);
    return () => {
      cancelled = true;
      window.removeEventListener(UNDO_EVENT, refresh);
      window.removeEventListener(SETTINGS_CHANGED_EVENT, refresh);
    };
  }, []);

  return { identity: resolveVaultIdentity(displayName), streak };
}
