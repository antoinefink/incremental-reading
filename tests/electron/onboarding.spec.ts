/**
 * Onboarding + backup-prompt E2E (T050) — drives the real Electron app.
 *
 * The shipped MVP must be usable by a non-developer: a first-run welcome guides
 * the first import, and a gentle reminder + one-click affordance keeps the local
 * vault backed up. This spec proves both, against the BUILT desktop app, through
 * the UI + the typed `window.appApi` bridge only (no raw DB/FS access):
 *
 *   1. ONBOARDING — on a fresh, empty data dir (launched WITH onboarding enabled,
 *      unlike the other specs), the welcome overlay appears; dismissing it
 *      persists `ui.seenOnboarding=true` in the settings table; after an APP
 *      RESTART it does NOT reappear (the flag survived) — the honest "show once"
 *      contract.
 *   2. BACKUP PROMPT — with no backup ever taken, the reminder banner shows;
 *      clicking "Create a backup now" runs the SAME `appApi.createBackup()` the
 *      ⌘B shortcut / ⌘K command / File-menu use, writes a `ui.lastBackupAt`
 *      timestamp (so the reminder resets), and the banner disappears.
 *
 * Onboarding is the ONLY spec that opts into the welcome overlay; every other
 * feature spec suppresses it via the harness (see launch.ts), so they are never
 * covered by the first-run modal.
 */

import { expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

let dataDir: string;

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
});

/** Read a single setting through the bridge (no raw DB access). */
async function getSetting(page: Page, key: string): Promise<unknown> {
  return page.evaluate(async (k) => {
    const api = window.appApi as unknown as {
      settings: { get(req: { key: string }): Promise<{ settings: Record<string, unknown> }> };
    };
    const res = await api.settings.get({ key: k });
    return res.settings[k];
  }, key);
}

test("first-run onboarding shows once, persists the flag, and does not reappear after restart", async () => {
  // Launch WITH onboarding enabled (the dedicated first-run flow).
  let app = await launchApp(dataDir, { showOnboarding: true });
  let page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // The welcome overlay appears on the fresh, empty collection.
  await expect(page.getByTestId("onboarding")).toBeVisible();
  await expect(page.getByText("Welcome to Interleave")).toBeVisible();

  // Dismiss it → the flag is persisted in the settings table.
  await page.getByTestId("onboarding-dismiss").click();
  await expect(page.getByTestId("onboarding")).toBeHidden();
  await expect.poll(() => getSetting(page, "ui.seenOnboarding")).toBe(true);

  await app.close();

  // RESTART against the same data dir, again WITH onboarding enabled — it must
  // NOT reappear (the seen flag survived the restart).
  app = await launchApp(dataDir, { showOnboarding: true });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await expect(page.getByTestId("onboarding")).toBeHidden();
  expect(await getSetting(page, "ui.seenOnboarding")).toBe(true);

  await app.close();
});

test("the backup reminder shows when no backup exists and 'Create a backup now' runs the shared command", async () => {
  // A fresh data dir so no backup timestamp exists yet.
  const freshDir = makeDataDir();
  const app = await launchApp(freshDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // No backup ever → the reminder banner is shown.
  await expect(page.getByTestId("backup-reminder")).toBeVisible();
  expect(await getSetting(page, "ui.lastBackupAt")).toBeUndefined();

  // Click "Create a backup now" → runs the shared backup command + records a
  // timestamp; the reminder is replaced by the success confirmation.
  await page.getByTestId("backup-now").click();
  await expect(page.getByTestId("backup-confirm")).toBeVisible({ timeout: 15000 });

  // The timestamp persisted in the settings table (so the reminder resets).
  await expect.poll(() => getSetting(page, "ui.lastBackupAt")).toEqual(expect.any(String));

  await app.close();
});
