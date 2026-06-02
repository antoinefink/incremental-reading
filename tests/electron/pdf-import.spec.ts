/**
 * PDF import E2E (T064) — drives the real Electron app end to end, fully on-device.
 *
 * The native file picker is stubbed via `INTERLEAVE_PDF_IMPORT_PATH` (honored only
 * in the unpackaged build — mirrors the `INTERLEAVE_ALLOW_LOOPBACK_IMPORT` escape),
 * pointed at the committed 2-page text fixture PDF. The spec proves:
 *
 *   1. clicking the inbox "Import PDF" chip → MAIN reads + validates + streams the
 *      original into the vault + parses per-page text + creates an `inbox` source;
 *   2. the source opens in the PDF reading mode (a page canvas renders, the text
 *      layer is selectable), tracks a PAGE read-point, and shows page N of M;
 *   3. setting a read-point on page 2 + extracting page-2 text creates an extract
 *      linked to page 2 (its source-location label reads "Page 2 · …");
 *   4. after an APP RESTART against the same data dir, the source, its body, its
 *      `original.pdf`, the page-2 read-point, and the page-linked extract survive.
 *
 * The renderer reaches all of this only through `window.appApi` — no fs/SQL.
 */

import fs from "node:fs";
import path from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

const FIXTURE = path.resolve(
  __dirname,
  "..",
  "..",
  "packages",
  "importers",
  "src",
  "__fixtures__",
  "two-page-text.pdf",
);

let dataDir: string;
let baseUrl: string;

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
});

/** Launch the app with the PDF picker stubbed to the fixture. */
async function launch(): Promise<ElectronApplication> {
  return launchApp(dataDir, { pdfImportPath: FIXTURE });
}

/** The renderer base URL (`app://…`) captured from the first window. */
async function captureBaseUrl(page: Page): Promise<void> {
  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;
}

/** Read the one inbox source id via the bridge. */
async function firstInboxId(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const api = window.appApi as unknown as {
      inbox: { list(): Promise<{ items: { id: string }[] }> };
    };
    const { items } = await api.inbox.list();
    return items[0]?.id as string;
  });
}

test("the bridge exposes sources.importPdf + getPdfData (not raw SQL)", async () => {
  const app = await launch();
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const surface = await page.evaluate(() => {
    const api = window.appApi as unknown as {
      sources?: { importPdf?: unknown; getPdfData?: unknown };
      db?: { query?: unknown };
    };
    return {
      hasImportPdf: typeof api?.sources?.importPdf === "function",
      hasGetPdfData: typeof api?.sources?.getPdfData === "function",
      hasQuery: typeof api?.db?.query === "function",
    };
  });
  expect(surface.hasImportPdf).toBe(true);
  expect(surface.hasGetPdfData).toBe(true);
  expect(surface.hasQuery).toBe(false);
  await app.close();
});

test("importing a PDF lands a paginated inbox source the reader renders", async () => {
  const app = await launch();
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await captureBaseUrl(page);

  await page.getByTestId("nav-inbox").click();
  await expect(page.getByTestId("route-inbox")).toBeVisible();
  await expect(page.getByTestId("inbox-empty")).toBeVisible();

  // Click the "Import PDF" chip — MAIN stubs the picker to the fixture path.
  await page.getByTestId("inbox-import-import-pdf").click();

  // The cleaned PDF source lands in the inbox list.
  await expect(page.getByTestId("inbox-row")).toHaveCount(1, { timeout: 20_000 });

  // The original.pdf is in the vault.
  const id = await firstInboxId(page);
  const pdfPath = path.join(dataDir, "assets", "sources", id, "original.pdf");
  expect(fs.existsSync(pdfPath)).toBe(true);

  // Open the source reader — the PDF reading mode renders a page canvas.
  await page.goto(`${baseUrl}/source/${id}`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("pdf-reader")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("pdf-page-1")).toBeVisible();
  // The page indicator shows page N of M (2 pages).
  await expect(page.getByTestId("pdf-page-indicator")).toContainText("of 2");

  await app.close();
});

test("setting a page-2 read-point + extracting page text links the extract to page 2", async () => {
  const app = await launch();
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await captureBaseUrl(page);

  const id = await firstInboxId(page);
  await page.goto(`${baseUrl}/source/${id}`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("pdf-reader")).toBeVisible({ timeout: 20_000 });
  // Both pages render eagerly within the render window; wait for page 2's text
  // layer to be populated (its selectable spans).
  await expect(page.getByTestId("pdf-page-2")).toBeVisible();
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-pdf-page="2"] .textLayer');
    return !!el && (el.textContent?.trim().length ?? 0) > 0;
  });

  // Select a text span ON PAGE 2 (the read-point + extract both resolve their page
  // from the selection's DOM ancestor, so this is deterministic regardless of which
  // page is scrolled into view).
  const selectPage2 = async () =>
    page.evaluate(() => {
      const layer = document.querySelector('[data-pdf-page="2"] .textLayer');
      const span = layer?.querySelector("span");
      if (!span) throw new Error("page 2 text span not found");
      const range = document.createRange();
      range.selectNodeContents(span);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    });

  // Set a page-2 read-point (the selection's page wins) — persisted via readPoints.set.
  await selectPage2();
  await page.getByTestId("pdf-set-readpoint").click();
  await expect(page.getByTestId("reader-flash")).toContainText("page 2");

  // Extract the page-2 selection → an extract linked to page 2.
  await selectPage2();
  await page.getByTestId("pdf-extract").click();
  await expect(page.getByTestId("reader-flash")).toContainText("page 2");

  // Through the bridge: the new extract's source location carries page 2 + a
  // "Page 2 · …" label.
  const loc = await page.evaluate(async (sourceId) => {
    const api = window.appApi as unknown as {
      inspector: {
        list(): Promise<{ elements: { id: string; type: string }[] }>;
        get(req: { id: string }): Promise<{
          data: {
            location: { page: number | null; label: string | null } | null;
            source: { id: string } | null;
          } | null;
        }>;
      };
    };
    const { elements } = await api.inspector.list();
    for (const el of elements) {
      if (el.type !== "extract") continue;
      const { data } = await api.inspector.get({ id: el.id });
      if (data?.source?.id === sourceId && data.location?.page === 2) {
        return data.location;
      }
    }
    return null;
  }, id);
  expect(loc).not.toBeNull();
  expect(loc?.page).toBe(2);
  expect(loc?.label ?? "").toContain("Page 2");

  await app.close();
});

test("the PDF source, read-point, and page-linked extract survive an app restart", async () => {
  const app = await launch();
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await captureBaseUrl(page);

  // Still ONE inbox source after restart, with its PDF on disk.
  await page.getByTestId("nav-inbox").click();
  await expect(page.getByTestId("route-inbox")).toBeVisible();
  await expect(page.getByTestId("inbox-row")).toHaveCount(1);
  const id = await firstInboxId(page);
  expect(fs.existsSync(path.join(dataDir, "assets", "sources", id, "original.pdf"))).toBe(true);

  // The read-point + the page-2 extract persisted.
  const state = await page.evaluate(async (sourceId) => {
    const api = window.appApi as unknown as {
      readPoints: {
        get(req: { elementId: string }): Promise<{ readPoint: { blockId: string } | null }>;
      };
      inspector: {
        list(): Promise<{ elements: { id: string; type: string }[] }>;
        get(req: { id: string }): Promise<{
          data: {
            location: { page: number | null } | null;
            source: { id: string } | null;
          } | null;
        }>;
      };
    };
    const { readPoint } = await api.readPoints.get({ elementId: sourceId });
    const { elements } = await api.inspector.list();
    let pageTwoExtract = false;
    for (const el of elements) {
      if (el.type !== "extract") continue;
      const { data } = await api.inspector.get({ id: el.id });
      if (data?.source?.id === sourceId && data.location?.page === 2) pageTwoExtract = true;
    }
    return { hasReadPoint: !!readPoint, pageTwoExtract };
  }, id);
  expect(state.hasReadPoint).toBe(true);
  expect(state.pageTwoExtract).toBe(true);

  // The reader still renders the PDF after restart.
  await page.goto(`${baseUrl}/source/${id}`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("pdf-reader")).toBeVisible({ timeout: 20_000 });

  await app.close();
});
