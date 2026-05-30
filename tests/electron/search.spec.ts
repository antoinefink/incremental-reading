/**
 * Search (T042) E2E — drives the real Electron app.
 *
 * Local FTS5 full-text search over source title/body + extract body + card
 * prompt/answer + tags, ranked best-first, reaches the renderer only through the
 * typed `search.query` `window.appApi` command (no generic `db.query`). This
 * spec launches the built desktop app against a fresh data dir seeded with the
 * shared demo collection (the word "intelligence" appears in the source title +
 * body, the extract title/body, and the card prompt/answer), then:
 *
 *   1. the `search.query` bridge command exists (no raw SQL channel);
 *   2. opening `/search` and typing "intelligence" returns the seeded source,
 *      extract, and card grouped by type, with the match highlighted, ranked;
 *   3. clicking a result shows its detail/refblock (the source title);
 *   4. the bridge returns ranked, type-narrowable results (asserted directly);
 *   5. it SURVIVES AN APP RESTART — searching the same term still finds the
 *      seeded items (the FTS index persisted in the SQLite file).
 */

import { expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

let dataDir: string;
let baseUrl: string;

/** The seeded term that hits all three searchable types. */
const TERM = "intelligence";
const SOURCE_TITLE = "On the Measure of Intelligence";

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
});

/** Open `/search` and wait for the library screen to render. */
async function openSearch(page: Page): Promise<void> {
  await page.goto(`${baseUrl}/search`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("route-search")).toBeVisible();
}

test("the search.query bridge command exists (no raw SQL)", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;

  const surface = await page.evaluate(() => {
    const api = window.appApi as unknown as {
      search?: { query?: unknown };
      db?: { query?: unknown };
    };
    return {
      hasSearch: typeof api?.search?.query === "function",
      hasRawQuery: typeof api?.db?.query === "function",
    };
  });
  expect(surface.hasSearch).toBe(true);
  expect(surface.hasRawQuery).toBe(false);

  await app.close();
});

test("typing a seeded term returns the source, extract, and card grouped + highlighted", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await openSearch(page);

  await page.getByTestId("library-search-input").fill(TERM);

  // All three searchable groups appear (the seed has the term in each type).
  await expect(page.getByTestId("library-group-source")).toBeVisible();
  await expect(page.getByTestId("library-group-extract")).toBeVisible();
  await expect(page.getByTestId("library-group-card")).toBeVisible();

  // The matched term is highlighted in at least one result.
  await expect(page.locator('[data-testid="library-result"] em').first()).toBeVisible();

  // Clicking the seeded source result shows its detail panel + refblock.
  const sourceRow = page.getByTestId("library-group-source").getByTestId("library-result").first();
  await sourceRow.click();
  await expect(page.getByTestId("library-detail")).toBeVisible();
  await expect(page.getByTestId("library-detail-ref")).toContainText(SOURCE_TITLE);

  await app.close();
});

test("the search bridge returns ranked, type-narrowable results", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const res = await page.evaluate(async (term) => {
    const api = window.appApi as unknown as {
      search: {
        query(r: {
          q: string;
          type?: string;
        }): Promise<{ results: { id: string; type: string; score: number }[] }>;
      };
    };
    const all = await api.search.query({ q: term });
    const cards = await api.search.query({ q: term, type: "card" });
    const empty = await api.search.query({ q: "   " });
    return {
      types: all.results.map((r) => r.type),
      // Ranked: scores are non-decreasing (lower bm25 is better, sorted first).
      ranked: all.results.every(
        (r, i) => i === 0 || r.score >= (all.results[i - 1]?.score ?? -Infinity),
      ),
      cardsOnly: cards.results.every((r) => r.type === "card"),
      cardCount: cards.results.length,
      emptyCount: empty.results.length,
    };
  }, TERM);

  expect(res.types).toContain("source");
  expect(res.types).toContain("extract");
  expect(res.types).toContain("card");
  expect(res.ranked).toBe(true);
  expect(res.cardsOnly).toBe(true);
  expect(res.cardCount).toBeGreaterThan(0);
  expect(res.emptyCount).toBe(0);

  await app.close();
});

test("search still finds the seeded items after an app restart (FTS persisted)", async () => {
  // Re-launch against the SAME data dir — the restart analogue.
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const ids = await page.evaluate(async (term) => {
    const api = window.appApi as unknown as {
      search: { query(r: { q: string }): Promise<{ results: { id: string; type: string }[] }> };
    };
    const { results } = await api.search.query({ q: term });
    return {
      count: results.length,
      types: [...new Set(results.map((r) => r.type))],
    };
  }, TERM);

  expect(ids.count).toBeGreaterThan(0);
  expect(ids.types).toContain("source");
  expect(ids.types).toContain("extract");
  expect(ids.types).toContain("card");

  await app.close();
});
