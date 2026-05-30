/**
 * BackupPrompt (T050) — the "create a backup" affordance + gentle reminder.
 *
 * The shipped MVP must let a non-developer keep their local vault safe without
 * touching the filesystem. This component surfaces two things, shell-wide:
 *
 *   1. a **"Create a backup now"** action — calls the SAME typed
 *      `appApi.createBackup()` command (T047) the command-palette / native-menu
 *      "Back up…" entries call (no second path); on success it records the
 *      timestamp in the `settings` table (`ui.lastBackupAt`) so the reminder
 *      threshold can be computed and so the choice survives an app restart;
 *   2. a calm **"no backup in N days" reminder** banner — shown only when the
 *      last recorded backup is older than the `ui.backupReminderDays` threshold
 *      (default 7), or when no backup has ever been taken.
 *
 * Architecture (non-negotiable): UI ONLY. It reads/writes the generic key/value
 * settings surface (`appApi.getSettings` / `updateSetting`) and triggers the
 * backup through `window.appApi` — it never touches the filesystem or SQLite. The
 * backup itself (the `backups/<ts>/` bundle + `.zip`) is produced entirely in the
 * Electron main process. Renders `null` outside the desktop shell.
 *
 * Visual: rebuilt from the kit's `Banner` (the same `.banner` family
 * `BalanceBanner` uses) so the two advisory banners read consistently.
 */

import { useCallback, useEffect, useState } from "react";
import { appApi, type BackupsCreateResult, isDesktop } from "../lib/appApi";
import { Icon } from "./Icon";

/** Settings keys for the backup reminder (generic key/value store; T011 typed set untouched). */
export const LAST_BACKUP_AT_KEY = "ui.lastBackupAt";
export const BACKUP_REMINDER_DAYS_KEY = "ui.backupReminderDays";

/** Default reminder threshold when the user has not configured one. */
const DEFAULT_REMINDER_DAYS = 7;

/** A successful backup broadcasts this so other surfaces can re-read freshness. */
export const BACKUP_DONE_EVENT = "interleave:backup-done";

/** ms in a day. */
const DAY_MS = 24 * 60 * 60 * 1000;

interface BackupState {
  /** ISO-8601 of the last recorded backup, or null if never. */
  readonly lastBackupAt: string | null;
  /** The reminder threshold in days. */
  readonly reminderDays: number;
}

/** Read the backup freshness state from the generic settings store. */
async function readBackupState(): Promise<BackupState> {
  const { settings } = await appApi.getSettings();
  const last = settings[LAST_BACKUP_AT_KEY];
  const days = settings[BACKUP_REMINDER_DAYS_KEY];
  return {
    lastBackupAt: typeof last === "string" ? last : null,
    reminderDays: typeof days === "number" && days > 0 ? days : DEFAULT_REMINDER_DAYS,
  };
}

/** Whether the reminder banner should show given the freshness state + now. */
export function shouldRemind(state: BackupState, now: number): boolean {
  if (state.lastBackupAt === null) return true;
  const last = Date.parse(state.lastBackupAt);
  if (Number.isNaN(last)) return true;
  return now - last >= state.reminderDays * DAY_MS;
}

/**
 * Run a backup through the shared typed command, then record the timestamp so the
 * reminder resets and persists across restart. Exposed so the command palette /
 * native menu can trigger the EXACT same flow as the banner button. Broadcasts
 * `BACKUP_DONE_EVENT` so any mounted banner re-reads freshness.
 */
export async function runBackup(): Promise<BackupsCreateResult> {
  const result = await appApi.createBackup();
  await appApi.updateSetting({ key: LAST_BACKUP_AT_KEY, value: new Date().toISOString() });
  window.dispatchEvent(new CustomEvent(BACKUP_DONE_EVENT));
  return result;
}

export function BackupPrompt() {
  const [state, setState] = useState<BackupState | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<BackupsCreateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  const load = useCallback(async () => {
    if (!isDesktop()) return;
    try {
      setState(await readBackupState());
    } catch {
      // Advisory only — a read failure simply hides the reminder.
      setState(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Re-read freshness whenever a backup completes (from here OR the palette/menu).
  useEffect(() => {
    const handler = () => void load();
    window.addEventListener(BACKUP_DONE_EVENT, handler);
    return () => window.removeEventListener(BACKUP_DONE_EVENT, handler);
  }, [load]);

  const onBackup = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await runBackup();
      setDone(result);
      setDismissed(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Backup failed");
    } finally {
      setBusy(false);
    }
  }, []);

  if (!isDesktop()) return null;

  // A freshly completed backup shows a brief calm confirmation.
  if (done) {
    return (
      <div
        className="flex items-start gap-3 rounded-md border border-ok bg-ok-soft px-4 py-3 text-sm text-text"
        data-testid="backup-confirm"
        role="status"
      >
        <span className="mt-0.5 flex-none text-ok">
          <Icon name="checkCircle" size={18} />
        </span>
        <div className="flex-1">
          <div className="font-semibold">Backup created</div>
          <div className="text-text-2">
            {done.fileCount} files · saved to your local backups folder.
          </div>
        </div>
        <button
          type="button"
          className="flex-none rounded px-2 py-1 text-text-3 hover:text-text"
          onClick={() => setDone(null)}
          aria-label="Dismiss"
        >
          <Icon name="x" size={15} />
        </button>
      </div>
    );
  }

  if (error) {
    return (
      <div
        className="flex items-start gap-3 rounded-md border border-danger bg-danger-soft px-4 py-3 text-sm text-text"
        data-testid="backup-error"
        role="alert"
      >
        <span className="mt-0.5 flex-none text-danger">
          <Icon name="warning" size={18} />
        </span>
        <div className="flex-1">
          <div className="font-semibold">Backup failed</div>
          <div className="text-text-2">{error}</div>
        </div>
        <button
          type="button"
          className="flex-none rounded border border-border px-2.5 py-1 font-medium hover:bg-surface-2"
          onClick={() => void onBackup()}
          disabled={busy}
        >
          Retry
        </button>
      </div>
    );
  }

  // Reminder is hidden until we know freshness, when not due, or once dismissed.
  if (dismissed || state === null || !shouldRemind(state, Date.now())) return null;

  const never = state.lastBackupAt === null;
  const message = never
    ? "You haven't backed up your vault yet."
    : `It's been over ${state.reminderDays} days since your last backup.`;

  return (
    <div
      className="flex items-start gap-3 rounded-md border border-warn bg-warn-soft px-4 py-3 text-sm text-text"
      data-testid="backup-reminder"
      role="status"
    >
      <span className="mt-0.5 flex-none text-warn">
        <Icon name="shield" size={18} />
      </span>
      <div className="flex-1">
        <div className="font-semibold">Keep your knowledge safe</div>
        <div className="text-text-2">{message} A backup captures your database and assets.</div>
      </div>
      <div className="flex flex-none items-center gap-2">
        <button
          type="button"
          className="rounded border border-border bg-surface px-2.5 py-1 font-medium hover:bg-surface-2 disabled:opacity-60"
          data-testid="backup-now"
          onClick={() => void onBackup()}
          disabled={busy}
        >
          <span className="inline-flex items-center gap-1.5">
            <Icon name="download" size={14} />
            {busy ? "Backing up…" : "Create a backup now"}
          </span>
        </button>
        <button
          type="button"
          className="rounded px-2 py-1 text-text-3 hover:text-text"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss reminder"
        >
          <Icon name="x" size={15} />
        </button>
      </div>
    </div>
  );
}
