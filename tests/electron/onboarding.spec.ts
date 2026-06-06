/**
 * Onboarding E2E (T050) — drives the real Electron app.
 *
 * The shipped MVP must be usable by a non-developer: a first-run welcome guides
 * the first import. This spec proves the welcome flow against the BUILT desktop
 * app, through the UI + the typed `window.appApi` bridge only (no raw DB/FS access):
 *
 *   1. ONBOARDING — on a fresh, empty data dir (launched WITH onboarding enabled,
 *      unlike the other specs), the welcome overlay appears; dismissing it
 *      persists `ui.seenOnboarding=true` in the settings table; after an APP
 *      RESTART it does NOT reappear (the flag survived) — the honest "show once"
 *      contract.
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
  await expect(page.getByTestId("welcome-modal")).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Welcome to Interleave" })).toBeVisible();

  // Dismiss it → the flag is persisted in the settings table.
  await page.getByRole("button", { name: "Explore on my own" }).click();
  await expect(page.getByTestId("welcome-modal")).toBeHidden();
  await expect.poll(() => getSetting(page, "ui.seenOnboarding")).toBe(true);

  await app.close();

  // RESTART against the same data dir, again WITH onboarding enabled — it must
  // NOT reappear (the seen flag survived the restart).
  app = await launchApp(dataDir, { showOnboarding: true });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await expect(page.getByTestId("welcome-modal")).toBeHidden();
  expect(await getSetting(page, "ui.seenOnboarding")).toBe(true);

  await app.close();
});
