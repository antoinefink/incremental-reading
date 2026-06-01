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

test("DRILL-DOWN — the concept facet chip count equals the visible extract rows under TYPE=Extracts (the screenshot repro)", async () => {
  // The reported bug: with TYPE=Extracts AND a concept facet both active, the
  // concept chip showed a GLOBAL member count (e.g. 4 = 3 extracts + 1 card) while
  // the list showed only the 3 extracts — chip and list disagreed. This drives the
  // EXACT scenario end-to-end across the real Electron + SQLite stack: build a concept
  // with N extracts + 1 card (memberCount = N+1) and a second concept with members but
  // ZERO extracts, then assert the filterbar chip's drill-down count equals the rows.
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // Seed the scenario over the TYPED bridge only (no raw SQL): three NEW extracts on
  // the seeded source + one card distilled from the first; a "Faceting" concept that
  // gets all three extracts AND the card (so its global memberCount is 4 but exactly
  // 3 are extracts); an "Audio only" concept that gets ONLY the source (0 extracts).
  const seeded = await page.evaluate(async () => {
    const api = window.appApi as unknown as {
      inspector: { list(): Promise<{ elements: { id: string; type: string; title: string }[] }> };
      extractions: {
        create(r: {
          sourceElementId: string;
          selectedText: string;
          blockIds: string[];
          title?: string;
        }): Promise<{ extract: { id: string } }>;
      };
      cards: {
        create(r: {
          extractId: string;
          kind: "qa";
          prompt: string;
          answer: string;
        }): Promise<{ card: { id: string } }>;
      };
      concepts: {
        create(r: { name: string }): Promise<{ concept: { id: string } }>;
        assign(r: { elementId: string; conceptId: string }): Promise<unknown>;
      };
    };
    const { elements } = await api.inspector.list();
    const source = elements.find(
      (e) => e.type === "source" && e.title === "On the Measure of Intelligence",
    );
    if (!source) throw new Error("seeded source not found");

    // Three fresh extracts anchored on the intro blocks (distinct from the seed extract).
    const blocks = ["blk_intro_p1", "blk_intro_p2", "blk_def_p2"];
    const extractIds: string[] = [];
    for (let i = 0; i < blocks.length; i++) {
      const { extract } = await api.extractions.create({
        sourceElementId: source.id,
        selectedText: `Faceting fixture extract number ${i + 1} for the drill-down repro.`,
        blockIds: [blocks[i]],
        title: `Faceting extract ${i + 1}`,
      });
      extractIds.push(extract.id);
    }

    // One card distilled from the first extract — a NON-extract member of the concept.
    const { card } = await api.cards.create({
      extractId: extractIds[0],
      kind: "qa",
      prompt: "What is the faceting fixture for?",
      answer: "Proving the drill-down concept count matches the list.",
    });

    // "Faceting" concept: 3 extracts + 1 card  →  memberCount 4, but 3 are extracts.
    const { concept: faceting } = await api.concepts.create({ name: "Faceting" });
    for (const id of extractIds)
      await api.concepts.assign({ elementId: id, conceptId: faceting.id });
    await api.concepts.assign({ elementId: card.id, conceptId: faceting.id });

    // "Audio only" concept: ONLY the source  →  members but ZERO extracts.
    const { concept: audio } = await api.concepts.create({ name: "Audio only" });
    await api.concepts.assign({ elementId: source.id, conceptId: audio.id });

    return {
      facetingId: faceting.id,
      audioId: audio.id,
      extractCount: extractIds.length, // 3
      cardId: card.id,
    };
  });

  await openLibrary(page);

  // The "Faceting" chip — with NO type filter active — counts ALL its live members
  // that match the (empty) other facets: the 3 extracts + the 1 card = 4. This is the
  // drill-down byConcept count (NOT the global memberCount, which would also be 4 here,
  // but crucially it must now CHANGE when TYPE=Extracts is added — see below).
  const facetingChip = page.getByTestId(`library-filter-concept-${seeded.facetingId}`);
  await expect(facetingChip).toBeVisible();
  await expect(facetingChip.locator(".filter-opt__count")).toHaveText(
    String(seeded.extractCount + 1),
  );

  // Activate TYPE=Extracts. The drill-down recomputes: the "Faceting" chip must now
  // show ONLY its extract members (3), and the "Audio only" chip — whose lone member
  // is the source — must show 0 (so clicking it is never a surprise-empty list).
  await page.getByTestId("library-filter-type-extract").click();
  await expect(facetingChip.locator(".filter-opt__count")).toHaveText(String(seeded.extractCount));
  const audioChip = page.getByTestId(`library-filter-concept-${seeded.audioId}`);
  await expect(audioChip.locator(".filter-opt__count")).toHaveText("0");

  // THE HARD INVARIANT: select the "Faceting" concept too. With TYPE=Extracts +
  // CONCEPT=Faceting both active, the chip number equals the visible extract rows.
  await facetingChip.click();
  const extractGroup = page.getByTestId("library-group-extract");
  await expect(extractGroup).toBeVisible();
  // Only extracts are listed (no source/card group leaks through the intersection).
  await expect(page.getByTestId("library-group-source")).toHaveCount(0);
  await expect(page.getByTestId("library-group-card")).toHaveCount(0);
  const rows = extractGroup.getByTestId("library-result");
  await expect(rows).toHaveCount(seeded.extractCount);
  // The chip count and the rendered row count agree — the exact bug, now fixed.
  await expect(facetingChip.locator(".filter-opt__count")).toHaveText(String(seeded.extractCount));
  // And the calm total summary equals the rows shown (counts.all matches the list).
  await expect(page.getByTestId("library-count")).toHaveText(`${seeded.extractCount} elements`);

  // Switching to the 0-extract "Audio only" concept (TYPE=Extracts still on) yields
  // an HONEST empty state — its chip already shows 0, so the empty list is no surprise.
  await facetingChip.click(); // clear Faceting
  await audioChip.click(); // select Audio only
  await expect(page.getByTestId("library-empty")).toBeVisible();
  await expect(audioChip.locator(".filter-opt__count")).toHaveText("0");

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
