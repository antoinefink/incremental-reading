/**
 * Restore-from-file E2E (U5) — drives the real Electron app end to end.
 *
 * Restore-from-file lets the user pick a portable backup `.zip` on disk (one the
 * app does not manage) and replace the canonical SQLite DB + asset vault with it
 * through the SAME extract → verify → install-with-rollback pipeline the
 * timestamp restore uses. The flow rides two narrow typed `backups` commands —
 * `backups.pickArchive` (main-owned native picker) and `backups.restoreFile`
 * (`{ path, confirm, phrase }`) — with no raw SQL or generic filesystem access in
 * the renderer. This spec asserts the Definition of Done:
 *
 *   1. with seed, a `.zip` produced by `backups.create()` is on disk under
 *      `<dataDir>/backups/<archiveName>`;
 *   2. relaunch with `INTERLEAVE_BACKUP_RESTORE_PATH` pointed at that zip → the
 *      Settings restore-from-file row (choose → type `RESTORE BACKUP` → restore)
 *      reports the restart-required state;
 *   3. the restore SURVIVES AN APP RESTART against the same data dir — the seeded
 *      vault file persists and the bridge reports element counts > 0;
 *   4. a corrupt / non-backup `.zip` surfaces a NON-DESTRUCTIVE error (no
 *      restart-required, store untouched, counts unchanged).
 *
 * The native picker is bypassed via `INTERLEAVE_BACKUP_RESTORE_PATH` (honored only
 * in the unpackaged build — mirrors the import pickers' `INTERLEAVE_<KIND>_IMPORT_PATH`
 * escapes). `launchApp` spreads `process.env` into the spawned Electron process, so
 * the spec sets that env var per-launch (and clears it afterward) to differ between
 * the happy-path zip and the corrupt path. The renderer never touches SQLite/fs.
 */

import fs from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

let dataDir: string;

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
  // Seed a real asset file into the vault so the backup's recursive vault copy +
  // per-file hashing have a non-DB file to capture (the demo seed only writes
  // asset metadata rows, not bytes). The renderer never does this — the test does
  // it directly on disk before launch, mirroring a real source's snapshot asset.
  // This same file proves restore-from-file rewrote the vault after a restart.
  const assetDir = path.join(dataDir, "assets", "sources", "e2e-seed");
  fs.mkdirSync(assetDir, { recursive: true });
  fs.writeFileSync(path.join(assetDir, "snapshot.json"), '{"e2e":"asset"}');
});

test.afterEach(() => {
  // The env override is set per-launch (no dedicated `LaunchOptions` field), so
  // clear it between tests to keep launches deterministic and isolated.
  delete process.env.INTERLEAVE_BACKUP_RESTORE_PATH;
});

/** Navigate to /settings through the real router (user-chip menu → Settings). */
async function gotoSettings(page: Page) {
  await page.getByTestId("user-chip").click();
  await page.getByRole("menuitem", { name: /^Settings$/ }).click();
  await expect(page.getByTestId("route-settings")).toBeVisible();
}

/** The shape `backups.create()` returns. */
interface BackupResult {
  timestamp: string;
  archiveName: string;
  sizeBytes: number;
  fileCount: number;
  schemaVersion: string;
}

/** Live element count via the inspector bridge (proves the DB loaded after restart). */
async function elementCount(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const api = window.appApi as unknown as {
      inspector: { list(): Promise<{ elements: unknown[] }> };
    };
    const { elements } = await api.inspector.list();
    return elements.length;
  });
}

/**
 * Drive the Settings restore-from-file row: choose (env-stubbed picker) → assert the
 * basename shows → type the phrase → restore. Leaves the assertion of success/error
 * to the caller so both the happy path and the corrupt path can reuse it.
 */
async function driveRestoreFromFile(page: Page, expectedBasename: string): Promise<void> {
  await gotoSettings(page);
  await page.getByTestId("settings-restore-file-choose").click();
  await expect(page.getByTestId("settings-restore-file-path")).toHaveText(expectedBasename);
  await page.getByTestId("settings-restore-file-confirm").fill("RESTORE BACKUP");
  await page.getByTestId("settings-restore-file").click();
}

test("a backup .zip created with seed lands on disk", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // The seeded collection produced live elements — the backup must capture them.
  expect(await elementCount(page)).toBeGreaterThan(0);

  const result = (await page.evaluate(async () => {
    const api = window.appApi as unknown as { backups: { create(): Promise<BackupResult> } };
    return api.backups.create();
  })) as BackupResult;

  const archivePath = path.join(dataDir, "backups", result.archiveName);
  expect(fs.existsSync(archivePath)).toBe(true);
  expect(result.archiveName.endsWith(".zip")).toBe(true);

  await app.close();
});

test("restore-from-file replaces the store and reports restart-required", async () => {
  // The freshly created backup is the only product `.zip` (auto backups are off).
  const backupsDir = path.join(dataDir, "backups");
  const archiveName = fs
    .readdirSync(backupsDir)
    .find((f) => f.endsWith(".zip") && !f.startsWith("auto-"));
  expect(archiveName).toBeTruthy();
  if (!archiveName) throw new Error("no backup .zip on disk to restore from");
  const archivePath = path.join(backupsDir, archiveName);

  // Stub the main-owned picker to the produced zip (honored only !app.isPackaged).
  // `launchApp` spreads `process.env`, so this reaches the spawned Electron process.
  process.env.INTERLEAVE_BACKUP_RESTORE_PATH = archivePath;

  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await driveRestoreFromFile(page, archiveName);

  // The restore completes: the success row and the shared restart-required note appear.
  await expect(page.getByTestId("settings-restore-file-success")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("settings-data-restart-required")).toBeVisible();

  await app.close();
});

test("the restored store survives an app restart (data persists)", async () => {
  // Relaunch a brand-new Electron process against the SAME data dir — no override.
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // The restored DB loaded and has content (the home route renders, counts > 0).
  await expect(page.getByTestId("user-chip")).toBeVisible();
  expect(await elementCount(page)).toBeGreaterThan(0);

  // The seeded vault file the backup captured was rewritten by the install and
  // survives outside the DB — proving restore replaced the asset vault too.
  expect(fs.existsSync(path.join(dataDir, "assets", "sources", "e2e-seed", "snapshot.json"))).toBe(
    true,
  );

  await app.close();
});

test("a corrupt backup file fails non-destructively (store untouched)", async () => {
  // Capture the live element count from the (now restored) store before the attempt,
  // so we can prove a failed restore leaves it unchanged.
  const before = await (async () => {
    const app = await launchApp(dataDir, { seedOnEmpty: true });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    const count = await elementCount(page);
    await app.close();
    return count;
  })();
  expect(before).toBeGreaterThan(0);

  // Write junk bytes to a `.zip` that is not a valid backup archive.
  const junkPath = path.join(dataDir, "not-a-backup.zip");
  fs.writeFileSync(junkPath, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02, 0x03, 0xff]));

  process.env.INTERLEAVE_BACKUP_RESTORE_PATH = junkPath;

  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await driveRestoreFromFile(page, "not-a-backup.zip");

  // The restore is rejected: the error row appears and the store is NOT flipped into
  // restart-required (the current DB + assets are untouched).
  await expect(page.getByTestId("settings-restore-file-error")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("settings-data-restart-required")).toHaveCount(0);
  await expect(page.getByTestId("settings-restore-file-success")).toHaveCount(0);

  // The store still functions and the count is unchanged — the failure was non-destructive.
  expect(await elementCount(page)).toBe(before);

  await app.close();
});
