/**
 * Auto-postpone overload valve (T077) E2E — drives the real Electron app.
 *
 * When the due load exceeds the daily minute budget, the `/queue` overload `Banner`
 * shows "N min over budget" + an "Auto-postpone" action.
 * Auto-postpone postpones the LOWEST-priority topics/sources first (then low-priority
 * mature cards) while PROTECTING high-priority cards, deterministically and undoably.
 *
 * This spec launches the built desktop app against a fresh data dir seeded with the
 * shared demo collection and:
 *
 *   1. sets the daily minute budget via the typed settings bridge;
 *   2. creates an over-budget set of low-priority (C) due attention items, plus keeps
 *      the seeded HIGH-priority due card, so estimated minutes exceed budget;
 *   3. opens `/queue` (future-clocked) → the overload Banner shows the over-budget count;
 *   4. clicks Auto-postpone → the preview lists what moves → confirm drops due minutes
 *      to ≤ budget when safe victims allow it, with the high-priority card STILL present;
 *   5. Undo restores the postponed items;
 *   6. it SURVIVES AN APP RESTART (re-postpone, then reopen — postponed items stay
 *      postponed; nothing is lost), and the bridge never exposes a generic db.query.
 */

import { expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });
// Each test launches the real Electron app + creates a backlog through the bridge, so give
// it the same generous budget the heavier import specs use (the default 30s is too tight).
test.setTimeout(120_000);

let dataDir: string;
/** The renderer base URL (`app://bundle`), captured from the first window. */
let baseUrl: string;

/** A fixed future clock so the seeded near-future due dates + our past-scheduled rows read as due. */
const AS_OF = "2027-06-01T12:00:00.000Z";
/** The date we park the created low-priority sources on (well before AS_OF → overdue at AS_OF). */
const PAST_DUE = "2027-01-01T09:00:00.000Z";
/** Past relative to the real clock, for standing-current-day policy checks. */
const CURRENT_PAST_DUE = "2025-01-01T09:00:00.000Z";
/** Daily minute budget for the overload test. */
const BUDGET_MINUTES = 60;
/** How many low-priority due sources to create so the queue is over budget. */
const LOW_SOURCES = 14;

/** Open `/queue` date-scoped via `?asOf=` and wait for it to render. */
async function openQueue(page: Page, asOf: string): Promise<void> {
  await page.goto(`${baseUrl}/queue?asOf=${encodeURIComponent(asOf)}`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("route-queue")).toBeVisible();
}

/** Open the live current-day queue, the surface that materializes the standing policy. */
async function openCurrentQueue(page: Page): Promise<void> {
  await page.goto(`${baseUrl}/queue`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("route-queue")).toBeVisible();
}

/** Read the current estimated due minutes via the bridge. */
async function dueMinutes(page: Page): Promise<number> {
  return page.evaluate(async (asOf) => {
    const api = window.appApi as unknown as {
      queue: {
        list(req: {
          asOf: string;
          includeTimeEstimate: true;
        }): Promise<{ minuteBudget?: { usedMinutes: number } }>;
      };
    };
    const result = await api.queue.list({ asOf, includeTimeEstimate: true });
    return result.minuteBudget?.usedMinutes ?? 0;
  }, AS_OF);
}

/** Read the live current-day estimated due minutes via the bridge. */
async function currentDueMinutes(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const api = window.appApi as unknown as {
      queue: {
        list(req: { includeTimeEstimate: true }): Promise<{
          minuteBudget?: { usedMinutes: number };
        }>;
      };
    };
    const result = await api.queue.list({ includeTimeEstimate: true });
    return result.minuteBudget?.usedMinutes ?? 0;
  });
}

/**
 * A high-priority (band-A, `protected`) CARD currently due in the queue at AS_OF — the
 * memory the auto-postpone must NEVER sacrifice. Resolved off the real queue read so the
 * test asserts against an item that genuinely competes for budget.
 */
async function highPriorityDueCardId(page: Page): Promise<string> {
  return page.evaluate(async (asOf) => {
    const api = window.appApi as unknown as {
      queue: {
        list(req: {
          asOf: string;
        }): Promise<{ items: { id: string; type: string; protected: boolean }[] }>;
      };
    };
    const { items } = await api.queue.list({ asOf });
    const card = items.find((i) => i.type === "card" && i.protected);
    if (!card) throw new Error("no high-priority due card in the seeded queue");
    return card.id;
  }, AS_OF);
}

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
});

test("standing automatic auto-postpone materializes once, survives restart, and undoes by receipt", async () => {
  const standingDir = makeDataDir();
  const app1 = await launchApp(standingDir, { seedOnEmpty: true });
  const page1 = await app1.firstWindow();
  await page1.waitForLoadState("domcontentloaded");
  const url = new URL(page1.url());
  baseUrl = `${url.protocol}//${url.host}`;

  await page1.evaluate(
    async ({ budget, count, pastDue }) => {
      const api = window.appApi as unknown as {
        settings: { updateMany(req: { patch: Record<string, unknown> }): Promise<unknown> };
        sources: {
          importManual(req: {
            title: string;
            priority?: string;
            body?: string;
          }): Promise<{ id: string }>;
        };
        queue: {
          schedule(req: { id: string; choice: { kind: "manual"; date: string } }): Promise<unknown>;
        };
      };
      await api.settings.updateMany({
        patch: { dailyBudgetMinutes: budget, overloadPolicy: "suggest" },
      });
      for (let i = 0; i < count; i++) {
        const { id } = await api.sources.importManual({
          title: `Standing backlog source ${i}`,
          priority: "C",
          body: "A low-priority standing-policy backlog item.",
        });
        await api.queue.schedule({ id, choice: { kind: "manual", date: pastDue } });
      }
    },
    { budget: BUDGET_MINUTES, count: LOW_SOURCES, pastDue: CURRENT_PAST_DUE },
  );

  const before = await currentDueMinutes(page1);
  expect(before).toBeGreaterThan(BUDGET_MINUTES);
  await page1.evaluate(async () => {
    const api = window.appApi as unknown as {
      settings: { updateMany(req: { patch: Record<string, unknown> }): Promise<unknown> };
    };
    await api.settings.updateMany({ patch: { overloadPolicy: "automatic" } });
  });

  await openCurrentQueue(page1);
  const receipt = page1.getByTestId("auto-postpone-receipt");
  await expect(receipt).toBeVisible();
  await expect(receipt).toContainText("slipped");
  await expect.poll(async () => currentDueMinutes(page1)).toBeLessThanOrEqual(BUDGET_MINUTES);
  const afterMaterialize = await currentDueMinutes(page1);
  await app1.close();

  const app2 = await launchApp(standingDir, { seedOnEmpty: true });
  const page2 = await app2.firstWindow();
  await page2.waitForLoadState("domcontentloaded");
  const url2 = new URL(page2.url());
  baseUrl = `${url2.protocol}//${url2.host}`;
  await openCurrentQueue(page2);
  await expect(page2.getByTestId("auto-postpone-receipt")).toBeVisible();
  expect(await currentDueMinutes(page2)).toBe(afterMaterialize);

  await page2.getByTestId("auto-postpone-receipt-undo").click();
  await expect(page2.getByTestId("auto-postpone-receipt-undone")).toBeVisible();
  await expect.poll(async () => currentDueMinutes(page2)).toBeGreaterThan(afterMaterialize);

  await app2.close();
});

test("auto-postpone relieves an over-budget queue, protects high-priority cards, and undoes", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;

  // 1) Set the minute budget + 2) create an over-budget low-priority due set:
  //    LOW_SOURCES C-priority sources, each scheduled to a PAST date so they read as
  //    overdue at AS_OF (low-priority topics — the FIRST auto-postpone victims).
  await page.evaluate(
    async ({ budget, count, pastDue }) => {
      const api = window.appApi as unknown as {
        settings: { updateMany(req: { patch: Record<string, unknown> }): Promise<unknown> };
        sources: {
          importManual(req: {
            title: string;
            priority?: string;
            body?: string;
          }): Promise<{ id: string }>;
        };
        queue: {
          schedule(req: { id: string; choice: { kind: "manual"; date: string } }): Promise<unknown>;
        };
      };
      await api.settings.updateMany({ patch: { dailyBudgetMinutes: budget } });
      for (let i = 0; i < count; i++) {
        const { id } = await api.sources.importManual({
          title: `Low-priority backlog source ${i}`,
          priority: "C",
          body: "A low-priority backlog item to process eventually.",
        });
        // Park it overdue (a low-priority attention item in the due set).
        await api.queue.schedule({ id, choice: { kind: "manual", date: pastDue } });
      }
    },
    { budget: BUDGET_MINUTES, count: LOW_SOURCES, pastDue: PAST_DUE },
  );

  const cardId = await highPriorityDueCardId(page);
  const before = await dueMinutes(page);
  expect(before).toBeGreaterThan(BUDGET_MINUTES); // genuinely over budget

  // 3) The overload Banner shows the over-budget count.
  await openQueue(page, AS_OF);
  const banner = page.getByTestId("queue-overload-banner");
  await expect(banner).toBeVisible();
  await expect(page.getByTestId("queue-overload-count")).toContainText("over today's budget");
  // The high-priority card row is present BEFORE the sweep.
  await expect(
    page.locator(`[data-testid="queue-item"][data-element-id="${cardId}"]`),
  ).toBeVisible();

  // 4) Auto-postpone → preview → confirm (the queue re-reads IN PLACE afterwards, so we
  //    do NOT re-navigate — that would destroy the undo snackbar).
  await page.getByTestId("queue-auto-postpone").click();
  await expect(page.getByTestId("queue-postpone-preview")).toBeVisible();
  await expect(page.getByTestId("queue-postpone-row").first()).toBeVisible();
  await page.getByTestId("queue-postpone-confirm").click();

  // The due minutes drop to ≤ budget (via the bridge, the authoritative number)…
  await expect.poll(async () => dueMinutes(page)).toBeLessThanOrEqual(BUDGET_MINUTES);
  // …and the high-priority card row is STILL in the in-place-refreshed list.
  await expect(
    page.locator(`[data-testid="queue-item"][data-element-id="${cardId}"]`),
  ).toBeVisible();
  // The "Postponed N" snackbar appeared.
  await expect(page.getByTestId("queue-snackbar")).toBeVisible();

  // 5) Undo restores the postponed items (the snackbar's Undo → batch undo).
  const afterPostpone = await dueMinutes(page);
  await page.getByTestId("queue-snackbar").getByText("Undo").click();
  await expect.poll(async () => dueMinutes(page)).toBeGreaterThan(afterPostpone);
  expect(await dueMinutes(page)).toBe(before);

  await app.close();
});

test("the auto-postpone result survives an app restart (no generic db.query)", async () => {
  // Re-postpone (the undo above restored the over-budget state), close, reopen, and assert
  // the postponed items stayed postponed across a real restart — nothing was lost.
  const app1 = await launchApp(dataDir, { seedOnEmpty: true });
  const page1 = await app1.firstWindow();
  await page1.waitForLoadState("domcontentloaded");

  const surface = await page1.evaluate(() => {
    const api = window.appApi as unknown as {
      queue?: { autoPostpone?: unknown; autoPostponeApply?: unknown };
      db?: { query?: unknown };
    };
    return {
      hasPreview: typeof api?.queue?.autoPostpone === "function",
      hasApply: typeof api?.queue?.autoPostponeApply === "function",
      hasQuery: typeof api?.db?.query === "function",
    };
  });
  expect(surface.hasPreview).toBe(true);
  expect(surface.hasApply).toBe(true);
  expect(surface.hasQuery).toBe(false);

  const overBudget = await dueMinutes(page1);
  expect(overBudget).toBeGreaterThan(BUDGET_MINUTES);
  const applied = await page1.evaluate(async (asOf) => {
    const api = window.appApi as unknown as {
      queue: { autoPostponeApply(req: { asOf: string }): Promise<{ postponed: number }> };
    };
    return api.queue.autoPostponeApply({ asOf });
  }, AS_OF);
  expect(applied.postponed).toBeGreaterThan(0);
  const afterApply = await dueMinutes(page1);
  expect(afterApply).toBeLessThanOrEqual(BUDGET_MINUTES);
  await app1.close();

  // Reopen — the postponed items stay postponed (durable across restart).
  const app2 = await launchApp(dataDir, { seedOnEmpty: true });
  const page2 = await app2.firstWindow();
  await page2.waitForLoadState("domcontentloaded");
  expect(await dueMinutes(page2)).toBe(afterApply);
  await app2.close();
});
