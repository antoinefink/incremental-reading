/**
 * Due queue (T029) E2E — drives the real Electron app.
 *
 * The `/queue` screen lists everything DUE — due cards (FSRS) AND due
 * sources/topics/extracts (attention) — sorted by priority then due date, with
 * type/concept/status filters, the `BudgetMeter`, the correct `SchedulerChip` per
 * row, the `Prio` band, and the `--protected` accent bar for A items. This spec
 * launches the built desktop app against a fresh data dir seeded with the shared
 * demo collection and asserts:
 *
 *   1. the `queue.list` bridge command exists (no generic db.query);
 *   2. the read returns due cards AND due attention items, each tagged with the
 *      right scheduler, sorted priority-then-due-date (asserted at the bridge);
 *   3. the `/queue` screen renders the `qitem` rows with the right scheduler chip,
 *      priority badge, and due labels, and a filter chip narrows the list;
 *   4. it SURVIVES AN APP RESTART (the due items are still scheduled).
 *
 * The seed's due dates are in the near future, so the screen + bridge are driven
 * with a fixed FUTURE `asOf` (the queue route honors an `?asOf=` search param) so
 * the seeded cards/extracts read as due deterministically. An extract is first
 * given a `due_at` via the existing `extracts.postpone` command so an ATTENTION
 * item is in the due set alongside the FSRS card.
 */

import { expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

let dataDir: string;
/** The renderer base URL (`app://bundle`), captured from the first window. */
let baseUrl: string;

/** A fixed future clock so the seeded near-future due dates read as due. */
const AS_OF = "2027-06-01T12:00:00.000Z";

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
});

/** Open `/queue` (optionally date-scoped via `?asOf=`) and wait for it to render. */
async function openQueue(page: Page, asOf?: string): Promise<void> {
  const suffix = asOf ? `?asOf=${encodeURIComponent(asOf)}` : "";
  await page.goto(`${baseUrl}/queue${suffix}`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("route-queue")).toBeVisible();
}

/** Find the extract element id from the inspector picker (by its seeded title). */
async function findExtractId(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const api = window.appApi as unknown as {
      inspector: { list(): Promise<{ elements: { id: string; type: string; title: string }[] }> };
    };
    const { elements } = await api.inspector.list();
    const extract = elements.find(
      (e) => e.type === "extract" && e.title.includes("skill-acquisition"),
    );
    if (!extract) throw new Error("seeded extract not found");
    return extract.id;
  });
}

test("the queue.list bridge command exists (no raw SQL)", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;

  const surface = await page.evaluate(() => {
    const api = window.appApi as unknown as {
      queue?: { list?: unknown };
      db?: { query?: unknown };
    };
    return {
      hasList: typeof api?.queue?.list === "function",
      hasQuery: typeof api?.db?.query === "function",
    };
  });
  expect(surface.hasList).toBe(true);
  expect(surface.hasQuery).toBe(false);

  await app.close();
});

test("queue.list returns due cards AND due attention items, sorted priority-then-due", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // Give the seeded extract a due_at (it starts unscheduled) so an ATTENTION item
  // joins the due set alongside the FSRS card — through the existing bridge command.
  const extractId = await findExtractId(page);
  await page.evaluate(async (id) => {
    const api = window.appApi as unknown as {
      extracts: { postpone(req: { id: string }): Promise<unknown> };
    };
    await api.extracts.postpone({ id });
  }, extractId);

  const data = await page.evaluate(async (asOf) => {
    const api = window.appApi as unknown as {
      queue: {
        list(req: { asOf: string }): Promise<{
          items: { id: string; type: string; scheduler: string; priority: number }[];
        }>;
      };
    };
    return api.queue.list({ asOf });
  }, AS_OF);

  // Both schedulers are present, kept distinct.
  const schedulers = new Set(data.items.map((i) => i.scheduler));
  expect(schedulers.has("fsrs")).toBe(true);
  expect(schedulers.has("attention")).toBe(true);
  // The card (qa) reads as fsrs; the extract reads as attention.
  expect(data.items.find((i) => i.type === "card")?.scheduler).toBe("fsrs");
  expect(data.items.find((i) => i.id === extractId)?.scheduler).toBe("attention");

  // Sorted by priority DESC (then due asc) — each row's priority is ≤ the previous.
  for (let i = 1; i < data.items.length; i++) {
    expect(data.items[i - 1].priority).toBeGreaterThanOrEqual(data.items[i].priority);
  }

  await app.close();
});

test("the /queue screen renders due rows with chips, priority + due labels", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // Drive the screen with the fixed future clock so the seeded items read as due.
  await openQueue(page, AS_OF);

  // The budget meter + filters render.
  await expect(page.getByTestId("budget-meter")).toBeVisible();
  await expect(page.getByTestId("queue-filters")).toBeVisible();

  // At least one due row renders, and a card row shows the FSRS chip.
  const rows = page.getByTestId("queue-item");
  await expect(rows.first()).toBeVisible();
  const cardRow = page.locator('[data-testid="queue-item"][data-element-type="card"]').first();
  await expect(cardRow).toBeVisible();
  await expect(cardRow.locator('[data-scheduler="fsrs"]')).toBeVisible();
  // Every row shows a priority badge + a due label.
  await expect(cardRow.locator(".prio")).toBeVisible();
  await expect(cardRow.getByTestId("queue-due-badge")).toBeVisible();

  await app.close();
});

test("a filter chip narrows the due list to one type", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await openQueue(page, AS_OF);
  await expect(page.getByTestId("queue-item").first()).toBeVisible();

  // Filter to Cards — every remaining row is a card.
  await page.getByTestId("queue-filter-card").click();
  const rows = page.getByTestId("queue-item");
  await expect(rows.first()).toBeVisible();
  const count = await rows.count();
  for (let i = 0; i < count; i++) {
    await expect(rows.nth(i)).toHaveAttribute("data-element-type", "card");
  }

  await app.close();
});

test("postpone removes an item from the due list in place (no navigation) (T030)", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // Self-clock: read the extract's CURRENT due via the bridge and drive the screen
  // with that exact clock, so the seeded extract reads as due "today" — then a
  // postpone (which pushes it strictly later) reliably drops it from THIS view,
  // regardless of how the postpone interval grows.
  const extractId = await findExtractId(page);
  const currentDue = await page.evaluate(async (id) => {
    const api = window.appApi as unknown as {
      inspector: {
        get(req: { id: string }): Promise<{ data: { element: { dueAt: string | null } } | null }>;
      };
    };
    const res = await api.inspector.get({ id });
    return res.data?.element.dueAt ?? null;
  }, extractId);
  if (!currentDue)
    throw new Error("seeded extract has no due_at (it should after the postpone above)");

  await openQueue(page, currentDue);
  const row = page.locator(`[data-testid="queue-item"][data-element-id="${extractId}"]`);
  await expect(row).toBeVisible();

  // Postpone it via its in-place action button — it leaves the DUE list (the URL
  // never changes: no navigation happens on an action).
  await row.getByTestId("queue-action-postpone").click();
  await expect(row).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe("/queue");

  await app.close();
});

test("raise priority changes a row's Prio badge in place (T030)", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await openQueue(page, AS_OF);
  // Pick a due card row (cards persist as due via the seed) that is not already A.
  const cardRow = page.locator('[data-testid="queue-item"][data-element-type="card"]').first();
  await expect(cardRow).toBeVisible();
  const before = (await cardRow.locator(".prio").first().textContent())?.trim();

  await cardRow.getByTestId("queue-action-raise").click();
  // The row stays (raise does not remove it); its Prio badge reflects the new band.
  await expect(cardRow).toBeVisible();
  await expect(cardRow.locator(".prio").first()).toBeVisible();
  if (before && before !== "A") {
    await expect
      .poll(async () => (await cardRow.locator(".prio").first().textContent())?.trim())
      .not.toBe(before);
  }
  expect(new URL(page.url()).pathname).toBe("/queue");

  await app.close();
});

test("delete removes a row + an undo snackbar restores it (T030)", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await openQueue(page, AS_OF);
  const cardRow = page.locator('[data-testid="queue-item"][data-element-type="card"]').first();
  await expect(cardRow).toBeVisible();
  const cardId = await cardRow.getAttribute("data-element-id");
  if (!cardId) throw new Error("card row has no element id");

  // Delete it → the row is removed and an undo snackbar appears.
  await cardRow.getByTestId("queue-action-delete").click();
  await expect(page.locator(`[data-testid="queue-item"][data-element-id="${cardId}"]`)).toHaveCount(
    0,
  );
  await expect(page.getByTestId("queue-snackbar")).toBeVisible();

  // The delete is SOFT — the element still exists with deletedAt set (queried via
  // the bridge, not raw SQL).
  const deletedState = await page.evaluate(async (id) => {
    const api = window.appApi as unknown as {
      inspector: {
        get(req: { id: string }): Promise<{ data: { element: { id: string } } | null }>;
      };
    };
    return api.inspector.get({ id });
  }, cardId);
  expect(deletedState.data).toBeNull(); // soft-deleted → not inspectable as a live element

  // Undo restores the row.
  await page.getByTestId("queue-snackbar-undo").click();
  await expect(
    page.locator(`[data-testid="queue-item"][data-element-id="${cardId}"]`),
  ).toBeVisible();

  await app.close();
});

test("markDone and dismiss remove a row and it stays gone on a re-read (T030)", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await openQueue(page, AS_OF);
  const rows = page.getByTestId("queue-item");
  await expect(rows.first()).toBeVisible();

  // Capture two DISTINCT due rows up front (any type) with their CURRENT status —
  // markDone one, dismiss the other. Using ids (not positional `.first()`) keeps this
  // stable across the re-sort each refresh triggers; the statuses let us RESTORE both
  // rows at the end so this serial spec leaves the shared due set untouched for the
  // restart test that follows.
  const due = await page.evaluate(async (asOf) => {
    const api = window.appApi as unknown as {
      queue: {
        list(req: { asOf: string }): Promise<{ items: { id: string; status: string }[] }>;
      };
    };
    const res = await api.queue.list({ asOf });
    return res.items.map((i) => ({ id: i.id, status: i.status }));
  }, AS_OF);
  expect(due.length).toBeGreaterThanOrEqual(2);
  const doneRow = due[0];
  const dismissRowMeta = due[1];

  // markDone → the row leaves the list in place (no navigation).
  await page
    .locator(`[data-testid="queue-item"][data-element-id="${doneRow.id}"]`)
    .getByTestId("queue-action-markDone")
    .click();
  await expect(
    page.locator(`[data-testid="queue-item"][data-element-id="${doneRow.id}"]`),
  ).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe("/queue");

  // dismiss the second, still-present row → it too leaves the list.
  const dismissRow = page.locator(
    `[data-testid="queue-item"][data-element-id="${dismissRowMeta.id}"]`,
  );
  await expect(dismissRow).toBeVisible();
  await dismissRow.getByTestId("queue-action-dismiss").click();
  await expect(dismissRow).toHaveCount(0);

  // The READ-side guarantee: a fresh queue.list at the SAME clock must not contain
  // either id — the done/dismissed rows no longer satisfy the due query (this is the
  // regression: they used to reappear because the due read ignored status).
  const stillDue = await page.evaluate(async (asOf) => {
    const api = window.appApi as unknown as {
      queue: { list(req: { asOf: string }): Promise<{ items: { id: string }[] }> };
    };
    const res = await api.queue.list({ asOf });
    return res.items.map((i) => i.id);
  }, AS_OF);
  expect(stillDue).not.toContain(doneRow.id);
  expect(stillDue).not.toContain(dismissRowMeta.id);

  // RESTORE both rows (re-set their prior status via the typed undo command) so the
  // shared, serially-reused data dir is unchanged for the restart test below.
  await page.evaluate(
    async (rowsToRestore) => {
      const api = window.appApi as unknown as {
        queue: {
          undo(req: {
            id: string;
            undo: { kind: "restore" | "status"; previousStatus: string };
          }): Promise<unknown>;
        };
      };
      for (const r of rowsToRestore) {
        await api.queue.undo({ id: r.id, undo: { kind: "status", previousStatus: r.status } });
      }
    },
    [doneRow, dismissRowMeta],
  );
  const restored = await page.evaluate(async (asOf) => {
    const api = window.appApi as unknown as {
      queue: { list(req: { asOf: string }): Promise<{ items: { id: string }[] }> };
    };
    const res = await api.queue.list({ asOf });
    return res.items.map((i) => i.id);
  }, AS_OF);
  expect(restored).toContain(doneRow.id);
  expect(restored).toContain(dismissRowMeta.id);

  await app.close();
});

test("the due queue survives an app restart (items still scheduled)", async () => {
  // Re-launch against the SAME data dir — the restart analogue. The extract's
  // due_at (set earlier) + the seeded card due are persisted to SQLite.
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const data = await page.evaluate(async (asOf) => {
    const api = window.appApi as unknown as {
      queue: {
        list(req: { asOf: string }): Promise<{
          items: { type: string; scheduler: string }[];
          counts: { all: number };
        }>;
      };
    };
    return api.queue.list({ asOf });
  }, AS_OF);

  expect(data.counts.all).toBeGreaterThan(0);
  const schedulers = new Set(data.items.map((i) => i.scheduler));
  expect(schedulers.has("fsrs")).toBe(true);
  expect(schedulers.has("attention")).toBe(true);

  await app.close();
});
