/**
 * Desktop status panel (T007).
 *
 * A small, real consumer of the typed `window.appApi` bridge, rendered on the
 * Settings route. It proves the renderer reaches trusted local capabilities only
 * through the bridge (never SQLite/Node/fs directly):
 *   - `app.health()` and `db.getStatus()` report the shell + SQLite are up and
 *     migrated,
 *   - a setting can be written and read back, and (per the Definition of Done)
 *     survives a full app restart — the E2E relaunches Electron and re-reads it.
 *
 * Pure UI: it only awaits IPC-backed promises from the typed client; no domain
 * logic lives here. Outside Electron (browser/Vite-only) it shows a clear
 * "desktop only" state instead of throwing.
 */

import { useCallback, useEffect, useState } from "react";
import {
  appApi,
  type DbStatus,
  type HealthResult,
  isDesktop,
  type SettingValue,
} from "../lib/appApi";

/** The settings key the panel reads/writes to demonstrate persistence. */
const PERSIST_KEY = "desktop.lastCheck";

export function DesktopStatusPanel() {
  const desktop = isDesktop();
  const [health, setHealth] = useState<HealthResult | null>(null);
  const [status, setStatus] = useState<DbStatus | null>(null);
  const [persisted, setPersisted] = useState<SettingValue | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!isDesktop()) return;
    try {
      const [h, s, g] = await Promise.all([
        appApi.health(),
        appApi.dbStatus(),
        appApi.getSettings({ key: PERSIST_KEY }),
      ]);
      setHealth(h);
      setStatus(s);
      setPersisted(g.settings[PERSIST_KEY]);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const writeSetting = useCallback(async () => {
    try {
      const value = `checked-${new Date().toISOString()}`;
      await appApi.updateSetting({ key: PERSIST_KEY, value });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [refresh]);

  if (!desktop) {
    return (
      <section
        data-testid="desktop-status"
        data-desktop="false"
        className="mx-auto mt-6 w-full max-w-md rounded-lg border border-border bg-surface-2 p-4 text-left"
      >
        <h2 className="text-sm font-semibold text-text">Desktop shell</h2>
        <p className="mt-1 text-sm text-text-2">
          Running in a browser — the native <code>window.appApi</code> bridge is only present in the
          Electron desktop app.
        </p>
      </section>
    );
  }

  return (
    <section
      data-testid="desktop-status"
      data-desktop="true"
      className="mx-auto mt-6 w-full max-w-md rounded-lg border border-border bg-surface-2 p-4 text-left"
    >
      <h2 className="text-sm font-semibold text-text">Desktop shell &amp; local database</h2>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
        <dt className="text-text-2">Health</dt>
        <dd data-testid="health-status" className="text-text">
          {health?.status ?? "…"}
        </dd>

        <dt className="text-text-2">DB open</dt>
        <dd data-testid="db-open" className="text-text">
          {status ? String(status.open) : "…"}
        </dd>

        <dt className="text-text-2">Migrated</dt>
        <dd data-testid="db-migrated" className="text-text">
          {status ? String(status.migrated) : "…"}
        </dd>

        <dt className="text-text-2">Journal mode</dt>
        <dd data-testid="db-journal-mode" className="text-text">
          {status?.journalMode ?? "…"}
        </dd>

        <dt className="text-text-2">Foreign keys</dt>
        <dd data-testid="db-foreign-keys" className="text-text">
          {status ? String(status.foreignKeys) : "…"}
        </dd>

        <dt className="text-text-2">Busy timeout</dt>
        <dd data-testid="db-busy-timeout" className="text-text">
          {status ? `${status.busyTimeoutMs}ms` : "…"}
        </dd>

        <dt className="text-text-2">Migrations</dt>
        <dd data-testid="db-applied-migrations" className="text-text">
          {status ? String(status.appliedMigrations) : "…"}
        </dd>
      </dl>

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          data-testid="persist-button"
          onClick={() => void writeSetting()}
          className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm font-medium text-text hover:bg-raised"
        >
          Write persisted check
        </button>
        <span data-testid="persisted-value" className="truncate text-sm text-text-2">
          {persisted === undefined ? "(unset)" : String(persisted)}
        </span>
      </div>

      {error ? (
        <p data-testid="desktop-status-error" className="mt-3 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </section>
  );
}
