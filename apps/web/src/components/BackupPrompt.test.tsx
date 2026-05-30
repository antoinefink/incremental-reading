/**
 * BackupPrompt tests (T050).
 *
 * The backup itself runs MAIN-side (`appApi.createBackup`, T047); this asserts the
 * RENDERER seam only:
 *  - `shouldRemind` is the pure threshold rule (never backed up → remind; older
 *    than N days → remind; fresh → quiet);
 *  - the reminder banner shows only when due, and its "Create a backup now" button
 *    calls the SAME `appApi.createBackup()` command (no second path) and records a
 *    `ui.lastBackupAt` timestamp so the reminder resets and survives restart;
 *  - the banner stays hidden when a recent backup exists.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { BackupsCreateResult } from "../lib/appApi";
import {
  BACKUP_REMINDER_DAYS_KEY,
  BackupPrompt,
  LAST_BACKUP_AT_KEY,
  shouldRemind,
} from "./BackupPrompt";

const DAY = 24 * 60 * 60 * 1000;

describe("shouldRemind (pure threshold)", () => {
  const now = Date.parse("2026-05-30T12:00:00.000Z");

  it("reminds when never backed up", () => {
    expect(shouldRemind({ lastBackupAt: null, reminderDays: 7 }, now)).toBe(true);
  });

  it("reminds when the last backup is older than the threshold", () => {
    const old = new Date(now - 8 * DAY).toISOString();
    expect(shouldRemind({ lastBackupAt: old, reminderDays: 7 }, now)).toBe(true);
  });

  it("stays quiet when the last backup is within the threshold", () => {
    const fresh = new Date(now - 2 * DAY).toISOString();
    expect(shouldRemind({ lastBackupAt: fresh, reminderDays: 7 }, now)).toBe(false);
  });

  it("reminds on an unparseable timestamp (fail safe)", () => {
    expect(shouldRemind({ lastBackupAt: "not-a-date", reminderDays: 7 }, now)).toBe(true);
  });
});

const h = vi.hoisted(() => {
  const result: BackupsCreateResult = {
    path: "/vault/backups/2026-05-30/backup.zip",
    timestamp: "2026-05-30",
    sizeBytes: 1234,
    fileCount: 5,
    schemaVersion: "0002_search_fts5",
  };
  return {
    result,
    getSettings: vi.fn(),
    updateSetting: vi.fn(),
    createBackup: vi.fn(),
  };
});

vi.mock("../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../lib/appApi")>("../lib/appApi");
  return {
    ...actual,
    isDesktop: () => true,
    appApi: {
      getSettings: h.getSettings,
      updateSetting: h.updateSetting,
      createBackup: h.createBackup,
    },
  };
});

describe("BackupPrompt component", () => {
  it("shows the reminder when no backup exists and runs the shared backup command", async () => {
    h.getSettings.mockResolvedValue({ settings: {} });
    h.createBackup.mockResolvedValue(h.result);
    h.updateSetting.mockResolvedValue({ key: LAST_BACKUP_AT_KEY, value: "x" });

    render(<BackupPrompt />);

    const button = await screen.findByTestId("backup-now");
    fireEvent.click(button);

    await waitFor(() => expect(h.createBackup).toHaveBeenCalledTimes(1));
    // Records the timestamp in the settings table so the reminder resets + persists.
    await waitFor(() =>
      expect(h.updateSetting).toHaveBeenCalledWith(
        expect.objectContaining({ key: LAST_BACKUP_AT_KEY }),
      ),
    );
    // Confirms success.
    expect(await screen.findByTestId("backup-confirm")).toBeTruthy();
  });

  it("stays hidden when a recent backup exists", async () => {
    const fresh = new Date(Date.now() - 1 * DAY).toISOString();
    h.getSettings.mockResolvedValue({
      settings: { [LAST_BACKUP_AT_KEY]: fresh, [BACKUP_REMINDER_DAYS_KEY]: 7 },
    });

    const { container } = render(<BackupPrompt />);
    // Give the async read a tick; nothing should render.
    await waitFor(() => expect(h.getSettings).toHaveBeenCalled());
    expect(container.querySelector('[data-testid="backup-reminder"]')).toBeNull();
  });
});
