/**
 * Catch-up & vacation modes (T078) E2E — drives the real Electron app.
 *
 * Two human-facing overload tools, BOTH showing the COST of postponement BEFORE committing:
 *
 *  - **Catch-up** recovers from a backlog: it spreads the overdue pile forward over N days so
 *    each day stays within the daily budget (high-value/fragile first), and the daily due count
 *    drops to ≤ budget across days. The preview shows the cost (the before/after load curve);
 *    Undo restores the backlog.
 *  - **Vacation** pre-adjusts the away-window load: items due in `[awayStart, awayEnd]` are
 *    suspended (fragile cards) or shifted past return, and the after-return load is within
 *    budget. The preview shows the cost; the plan survives an app restart (nothing lost).
 *
 * This spec launches the built desktop app against a fresh data dir seeded with the shared demo
 * collection and exercises both modes end-to-end through the typed bridge + the queue UI.
 */

import { expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);

let dataDir: string;
/** The renderer base URL (`app://bundle`), captured from the first window. */
let baseUrl: string;

/** A fixed future clock so the seeded near-future + past-scheduled rows read deterministically. */
const AS_OF = "2027-06-01T12:00:00.000Z";
/** A past date the backlog sources are parked on (overdue at AS_OF). */
const PAST_DUE = "2027-01-01T09:00:00.000Z";
/** The budget floor the settings layer clamps to. */
const BUDGET = 10;
/** How many overdue low-priority sources to create so the queue is a genuine backlog. */
const BACKLOG = 26;

/** Open `/queue` date-scoped via `?asOf=` and wait for it to render. */
async function openQueue(page: Page, asOf: string): Promise<void> {
  await page.goto(`${baseUrl}/queue?asOf=${encodeURIComponent(asOf)}`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("route-queue")).toBeVisible();
}

/** Read the current due count (the budget gauge's `used`) at a clock via the bridge. */
async function dueCountAt(page: Page, asOf: string): Promise<number> {
  return page.evaluate(async (clock) => {
    const api = window.appApi as unknown as {
      queue: { list(req: { asOf: string }): Promise<{ budget: { used: number } }> };
    };
    return (await api.queue.list({ asOf: clock })).budget.used;
  }, asOf);
}

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
});

test("catch-up spreads an overdue backlog within budget across days, shows the cost, and undoes", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;

  // Set the budget floor + create an overdue low-priority backlog (parked in the past → overdue).
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
      await api.settings.updateMany({ patch: { dailyReviewBudget: budget } });
      for (let i = 0; i < count; i++) {
        const { id } = await api.sources.importManual({
          title: `Backlog source ${i}`,
          priority: "C",
          body: "A low-priority backlog item to process eventually.",
        });
        await api.queue.schedule({ id, choice: { kind: "manual", date: pastDue } });
      }
    },
    { budget: BUDGET, count: BACKLOG, pastDue: PAST_DUE },
  );

  const before = await dueCountAt(page, AS_OF);
  expect(before).toBeGreaterThan(BUDGET); // a genuine backlog

  await openQueue(page, AS_OF);

  // Open the catch-up preview → the COST is shown (the before/after load curve) before Apply.
  await page.getByTestId("recovery-catchup-open").click();
  await expect(page.getByTestId("recovery-catchup-preview")).toBeVisible();
  await expect(page.getByTestId("recovery-loadcurve")).toBeVisible();
  await expect(page.getByTestId("recovery-catchup-slips")).toBeVisible();

  // Apply → the backlog spreads forward (the due-NOW count drops to ≤ budget).
  await page.getByTestId("recovery-catchup-apply").click();
  await expect.poll(async () => dueCountAt(page, AS_OF)).toBeLessThanOrEqual(BUDGET);
  // The "Spread N · Undo" snackbar appeared.
  await expect(page.getByTestId("queue-snackbar")).toBeVisible();

  // The spread keeps EACH DAY within budget: the INCREMENTAL load added on each calendar
  // day of the runway (the cumulative due-at-or-before count minus the prior day's) ≤ budget.
  // (`budget.used` is cumulative — due at/before the clock — so we difference consecutive days.)
  let prevCumulative = 0;
  for (let d = 1; d <= 5; d++) {
    const clock = `2027-06-0${d}T12:00:00.000Z`;
    const cumulative = await dueCountAt(page, clock);
    expect(cumulative - prevCumulative).toBeLessThanOrEqual(BUDGET);
    prevCumulative = cumulative;
  }

  // Undo restores the whole backlog (the batch undo).
  await page.getByTestId("queue-snackbar").getByText("Undo").click();
  await expect.poll(async () => dueCountAt(page, AS_OF)).toBe(before);

  await app.close();
});

test("vacation suspends/shifts the away-window load and survives an app restart", async () => {
  const app1 = await launchApp(dataDir, { seedOnEmpty: true });
  const page1 = await app1.firstWindow();
  await page1.waitForLoadState("domcontentloaded");

  // The recovery surface is exposed on the typed bridge; there is no generic db.query.
  const surface = await page1.evaluate(() => {
    const api = window.appApi as unknown as {
      queue?: {
        catchUp?: unknown;
        catchUpApply?: unknown;
        vacation?: unknown;
        vacationApply?: unknown;
      };
      db?: { query?: unknown };
    };
    return {
      hasCatchUp: typeof api?.queue?.catchUp === "function",
      hasCatchUpApply: typeof api?.queue?.catchUpApply === "function",
      hasVacation: typeof api?.queue?.vacation === "function",
      hasVacationApply: typeof api?.queue?.vacationApply === "function",
      hasQuery: typeof api?.db?.query === "function",
    };
  });
  expect(surface.hasCatchUp).toBe(true);
  expect(surface.hasCatchUpApply).toBe(true);
  expect(surface.hasVacation).toBe(true);
  expect(surface.hasVacationApply).toBe(true);
  expect(surface.hasQuery).toBe(false);

  // Create a set of sources due DURING an away window (so vacation moves them).
  const awayStart = "2027-07-10T00:00:00.000Z";
  const awayEnd = "2027-07-20T23:59:59.000Z";
  await page1.evaluate(
    async ({ awayMid }) => {
      const api = window.appApi as unknown as {
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
      for (let i = 0; i < 8; i++) {
        const { id } = await api.sources.importManual({
          title: `Away-window source ${i}`,
          priority: "B",
          body: "Due while the user is away.",
        });
        await api.queue.schedule({ id, choice: { kind: "manual", date: awayMid } });
      }
    },
    { awayMid: "2027-07-15T09:00:00.000Z" },
  );

  // Count what is due DURING the away window before vacation.
  // The items due IN the window = (due at/before awayEnd) − (due at/before just before awayStart),
  // since `budget.used` is the cumulative due-at-or-before count.
  const justBeforeAway = "2027-07-09T23:59:59.000Z";
  const dueByAwayEnd = await dueCountAt(page1, awayEnd);
  const dueBeforeAway = await dueCountAt(page1, justBeforeAway);
  const awayWindowDue = dueByAwayEnd - dueBeforeAway;
  expect(awayWindowDue).toBeGreaterThan(0);

  // Preview (read-only) then apply the vacation through the bridge.
  const preview = await page1.evaluate(
    async ({ start, end, asOf }) => {
      const api = window.appApi as unknown as {
        queue: {
          vacation(req: {
            awayStart: string;
            awayEnd: string;
            asOf?: string;
          }): Promise<{ suspendedCount: number; shiftedCount: number }>;
        };
      };
      return api.queue.vacation({ awayStart: start, awayEnd: end, asOf });
    },
    { start: awayStart, end: awayEnd, asOf: AS_OF },
  );
  expect(preview.suspendedCount + preview.shiftedCount).toBeGreaterThan(0);

  const applied = await page1.evaluate(
    async ({ start, end, asOf }) => {
      const api = window.appApi as unknown as {
        queue: {
          vacationApply(req: {
            awayStart: string;
            awayEnd: string;
            asOf?: string;
          }): Promise<{ moved: number; suspended: number; batchId: string }>;
        };
      };
      return api.queue.vacationApply({ awayStart: start, awayEnd: end, asOf });
    },
    { start: awayStart, end: awayEnd, asOf: AS_OF },
  );
  // Every away-window item moved (suspended or shifted past return).
  expect(applied.moved + applied.suspended).toBe(awayWindowDue);

  // Nothing is due in the away window anymore (suspended or shifted out): the items still
  // due by awayEnd are exactly the pre-window backlog (the away-window slice is now empty).
  const awayDueAfter = await dueCountAt(page1, awayEnd);
  expect(awayDueAfter).toBe(dueBeforeAway);
  await app1.close();

  // Reopen — the vacation plan persisted (suspended stays suspended, shifted stays shifted).
  const app2 = await launchApp(dataDir, { seedOnEmpty: true });
  const page2 = await app2.firstWindow();
  await page2.waitForLoadState("domcontentloaded");
  expect(await dueCountAt(page2, awayEnd)).toBe(awayDueAfter);
  await app2.close();
});
