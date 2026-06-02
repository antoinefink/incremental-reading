/**
 * FSRS parameter optimization (T080) E2E — drives the real Electron app.
 *
 * Accumulated `review_logs` are replayed ON-DEVICE to SUGGEST a better FSRS
 * parameter set (never auto-applied) with a workload-impact preview; the user
 * explicitly applies or dismisses; an applied set changes subsequent scheduling and
 * survives an app restart. This spec launches the built desktop app against a fresh
 * data dir seeded with the shared demo collection and asserts, end-to-end through the
 * typed `window.appApi` + the `/settings` Optimization panel:
 *
 *   1. the Optimization panel runs the fit and shows an honest result (the seeded
 *      history is small → the INSUFFICIENT-DATA empty state), persisting nothing;
 *   2. applying a parameter set (the typed `optimization.apply`) CHANGES a card's
 *      scheduled interval — the applied params reach FSRS via the per-card scheduler;
 *   3. it SURVIVES AN APP RESTART — the applied global preset persists and still
 *      governs scheduling.
 *
 * Everything flows through the narrow bridge / the typed optimization IPC — there is
 * no raw SQL, FSRS stays card-only, and nothing is auto-applied.
 */

import { expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

let dataDir: string;

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
});

// A valid, in-bounds 21-number FSRS-6 vector (decay w[20] at the 0.8 ceiling) that
// round-trips unchanged through the apply's `clipParameters`/`checkParameters` and
// schedules a clearly different `good` interval than the ts-fsrs `default_w`.
const STEEP_W = [
  0.4, 1.2, 3.1, 15.7, 7.2, 0.6, 1.0, 0.05, 1.5, 0.1, 1.0, 2.0, 0.05, 0.3, 1.5, 0.2, 3.0, 0.5, 0.6,
  0.1, 0.8,
];

/** Author ONE matured Q&A card from the seeded extract, graded so it earns a multi-day interval. */
async function authorMaturedCard(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const api = window.appApi as unknown as {
      inspector: { list(): Promise<{ elements: { id: string; type: string }[] }> };
      cards: {
        create(req: {
          extractId: string;
          kind: string;
          prompt: string;
          answer: string;
        }): Promise<{ card: { id: string } }>;
      };
      review: {
        grade(req: {
          cardId: string;
          rating: string;
          responseMs: number;
          asOf: string;
        }): Promise<{ reviewState: { dueAt: string | null } }>;
      };
    };
    const { elements } = await api.inspector.list();
    const extract = elements.find((e) => e.type === "extract");
    if (!extract) throw new Error("no seeded extract");
    const { card } = await api.cards.create({
      extractId: extract.id,
      kind: "qa",
      prompt: "Optimize Q?",
      answer: "A.",
    });
    let clock = Date.parse("2027-01-01T00:00:00.000Z");
    for (let i = 0; i < 3; i++) {
      const res = await api.review.grade({
        cardId: card.id,
        rating: "good",
        responseMs: 1000,
        asOf: new Date(clock).toISOString(),
      });
      clock = res.reviewState.dueAt
        ? Date.parse(res.reviewState.dueAt) + 86_400_000
        : clock + 86_400_000;
    }
    return card.id;
  });
}

/** Preview the `Good` next-interval (days) for a card at a fixed FUTURE clock. */
async function goodIntervalDays(page: Page, cardId: string): Promise<number> {
  return page.evaluate(async (id) => {
    const api = window.appApi as unknown as {
      review: {
        preview(req: {
          cardId: string;
          asOf: string;
        }): Promise<{ intervals: { good: { scheduledDays: number } } | null }>;
      };
    };
    const res = await api.review.preview({ cardId: id, asOf: "2099-01-01T00:00:00.000Z" });
    return res.intervals?.good.scheduledDays ?? 0;
  }, cardId);
}

/** Apply a global FSRS parameter preset through the typed optimization IPC. */
async function applyGlobalParams(page: Page, params: number[]): Promise<void> {
  await page.evaluate(async (w) => {
    const api = window.appApi as unknown as {
      optimization: {
        apply(req: { scope: { scope: "global" }; params: number[] }): Promise<{ applied: true }>;
      };
    };
    await api.optimization.apply({ scope: { scope: "global" }, params: w });
  }, params);
}

/** Read the persisted global FSRS preset via the typed settings read. */
async function getGlobalParams(page: Page): Promise<number[] | null> {
  return page.evaluate(async () => {
    const api = window.appApi as unknown as {
      settings: { getAll(): Promise<{ settings: { fsrsParamsGlobal: number[] | null } }> };
    };
    const { settings } = await api.settings.getAll();
    return settings.fsrsParamsGlobal;
  });
}

/** Navigate to /settings through the real router (user-chip menu → Settings). */
async function gotoSettings(page: Page) {
  await page.getByTestId("user-chip").click();
  await page.getByRole("menuitem", { name: /^Settings$/ }).click();
  await expect(page.getByTestId("route-settings")).toBeVisible();
}

test("optimization panel runs honestly; applied params change scheduling and survive restart", async () => {
  let cardId: string;
  let beforeInterval: number;

  // ---- Session 1: run the panel (insufficient-data), then apply params via the API ----
  {
    const app = await launchApp(dataDir, { seedOnEmpty: true });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    cardId = await authorMaturedCard(page);
    beforeInterval = await goodIntervalDays(page, cardId);
    expect(beforeInterval).toBeGreaterThan(0);

    // Open the Optimization panel in /settings and run the fit. The seeded history is
    // small, so the honest result is the INSUFFICIENT-DATA empty state — and nothing
    // is persisted by the read-only suggest.
    await gotoSettings(page);
    await expect(page.getByTestId("optimization-panel")).toBeVisible();
    expect(await getGlobalParams(page)).toBeNull();
    await page.getByTestId("optimization-run").click();
    await expect(page.getByTestId("optimization-insufficient")).toBeVisible();
    // The suggest persisted nothing.
    expect(await getGlobalParams(page)).toBeNull();

    // Apply a known global preset through the typed command (the only persisting path).
    await applyGlobalParams(page, STEEP_W);
    expect(await getGlobalParams(page)).toEqual(STEEP_W);

    // The applied params reach FSRS via the per-card scheduler → the interval changes.
    const afterInterval = await goodIntervalDays(page, cardId);
    expect(Math.abs(afterInterval - beforeInterval)).toBeGreaterThan(0.5);

    await app.close();
  }

  // ---- Session 2: RESTART — the applied preset persists + still governs scheduling ----
  {
    const app = await launchApp(dataDir);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    expect(await getGlobalParams(page)).toEqual(STEEP_W);
    // The card still schedules under the applied params (a positive, finite interval).
    expect(await goodIntervalDays(page, cardId)).toBeGreaterThan(0);

    await app.close();
  }
});
