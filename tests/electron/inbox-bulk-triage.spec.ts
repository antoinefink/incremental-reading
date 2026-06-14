/**
 * Bulk inbox triage E2E (T126 — U7) — drives the REAL Electron app end to end.
 *
 * Capture throughput outruns triage throughput, so the inbox gains multi-select +
 * group-by (origin / domain / type) and a bulk action panel: one triage verb
 * (optionally combined with one priority band) applied to a whole selection as ONE
 * transactional, op-logged batch with a SINGLE undo. This spec proves the whole
 * feature against the built desktop app, through `window.appApi` only (no generic
 * `db.query`, no generic FS), and asserts the non-negotiables:
 *
 *   - the renderer reaches bulk triage ONLY through the typed bridge
 *     (`inbox.bulkTriage` + `inbox.bulkTriageUndo` exist; there is no `db.query`);
 *   - a ~30-item MIXED-ORIGIN inbox groups by origin into header rows with correct
 *     counts (AE-1);
 *   - selecting the large MANUAL group and applying Queue-soon + band B in ONE
 *     combined UI sweep issues exactly ONE bulk batch → every item becomes
 *     `status:"scheduled"`, `dueAt` set, priority band B; the snackbar offers ONE
 *     Undo that restores every preimage (AE-2);
 *   - selecting the HIGHLIGHT-IMPORT group and bulk-parking it sets `status:"parked"`,
 *     `dueAt:null`, `parkedAt` set, priority preserved; a single undo restores the
 *     prior inbox state (AE-3);
 *   - after the sweeps, an APP RESTART preserves the queued/parked states, and the
 *     durable `operation_log` shows ONE `batchId` per sweep with source lineage intact
 *     (AE-5);
 *   - a selection containing a concurrently-moved item skips-and-counts it without
 *     aborting the rest (AE-4);
 *   - a single-item per-item triage still works (no regression).
 *
 * The op-log + lineage assertions read the SQLite file DIRECTLY from the test process
 * (the same boundary-preserving pattern as conversion-session.spec.ts) — the renderer
 * never opens SQLite. The op-log carries the batch tag in the op `payload.batchId`
 * (the `operation_log` table has no batch column), so it is read via `json_extract`.
 *
 * Seeded inbox (empty start, NO demo seed, so the origins are deterministic):
 *   - 24 MANUAL sources via `sources.importManual`        → origin `manual`        (the queued group)
 *   - 2  HIGHLIGHT-IMPORT sources via `sources.importHighlights` (Kindle fixture)
 *                                                          → origin `highlight_import` (the parked group)
 *   - 1  URL source via `sources.importUrl` (loopback fixture, job runner seam)
 *                                                          → origin `url`           (a single-item origin + single-domain group)
 *  = 27 mixed-origin items across THREE distinct origin groups.
 *
 * UI-driven (faithful to the AEs, exercises the renderer): group-by-origin header
 * rows + counts (AE-1), select-group + arm-B + Queue-soon in one sweep (AE-2),
 * select-group + Save-for-later (AE-3), the snackbar Undo for the parked batch.
 * appApi-driven (harder to stage purely through the UI): a single-item per-item
 * triage sanity check, and the partial-success skip-and-count (AE-4, with a
 * concurrently-deleted id in the selection). The op-log `batchId` + lineage
 * assertions read SQLite directly.
 */

import { type AddressInfo, createServer, type Server } from "node:http";
import path from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import Database from "better-sqlite3";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });
// Each leg launches the real Electron app and seeds + sweeps dozens of items through
// the bridge, so give it the generous budget the heavier import specs use.
test.setTimeout(180_000);

/** The committed Kindle clippings fixture → 2 `highlight_import` book sources. */
const HIGHLIGHTS_FIXTURE = path.resolve(
  __dirname,
  "..",
  "..",
  "packages",
  "importers",
  "src",
  "__fixtures__",
  "highlights",
  "MyClippings.txt",
);

/** A tiny loopback article the URL-import seam fetches → ONE `url` source. */
const ARTICLE_PATH = "/bulk-triage-article";
const ARTICLE_TITLE = "Distributed Practice";
const ARTICLE_HTML = `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="utf-8" /><title>${ARTICLE_TITLE}</title></head>
  <body>
    <article>
      <h1>${ARTICLE_TITLE}</h1>
      <p>Spacing study sessions over time beats cramming for durable retention.</p>
      <p>Each successful recall lengthens the optimal next interval.</p>
    </article>
  </body>
</html>`;

const MANUAL_COUNT = 24;

// The numeric priority a band maps to is the MIDPOINT of its quarter of [0,1]
// (`PRIORITY_LABEL_VALUE` in @interleave/core), NOT the lower-bound label threshold.
// Band B → 0.625; band C (the seeded default) → 0.375.
const PRIORITY_B = 0.625;
const PRIORITY_C = 0.375;

let dataDir: string;
let server: Server;
let articleBaseUrl: string;

test.beforeAll(async () => {
  ensureBuilt();
  dataDir = makeDataDir();
  server = createServer((req, res) => {
    if (req.url === ARTICLE_PATH) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(ARTICLE_HTML);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  articleBaseUrl = `http://127.0.0.1:${port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/**
 * Launch the app with loopback URL import permitted (the URL seam fetches from the
 * 127.0.0.1 fixture server, which the SSRF guard otherwise blocks). The highlight
 * import is driven by passing the committed fixture path straight to the bridge (MAIN
 * reads the given path), so no picker stub is needed. No demo seed — the inbox starts
 * empty so the seeded origins are deterministic.
 */
async function launch(): Promise<ElectronApplication> {
  return launchApp(dataDir, { allowLoopbackImport: true });
}

/** Read the current inbox list (id + origin + domain + priority + status) via the bridge. */
async function listInbox(page: Page) {
  return page.evaluate(async () => {
    const api = window.appApi as unknown as {
      inbox: {
        list(): Promise<{
          items: {
            id: string;
            title: string;
            status: string;
            priority: number;
            origin: string | null;
            domain: string | null;
          }[];
        }>;
      };
    };
    const { items } = await api.inbox.list();
    return items;
  });
}

/** Read one element's status / priority / dueAt through the inspector bridge. */
async function inspectElement(page: Page, id: string) {
  return page.evaluate(async (elementId) => {
    const api = window.appApi as unknown as {
      inspector: {
        get(req: { id: string }): Promise<{
          data: {
            element: { id: string; status: string; priority: number; dueAt: string | null };
          } | null;
        }>;
      };
    };
    const { data } = await api.inspector.get({ id: elementId });
    return data?.element ?? null;
  }, id);
}

/**
 * Open the SQLite file directly from the TEST process (never the renderer) to inspect
 * the durable `operation_log`. The batch tag rides in the op `payload.batchId`, so it
 * is read with `json_extract`. Used to prove ONE `batchId` per sweep + lineage.
 */
function readDb<T>(fn: (db: ReturnType<typeof Database>) => T): T {
  const db = new Database(path.join(dataDir, "app.sqlite"), { readonly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/**
 * The distinct `payload.batchId` of each id's MOST-RECENT batch-tagged op — i.e. the
 * batch that LAST swept these ids. The op-log is append-only + durable, so a re-swept
 * id legitimately accumulates several batch tags over its history (across serial test
 * legs sharing the data dir); "one batchId per sweep" (AE-5) means every id in ONE
 * sweep shares ONE batchId, so we read each id's newest batch tag (by insertion
 * `rowid`, the monotonic tiebreaker — a sweep's ops share `created_at`) and return the
 * distinct set. A single sweep over N ids ⇒ exactly one element here.
 */
function latestBatchIdsFor(ids: readonly string[]): string[] {
  if (ids.length === 0) return [];
  return readDb((db) => {
    const placeholders = ids.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT json_extract(payload, '$.batchId') AS batchId
           FROM operation_log o
          WHERE element_id IN (${placeholders})
            AND json_extract(payload, '$.batchId') IS NOT NULL
            AND o.rowid = (
              SELECT MAX(i.rowid)
                FROM operation_log i
               WHERE i.element_id = o.element_id
                 AND json_extract(i.payload, '$.batchId') IS NOT NULL
            )`,
      )
      .all(...ids) as { batchId: string | null }[];
    const distinct = new Set(rows.map((r) => r.batchId).filter((b): b is string => b !== null));
    return [...distinct];
  });
}

test("the inbox bridge exposes inbox.bulkTriage + bulkTriageUndo, not raw SQL", async () => {
  const app = await launch();
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const surface = await page.evaluate(() => {
    const api = window.appApi as unknown as {
      inbox?: { list?: unknown; triage?: unknown; bulkTriage?: unknown; bulkTriageUndo?: unknown };
      db?: { query?: unknown };
    };
    return {
      hasList: typeof api?.inbox?.list === "function",
      hasTriage: typeof api?.inbox?.triage === "function",
      hasBulkTriage: typeof api?.inbox?.bulkTriage === "function",
      hasBulkTriageUndo: typeof api?.inbox?.bulkTriageUndo === "function",
      hasQuery: typeof api?.db?.query === "function",
    };
  });
  expect(surface.hasList).toBe(true);
  expect(surface.hasTriage).toBe(true);
  expect(surface.hasBulkTriage).toBe(true);
  expect(surface.hasBulkTriageUndo).toBe(true);
  // The non-negotiable boundary: no generic SQL escape on the bridge.
  expect(surface.hasQuery).toBe(false);

  await app.close();
});

test("group → bulk-queue (manual, +B, one sweep) → bulk-park (highlights) → single undo", async () => {
  const app = await launch();
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await page.getByTestId("nav-inbox").click();
  await expect(page.getByTestId("route-inbox")).toBeVisible();
  await expect(page.getByTestId("inbox-empty")).toBeVisible();

  // --- Seed a mixed-origin inbox through the bridge (deterministic origins). ---

  // 24 MANUAL sources (origin `manual`) — the large group we bulk-queue at B.
  const manualIds = await page.evaluate(async (count) => {
    const api = window.appApi as unknown as {
      sources: {
        importManual(req: {
          title: string;
          body: string;
          priority?: string;
        }): Promise<{ id: string }>;
      };
    };
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const { id } = await api.sources.importManual({
        title: `Manual capture ${i}`,
        body: `A hand-typed note number ${i} awaiting triage.`,
        priority: "C",
      });
      ids.push(id);
    }
    return ids;
  }, MANUAL_COUNT);
  expect(manualIds).toHaveLength(MANUAL_COUNT);

  // 2 HIGHLIGHT-IMPORT book sources (origin `highlight_import`) — the parked group.
  // MAIN reads + parses the path it is given, so pass the committed Kindle fixture
  // (the test process owns the absolute path; the renderer cannot see Node consts).
  const highlightIds = await page.evaluate(async (fixturePath) => {
    const api = window.appApi as unknown as {
      sources: {
        importHighlights(req: { path: string }): Promise<{ items: { id: string }[] }>;
      };
    };
    const { items } = await api.sources.importHighlights({ path: fixturePath });
    return items.map((it) => it.id);
  }, HIGHLIGHTS_FIXTURE);
  expect(highlightIds.length).toBeGreaterThanOrEqual(2);

  // 1 URL source (origin `url`) — exercises the real URL job-runner seam (the path
  // that writes `captured_via = "url"`). Awaits the terminal import.
  const urlId = await page.evaluate(async (url) => {
    const api = window.appApi as unknown as {
      sources: {
        importUrl(req: { url: string }): Promise<{ status: string; id?: string }>;
      };
    };
    const res = await api.sources.importUrl({ url });
    if (res.status !== "imported" || !res.id)
      throw new Error(`url import not imported: ${res.status}`);
    return res.id;
  }, `${articleBaseUrl}${ARTICLE_PATH}`);
  expect(urlId).toBeTruthy();

  const totalSeeded = MANUAL_COUNT + highlightIds.length + 1;

  // Re-fetch the inbox list so the renderer state reflects every seeded origin.
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await page.getByTestId("nav-inbox").click();
  await expect(page.getByTestId("route-inbox")).toBeVisible();
  await expect(page.getByTestId("inbox-row")).toHaveCount(totalSeeded);

  // The seeded origins are exactly what we expect (manual / highlight_import / url).
  const seededItems = await listInbox(page);
  const originCounts = seededItems.reduce<Record<string, number>>((acc, it) => {
    const key = it.origin ?? "null";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  expect(originCounts.manual).toBe(MANUAL_COUNT);
  expect(originCounts.highlight_import).toBe(highlightIds.length);
  expect(originCounts.url).toBe(1);

  // --- AE-1: group by origin → header rows with correct counts. ---
  // `origin` is the default group-by axis; assert it is armed, then assert the
  // Manual + Highlight import + URL group headers with their counts.
  await expect(page.getByTestId("inbox-group-by-origin")).toHaveAttribute("aria-pressed", "true");

  const groupCountByLabel = async (label: string) => {
    const group = page
      .getByTestId("inbox-group")
      .filter({ has: page.getByTestId("inbox-group-label").filter({ hasText: label }) });
    await expect(group).toHaveCount(1);
    return group.getByTestId("inbox-group-count").innerText();
  };
  expect(await groupCountByLabel("Manual")).toBe(String(MANUAL_COUNT));
  expect(await groupCountByLabel("Highlight import")).toBe(String(highlightIds.length));
  expect(await groupCountByLabel("URL")).toBe("1");

  // --- AE-2: select the MANUAL group, arm band B, fire Queue soon in ONE sweep. ---
  const manualGroup = page
    .getByTestId("inbox-group")
    .filter({ has: page.getByTestId("inbox-group-label").filter({ hasText: "Manual" }) });
  await manualGroup.getByTestId("inbox-select-group").click();

  // size >= 2 → the bulk panel REPLACES the preview pane, with the count headline.
  await expect(page.getByTestId("inbox-bulk-panel")).toBeVisible();
  await expect(page.getByTestId("inbox-bulk-headline")).toHaveText(`${MANUAL_COUNT} selected`);

  // Arm band B (a pure toggle — fires no batch on its own), then Queue soon. The verb
  // carries the armed band, so this is ONE combined `inbox:bulkTriage` batch (AE-2).
  await page.getByTestId("inbox-bulk-priority-B").click();
  await expect(page.getByTestId("inbox-bulk-priority-B")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("inbox-bulk-queue-soon").click();

  // The snackbar reports the honest result + offers a single Undo.
  await expect(page.getByTestId("inbox-snackbar")).toContainText(`Queued ${MANUAL_COUNT}`);
  await expect(page.getByTestId("inbox-snackbar-undo")).toBeVisible();

  // The manual group left the inbox; the highlight + URL groups remain.
  await expect(page.getByTestId("inbox-row")).toHaveCount(highlightIds.length + 1);

  // Every queued manual item is now `scheduled`, due, at band B (priority 0.625).
  for (const id of manualIds) {
    const el = await inspectElement(page, id);
    expect(el).toMatchObject({ id, status: "scheduled" });
    expect(el?.dueAt).not.toBeNull();
    expect(el?.priority).toBeCloseTo(PRIORITY_B, 5);
  }

  // ONE batchId tags the whole queue sweep across all 24 manual items.
  const queueBatchIds = latestBatchIdsFor(manualIds);
  expect(queueBatchIds).toHaveLength(1);
  const queueBatchId = queueBatchIds[0] as string;

  // --- AE-2 undo: the snackbar Undo reverses exactly that batch (preimages restored). ---
  await page.getByTestId("inbox-snackbar-undo").click();
  // The manual group is restored to the inbox; the full seeded set is back.
  await expect(page.getByTestId("inbox-row")).toHaveCount(totalSeeded);
  for (const id of manualIds) {
    const el = await inspectElement(page, id);
    expect(el).toMatchObject({ id, status: "inbox" });
    expect(el?.dueAt).toBeNull();
    // The combined B priority was reversed too — back to the seeded C (0.375).
    expect(el?.priority).toBeCloseTo(PRIORITY_C, 5);
  }
  // The restored manual items are back in the (newest-first) inbox list.
  const afterUndo = await listInbox(page);
  expect(afterUndo.filter((it) => it.status === "inbox").length).toBe(totalSeeded);

  // --- AE-3: select the HIGHLIGHT-IMPORT group, bulk-park it (Save for later). ---
  const highlightGroup = page
    .getByTestId("inbox-group")
    .filter({ has: page.getByTestId("inbox-group-label").filter({ hasText: "Highlight import" }) });
  await highlightGroup.getByTestId("inbox-select-group").click();
  await expect(page.getByTestId("inbox-bulk-panel")).toBeVisible();
  await expect(page.getByTestId("inbox-bulk-headline")).toHaveText(
    `${highlightIds.length} selected`,
  );

  // Capture the highlight items' prior priority so we can prove park preserves it.
  const priorPriorityById = new Map<string, number>();
  for (const id of highlightIds) {
    const el = await inspectElement(page, id);
    if (el) priorPriorityById.set(id, el.priority);
  }

  await page.getByTestId("inbox-bulk-keep").click();
  await expect(page.getByTestId("inbox-snackbar")).toContainText(
    `Saved for later ${highlightIds.length}`,
  );
  // The highlight group left the inbox; the restored manual group + URL remain.
  await expect(page.getByTestId("inbox-row")).toHaveCount(MANUAL_COUNT + 1);

  // Every parked item: `parked`, no due date, priority preserved.
  const parkedRows = readDb((db) =>
    highlightIds.map((id) => {
      const row = db
        .prepare(
          "SELECT status, due_at AS dueAt, parked_at AS parkedAt, priority FROM elements WHERE id = ?",
        )
        .get(id) as {
        status: string;
        dueAt: string | null;
        parkedAt: string | null;
        priority: number;
      };
      return { id, ...row };
    }),
  );
  for (const row of parkedRows) {
    expect(row.status).toBe("parked");
    expect(row.dueAt).toBeNull();
    expect(row.parkedAt).not.toBeNull();
    expect(row.priority).toBeCloseTo(priorPriorityById.get(row.id) ?? -1, 5);
  }

  // ONE batchId tags the whole park sweep.
  const parkBatchIds = latestBatchIdsFor(highlightIds);
  expect(parkBatchIds).toHaveLength(1);
  expect(parkBatchIds[0]).not.toBe(queueBatchId); // a distinct sweep ⇒ a distinct batch

  // --- AE-3 undo: the snackbar Undo restores the parked group to the inbox. ---
  await page.getByTestId("inbox-snackbar-undo").click();
  await expect(page.getByTestId("inbox-row")).toHaveCount(totalSeeded);
  for (const id of highlightIds) {
    const el = await inspectElement(page, id);
    expect(el).toMatchObject({ id, status: "inbox" });
    expect(el?.dueAt).toBeNull();
  }

  await app.close();
});

test("re-park + re-queue persist across an app restart; op-log shows one batchId per sweep", async () => {
  // The previous leg undid both sweeps (everything is back in the inbox). Re-apply a
  // durable queue sweep (manual) + a park sweep (highlights) — this time WITHOUT undo —
  // then restart and prove the states + op-log batches survived (AE-5).
  const app = await launch();
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await page.getByTestId("nav-inbox").click();
  await expect(page.getByTestId("route-inbox")).toBeVisible();

  // Re-derive the seeded ids from the live inbox by origin (the prior leg restored all).
  const items = await listInbox(page);
  const manualIds = items.filter((it) => it.origin === "manual").map((it) => it.id);
  const highlightIds = items.filter((it) => it.origin === "highlight_import").map((it) => it.id);
  const urlId = items.find((it) => it.origin === "url")?.id;
  expect(manualIds).toHaveLength(MANUAL_COUNT);
  expect(highlightIds.length).toBeGreaterThanOrEqual(2);
  expect(urlId).toBeTruthy();

  // Bulk-queue the manual group at B (one combined sweep) via the UI.
  const manualGroup = page
    .getByTestId("inbox-group")
    .filter({ has: page.getByTestId("inbox-group-label").filter({ hasText: "Manual" }) });
  await manualGroup.getByTestId("inbox-select-group").click();
  await expect(page.getByTestId("inbox-bulk-panel")).toBeVisible();
  await page.getByTestId("inbox-bulk-priority-B").click();
  await page.getByTestId("inbox-bulk-queue-soon").click();
  await expect(page.getByTestId("inbox-snackbar")).toContainText(`Queued ${MANUAL_COUNT}`);
  await expect(page.getByTestId("inbox-row")).toHaveCount(highlightIds.length + 1);

  // Bulk-park the highlight group (one sweep) via the UI.
  const highlightGroup = page
    .getByTestId("inbox-group")
    .filter({ has: page.getByTestId("inbox-group-label").filter({ hasText: "Highlight import" }) });
  await highlightGroup.getByTestId("inbox-select-group").click();
  await expect(page.getByTestId("inbox-bulk-panel")).toBeVisible();
  await page.getByTestId("inbox-bulk-keep").click();
  await expect(page.getByTestId("inbox-snackbar")).toContainText(
    `Saved for later ${highlightIds.length}`,
  );
  await expect(page.getByTestId("inbox-row")).toHaveCount(1); // only the URL source left

  // ONE batchId per sweep, BEFORE the restart (durable in the op-log already).
  const queueBatch = latestBatchIdsFor(manualIds);
  const parkBatch = latestBatchIdsFor(highlightIds);
  expect(queueBatch).toHaveLength(1);
  expect(parkBatch).toHaveLength(1);
  expect(queueBatch[0]).not.toBe(parkBatch[0]);

  await app.close();

  // --- AE-5: relaunch against the SAME data dir; the states survived. ---
  const app2 = await launch();
  const page2 = await app2.firstWindow();
  await page2.waitForLoadState("domcontentloaded");
  await page2.getByTestId("nav-inbox").click();
  await expect(page2.getByTestId("route-inbox")).toBeVisible();
  // Only the URL source is still inbox-status after restart.
  await expect(page2.getByTestId("inbox-row")).toHaveCount(1);

  const afterRestart = await listInbox(page2);
  expect(afterRestart).toHaveLength(1);
  expect(afterRestart[0]?.id).toBe(urlId);

  // The queued manual items are still `scheduled` + due + band B; the parked highlight
  // items are still `parked` + no due date — durable across the restart.
  for (const id of manualIds) {
    const el = await inspectElement(page2, id);
    expect(el).toMatchObject({ id, status: "scheduled" });
    expect(el?.dueAt).not.toBeNull();
    expect(el?.priority).toBeCloseTo(PRIORITY_B, 5);
  }
  for (const id of highlightIds) {
    const el = await inspectElement(page2, id);
    expect(el).toMatchObject({ id, status: "parked" });
    expect(el?.dueAt).toBeNull();
  }

  // The op-log STILL shows exactly ONE batchId per sweep after the restart (AE-5).
  const queueBatchAfter = latestBatchIdsFor(manualIds);
  const parkBatchAfter = latestBatchIdsFor(highlightIds);
  expect(queueBatchAfter).toHaveLength(1);
  expect(parkBatchAfter).toHaveLength(1);
  expect(queueBatchAfter[0]).toBe(queueBatch[0]);
  expect(parkBatchAfter[0]).toBe(parkBatch[0]);

  // Source lineage is intact: the parked highlight book sources still own their child
  // extracts (the highlight import authored extracts under each book) AND those
  // extracts' source_locations still point back into the source element — provenance
  // survives the bulk sweeps + the restart.
  const lineage = readDb((db) => {
    const placeholders = highlightIds.map(() => "?").join(",");
    const childCounts = db
      .prepare(
        `SELECT parent_id AS parentId, COUNT(*) AS n
           FROM elements
          WHERE parent_id IN (${placeholders}) AND type = 'extract' AND deleted_at IS NULL
          GROUP BY parent_id`,
      )
      .all(...highlightIds) as { parentId: string; n: number }[];
    const locBackrefs = db
      .prepare(
        `SELECT COUNT(*) AS n
           FROM source_locations
          WHERE source_element_id IN (${placeholders})`,
      )
      .get(...highlightIds) as { n: number };
    return { childCounts, locBackrefs: locBackrefs.n };
  });
  // The Kindle fixture authored ≥3 extracts across the 2 books — every book retains ≥1
  // child extract, and the source_locations still back-reference the source elements.
  const totalChildExtracts = lineage.childCounts.reduce((sum, r) => sum + r.n, 0);
  expect(totalChildExtracts).toBeGreaterThanOrEqual(highlightIds.length);
  expect(lineage.locBackrefs).toBeGreaterThanOrEqual(highlightIds.length);

  await app2.close();
});

test("partial success: a selection with a concurrently-deleted id skips-and-counts it", async () => {
  // AE-4 (skip-and-count): per-item delete one URL-ish item, then include its stale id
  // in a bulk selection → the batch applies to the live rest and REPORTS the skip with
  // the `deleted` reason, without aborting. Staging a true concurrent mutation purely
  // through the UI is awkward, so this leg drives `appApi.bulkTriageInbox` directly
  // (the documented escape) while still proving the live-rest applies.
  const app = await launch();
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await page.getByTestId("nav-inbox").click();
  await expect(page.getByTestId("route-inbox")).toBeVisible();

  // Seed two fresh manual inbox items (the prior legs left only a parked/scheduled set
  // + the URL source). One we delete per-item; the other stays live.
  const { staleId, liveId } = await page.evaluate(async () => {
    const api = window.appApi as unknown as {
      sources: {
        importManual(req: { title: string; body: string }): Promise<{ id: string }>;
      };
      inbox: {
        triage(req: { id: string; action: { kind: "delete" } }): Promise<{ deleted: boolean }>;
      };
    };
    const stale = await api.sources.importManual({
      title: "Concurrently deleted",
      body: "This item is deleted per-item before the bulk sweep includes it.",
    });
    const live = await api.sources.importManual({
      title: "Survives the bulk sweep",
      body: "This live item is queued by the partial-success batch.",
    });
    // Per-item delete the stale one (a single-item triage — also the no-regression check).
    const res = await api.inbox.triage({ id: stale.id, action: { kind: "delete" } });
    if (!res.deleted) throw new Error("per-item delete did not soft-delete the stale item");
    return { staleId: stale.id, liveId: live.id };
  });

  // Bulk-queue BOTH ids: the deleted one must be skipped (`deleted`), the live one applied.
  const result = await page.evaluate(
    async ({ stale, live }) => {
      const api = window.appApi as unknown as {
        inbox: {
          bulkTriage(req: { ids: string[]; action: string }): Promise<{
            batchId: string;
            applied: number;
            skipped: { id: string; reason: string }[];
            errored: { id: string; error: string }[];
          }>;
        };
      };
      return api.inbox.bulkTriage({ ids: [stale, live], action: "queueSoon" });
    },
    { stale: staleId, live: liveId },
  );

  // The batch did NOT abort: the live item applied, the stale one is skipped + counted.
  expect(result.applied).toBe(1);
  expect(result.errored).toHaveLength(0);
  expect(result.skipped).toHaveLength(1);
  expect(result.skipped[0]).toMatchObject({ id: staleId, reason: "deleted" });

  // The live item really was queued; the stale one stayed soft-deleted (single-item
  // per-item triage worked — the no-regression sanity check).
  const live = await inspectElement(page, liveId);
  expect(live).toMatchObject({ id: liveId, status: "scheduled" });
  expect(live?.dueAt).not.toBeNull();
  const staleStatus = readDb((db) => {
    const row = db
      .prepare("SELECT deleted_at AS deletedAt FROM elements WHERE id = ?")
      .get(staleId) as { deletedAt: string | null } | undefined;
    return row?.deletedAt ?? null;
  });
  expect(staleStatus).not.toBeNull();

  await app.close();
});
