/**
 * Import & Inbox E2E (T012) — drives the real Electron app.
 *
 * Launches the built desktop app against a fresh data dir and exercises the first
 * MUTATION surface on the bridge end to end:
 *
 *   1. the renderer reaches everything THROUGH `window.appApi` (the
 *      `sources.importManual` + `inbox.list/get/triage` commands exist; there is
 *      no generic `db.query`);
 *   2. creating a manual source lands it in the `/inbox` list, where it can be
 *      previewed, reprioritized (A/B/C/D), accepted into active learning, kept for
 *      later, or deleted — all via the typed bridge;
 *   3. after an APP RESTART against the same data dir, the accepted source is gone
 *      from the inbox but still exists (now `active`), and the deleted one is
 *      absent — proving the soft-delete + status changes persisted to SQLite.
 *
 * No seed: the inbox starts empty (Inbox zero), and the test imports its own
 * sources, so it proves the real create → triage → persist loop.
 */

import { expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

let dataDir: string;

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
});

/** Read the current inbox list through the bridge. */
async function listInbox(page: Page) {
  return page.evaluate(async () => {
    const api = window.appApi as unknown as {
      inbox: {
        list(): Promise<{ items: { id: string; title: string; priority: number }[] }>;
      };
    };
    const res = await api.inbox.list();
    return res.items;
  });
}

test("the inbox reaches sources.importManual + inbox.list/get/triage, not raw SQL", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const surface = await page.evaluate(() => {
    const api = window.appApi as unknown as {
      sources?: { importManual?: unknown };
      inbox?: { list?: unknown; get?: unknown; triage?: unknown };
      db?: { query?: unknown };
    };
    return {
      hasImport: typeof api?.sources?.importManual === "function",
      hasList: typeof api?.inbox?.list === "function",
      hasGet: typeof api?.inbox?.get === "function",
      hasTriage: typeof api?.inbox?.triage === "function",
      hasQuery: typeof api?.db?.query === "function",
    };
  });
  expect(surface.hasImport).toBe(true);
  expect(surface.hasList).toBe(true);
  expect(surface.hasGet).toBe(true);
  expect(surface.hasTriage).toBe(true);
  expect(surface.hasQuery).toBe(false);

  await app.close();
});

test("create → list → prioritize → accept → delete works through the UI + bridge", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // Navigate to /inbox via the sidebar (the real router path).
  await page.getByTestId("nav-inbox").click();
  await expect(page.getByTestId("route-inbox")).toBeVisible();
  await expect(page.getByTestId("inbox-empty")).toBeVisible();

  // Create the first source through the New-source modal.
  await page.getByTestId("inbox-empty-new").click();
  await expect(page.getByTestId("new-source-modal")).toBeVisible();
  await page.getByTestId("new-source-title").fill("Article to accept");
  await page.getByTestId("new-source-submit").click();
  await expect(page.getByTestId("new-source-modal")).toBeHidden();

  // It lands in the list + preview.
  await expect(page.getByTestId("inbox-row")).toHaveCount(1);
  await expect(page.getByTestId("inbox-preview-title")).toHaveText("Article to accept");

  // Reprioritize to A through the rail; the chip reflects the change.
  await page.getByTestId("inbox-priority-A").click();
  await expect(page.getByTestId("inbox-priority-A")).toHaveAttribute("aria-pressed", "true");

  // Create a second source via the import strip ("Manual note").
  await page.getByTestId("inbox-import-manual").click();
  await expect(page.getByTestId("new-source-modal")).toBeVisible();
  await page.getByTestId("new-source-title").fill("Article to delete");
  await page.getByTestId("new-source-submit").click();
  await expect(page.getByTestId("new-source-modal")).toBeHidden();
  await expect(page.getByTestId("inbox-row")).toHaveCount(2);

  // Accept the "to accept" one (status → active; leaves the inbox).
  await page.getByTestId("inbox-row").filter({ hasText: "Article to accept" }).click();
  await expect(page.getByTestId("inbox-preview-title")).toHaveText("Article to accept");
  await page.getByTestId("inbox-accept").click();
  await expect(page.getByTestId("inbox-row")).toHaveCount(1);

  // Delete the remaining "to delete" one (soft-delete; leaves the inbox).
  await page.getByTestId("inbox-row").filter({ hasText: "Article to delete" }).click();
  await page.getByTestId("inbox-delete").click();
  await expect(page.getByTestId("inbox-empty")).toBeVisible();

  // The list, read straight through the bridge, is empty.
  const items = await listInbox(page);
  expect(items).toHaveLength(0);

  await app.close();
});

test("accepted source survives restart as active; deleted one stays gone", async () => {
  // Relaunch a brand-new Electron process against the SAME data dir.
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // The inbox is empty after restart (both items left the inbox).
  const items = await listInbox(page);
  expect(items.map((i) => i.title)).not.toContain("Article to accept");
  expect(items.map((i) => i.title)).not.toContain("Article to delete");

  // The accepted source still EXISTS as an `active` element; the deleted one is
  // soft-deleted (status `deleted`). Read both through the inspector list bridge.
  const summary = await page.evaluate(async () => {
    const api = window.appApi as unknown as {
      inspector: {
        list(): Promise<{ elements: { title: string; status: string; type: string }[] }>;
      };
    };
    const res = await api.inspector.list();
    return res.elements
      .filter((e) => e.type === "source")
      .map((e) => ({ title: e.title, status: e.status }));
  });
  const accepted = summary.find((e) => e.title === "Article to accept");
  expect(accepted?.status).toBe("active");
  // The deleted source is soft-deleted, so it is excluded from the live inspector
  // list entirely.
  expect(summary.find((e) => e.title === "Article to delete")).toBeUndefined();

  await app.close();
});
