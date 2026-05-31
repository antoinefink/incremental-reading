/**
 * Library (Library route) E2E — drives the real Electron app.
 *
 * The dedicated `/library` route is the facet-driven "browse everything" surface,
 * DISTINCT from `/search` (keyword FTS5, returns [] for an empty query). It lists
 * ALL live elements by default and narrows by facets — reaching the renderer only
 * through the typed `library.browse` `window.appApi` command (no generic SQL).
 * This spec launches the built desktop app against a fresh data dir seeded with
 * the shared demo collection, then:
 *
 *   1. the `library.browse` bridge command exists (no raw SQL channel);
 *   2. opening `/library` lists the seeded elements WITHOUT typing a query (the
 *      browse distinction) — sources, extracts, and cards all render;
 *   3. toggling a facet (Type: card) narrows the list;
 *   4. selecting a row + opening it navigates per type;
 *   5. NAV-EXCLUSIVITY — on `/library` exactly one sidebar entry is current and
 *      it is `nav-library` (Search and Concepts are NOT), and `g`+`l` navigates here;
 *   6. it SURVIVES AN APP RESTART — the browse still lists the seeded elements
 *      (the MVP restart-persistence check).
 */

import { expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

let dataDir: string;
let baseUrl: string;

const SOURCE_TITLE = "On the Measure of Intelligence";

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
});

/** Open `/library` and wait for the browse screen to render. */
async function openLibrary(page: Page): Promise<void> {
  await page.goto(`${baseUrl}/library`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("route-library")).toBeVisible();
}

test("the library.browse bridge command exists (no raw SQL)", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;

  const surface = await page.evaluate(() => {
    const api = window.appApi as unknown as {
      library?: { browse?: unknown };
      db?: { query?: unknown };
    };
    return {
      hasBrowse: typeof api?.library?.browse === "function",
      hasRawQuery: typeof api?.db?.query === "function",
    };
  });
  expect(surface.hasBrowse).toBe(true);
  expect(surface.hasRawQuery).toBe(false);

  await app.close();
});

test("opening /library lists the seeded elements WITHOUT typing a query (the browse distinction)", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await openLibrary(page);

  // No keyword typed — the seeded source/extract/card groups appear immediately.
  await expect(page.getByTestId("library-group-source")).toBeVisible();
  await expect(page.getByTestId("library-group-extract")).toBeVisible();
  await expect(page.getByTestId("library-group-card")).toBeVisible();
  // The calm count summary shows a non-zero total.
  await expect(page.getByTestId("library-count")).toContainText("element");

  // Selecting the seeded source row shows its detail panel + refblock + the chip.
  const sourceRow = page.getByTestId("library-group-source").getByTestId("library-result").first();
  await sourceRow.click();
  const detail = page.getByTestId("library-detail");
  await expect(detail).toBeVisible();
  await expect(page.getByTestId("library-detail-ref")).toContainText(SOURCE_TITLE);
  // A source is on the attention scheduler (the load-bearing split).
  await expect(detail.getByTestId("scheduler-chip")).toHaveAttribute("data-scheduler", "attention");

  await app.close();
});

test("toggling a Type facet narrows the list to that type", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await openLibrary(page);

  // Narrow to cards only — the source/extract groups disappear.
  await page.getByTestId("library-filter-type-card").click();
  await expect(page.getByTestId("library-group-card")).toBeVisible();
  await expect(page.getByTestId("library-group-source")).toHaveCount(0);
  await expect(page.getByTestId("library-group-extract")).toHaveCount(0);

  // Opening the selected card row navigates to the review session.
  const cardRow = page.getByTestId("library-group-card").getByTestId("library-result").first();
  await cardRow.click();
  await page.getByTestId("library-detail-open").click();
  await expect(page).toHaveURL(/\/review$/);

  await app.close();
});

test("the library.browse bridge returns ALL live elements with no facets (incl. the inbox source)", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const res = await page.evaluate(async () => {
    const api = window.appApi as unknown as {
      library: {
        browse(r: { types?: string[] }): Promise<{
          items: { id: string; type: string; status: string }[];
          counts: { all: number; byStatus: Record<string, number> };
        }>;
      };
    };
    const all = await api.library.browse({});
    const cardsOnly = await api.library.browse({ types: ["card"] });
    return {
      types: [...new Set(all.items.map((r) => r.type))],
      all: all.counts.all,
      inbox: all.counts.byStatus.inbox ?? 0,
      cardsOnly: cardsOnly.items.every((r) => r.type === "card"),
      cardCount: cardsOnly.items.length,
    };
  });

  expect(res.all).toBeGreaterThan(0);
  expect(res.types).toContain("source");
  expect(res.types).toContain("extract");
  expect(res.types).toContain("card");
  // Browse surfaces the inbox source (status `inbox`) — search would never return it.
  expect(res.inbox).toBeGreaterThan(0);
  expect(res.cardsOnly).toBe(true);
  expect(res.cardCount).toBeGreaterThan(0);

  await app.close();
});

test("NAV-EXCLUSIVITY — on /library exactly one nav item is current, and it is nav-library", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await openLibrary(page);

  // Exactly one sidebar entry carries aria-current="page", and it is Library —
  // NOT Search or Concepts (the triple-highlight bug stays fixed for the new route).
  const activeNav = page.locator('.shell-nav [aria-current="page"]');
  await expect(activeNav).toHaveCount(1);
  await expect(page.getByTestId("nav-library")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("nav-library")).toHaveAttribute("data-status", "active");
  await expect(page.getByTestId("nav-search")).not.toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("nav-concepts")).not.toHaveAttribute("aria-current", "page");

  await app.close();
});

test("g+l navigates to /library and highlights Library exclusively", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  // Start somewhere else, then drive the keyboard goto chord.
  await page.goto(`${baseUrl}/queue`);
  await page.waitForLoadState("domcontentloaded");

  await page.keyboard.press("g");
  await page.keyboard.press("l");

  await expect(page.getByTestId("route-library")).toBeVisible();
  await expect(page.getByTestId("nav-library")).toHaveAttribute("aria-current", "page");
  await expect(page.locator('.shell-nav [aria-current="page"]')).toHaveCount(1);

  await app.close();
});

test("the library still lists the seeded elements after an app restart (browse persisted)", async () => {
  // Re-launch against the SAME data dir — the restart analogue.
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const res = await page.evaluate(async () => {
    const api = window.appApi as unknown as {
      library: {
        browse(r: Record<string, never>): Promise<{ items: { type: string }[] }>;
      };
    };
    const { items } = await api.library.browse({});
    return { count: items.length, types: [...new Set(items.map((r) => r.type))] };
  });

  expect(res.count).toBeGreaterThan(0);
  expect(res.types).toContain("source");
  expect(res.types).toContain("extract");
  expect(res.types).toContain("card");

  // And the UI still renders the browse list after restart.
  await openLibrary(page);
  await expect(page.getByTestId("library-group-source")).toBeVisible();

  await app.close();
});
