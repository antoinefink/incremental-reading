/**
 * Deletion, trash & undo (T044) E2E — drives the real Electron app.
 *
 * Soft-delete + restore + the general command-level undo make nothing the user
 * does irreversible. This spec launches the built desktop app against a fresh data
 * dir seeded with the shared demo collection and asserts:
 *
 *   1. the `trash.*` + `undo.*` bridge surface exists (no raw SQL);
 *   2. deleting a seeded extract (through the typed `queue.act` delete) moves it to
 *      `/trash` (it shows there with its origin context) AND removes it from its
 *      source's children (the lineage tree no longer lists it);
 *   3. Restore from `/trash` returns it to its prior lifecycle status, lineage intact;
 *   4. deleting again then pressing ⌘Z (the global command-level undo) restores it;
 *   5. it SURVIVES AN APP RESTART — a still-trashed item persists in `/trash`, and a
 *      restored element persists out of the trash.
 *
 * The renderer never touches SQLite — every mutation rides the typed `window.appApi`.
 */

import { expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

let dataDir: string;
let baseUrl: string;

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
});

/** Resolve the first seeded element of a given type (via the typed bridge). */
async function findElementId(page: Page, type: string): Promise<string> {
  return page.evaluate(async (t) => {
    const api = window.appApi as unknown as {
      inspector: { list(): Promise<{ elements: { id: string; type: string }[] }> };
    };
    const { elements } = await api.inspector.list();
    const match = elements.find((e) => e.type === t);
    if (!match) throw new Error(`no seeded ${t}`);
    return match.id;
  }, type);
}

/** The owning source id of an element (via the inspector payload). */
async function sourceIdOf(page: Page, elementId: string): Promise<string> {
  return page.evaluate(async (id) => {
    const api = window.appApi as unknown as {
      inspector: {
        get(req: { id: string }): Promise<{
          data: { source: { id: string } | null; element: { id: string; type: string } } | null;
        }>;
      };
    };
    const res = await api.inspector.get({ id });
    const data = res.data;
    if (!data) throw new Error("no inspector data");
    return data.source?.id ?? data.element.id;
  }, elementId);
}

/** The live child ids of a source (via the lineage tree). */
async function childIds(page: Page, sourceId: string): Promise<string[]> {
  return page.evaluate(async (id) => {
    const api = window.appApi as unknown as {
      lineage: {
        get(req: { id: string }): Promise<{ lineage: { nodes: { id: string }[] } | null }>;
      };
    };
    const res = await api.lineage.get({ id });
    return res.lineage?.nodes.map((n) => n.id) ?? [];
  }, sourceId);
}

/** The trash item ids currently in `/trash` (via the typed bridge). */
async function trashIds(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const api = window.appApi as unknown as {
      trash: { list(): Promise<{ items: { id: string }[] }> };
    };
    const { items } = await api.trash.list();
    return items.map((i) => i.id);
  });
}

test("the trash + undo bridge surface exists (no raw SQL)", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;

  const surface = await page.evaluate(() => {
    const api = window.appApi as unknown as {
      trash?: { list?: unknown; restore?: unknown; purge?: unknown; empty?: unknown };
      undo?: { last?: unknown };
      db?: { query?: unknown };
    };
    return {
      hasTrashList: typeof api?.trash?.list === "function",
      hasTrashRestore: typeof api?.trash?.restore === "function",
      hasTrashPurge: typeof api?.trash?.purge === "function",
      hasTrashEmpty: typeof api?.trash?.empty === "function",
      hasUndoLast: typeof api?.undo?.last === "function",
      hasQuery: typeof api?.db?.query === "function",
    };
  });
  expect(surface.hasTrashList).toBe(true);
  expect(surface.hasTrashRestore).toBe(true);
  expect(surface.hasTrashPurge).toBe(true);
  expect(surface.hasTrashEmpty).toBe(true);
  expect(surface.hasUndoLast).toBe(true);
  expect(surface.hasQuery).toBe(false);

  await app.close();
});

test("deleting an extract moves it to Trash + out of its source, then Restore brings it back", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const extractId = await findElementId(page, "extract");
  const sourceId = await sourceIdOf(page, extractId);

  // The extract is a live child of its source before deletion.
  expect(await childIds(page, sourceId)).toContain(extractId);
  expect(await trashIds(page)).not.toContain(extractId);

  // Soft-delete it through the typed queue.act delete (the SAME mutation the UI uses).
  await page.evaluate(async (id) => {
    const api = window.appApi as unknown as {
      queue: { act(req: { id: string; action: { kind: string } }): Promise<unknown> };
    };
    await api.queue.act({ id, action: { kind: "delete" } });
  }, extractId);

  // It is now in the trash and gone from the source's live children.
  expect(await trashIds(page)).toContain(extractId);
  expect(await childIds(page, sourceId)).not.toContain(extractId);

  // The /trash screen lists it with its origin context.
  await page.goto(`${baseUrl}/trash`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("route-trash")).toBeVisible();
  const targetRow = page.locator(`[data-testid="trash-row"][data-id="${extractId}"]`);
  await expect(targetRow).toBeVisible();

  // Restore it from the trash UI.
  await targetRow.getByTestId("trash-restore").click();
  await expect(targetRow).toHaveCount(0);

  // It is back as a live child of its source and out of the trash.
  expect(await childIds(page, sourceId)).toContain(extractId);
  expect(await trashIds(page)).not.toContain(extractId);

  await app.close();
});

test("deleting an element then pressing ⌘Z (global undo) restores it", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const extractId = await findElementId(page, "extract");

  await page.evaluate(async (id) => {
    const api = window.appApi as unknown as {
      queue: { act(req: { id: string; action: { kind: string } }): Promise<unknown> };
    };
    await api.queue.act({ id, action: { kind: "delete" } });
  }, extractId);
  expect(await trashIds(page)).toContain(extractId);

  // Press the global undo (⌘Z on macOS / Ctrl+Z elsewhere). The shell calls
  // appApi.undo.last() and toasts the result.
  await page.goto(`${baseUrl}/queue`);
  await page.waitForLoadState("domcontentloaded");
  await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");

  // The element is restored (out of the trash) and the global undo toast shows.
  await expect(page.getByTestId("shell-undo-snackbar")).toBeVisible();
  await expect.poll(() => trashIds(page)).not.toContain(extractId);

  await app.close();
});

test("the trash list + a restored element survive an app restart", async () => {
  // First launch: delete TWO extracts, restore ONE, leave the other trashed.
  const app1 = await launchApp(dataDir, { seedOnEmpty: true });
  const page1 = await app1.firstWindow();
  await page1.waitForLoadState("domcontentloaded");

  const { trashed, restored } = await page1.evaluate(async () => {
    const api = window.appApi as unknown as {
      inspector: { list(): Promise<{ elements: { id: string; type: string }[] }> };
      queue: { act(req: { id: string; action: { kind: string } }): Promise<unknown> };
      trash: {
        list(): Promise<{ items: { id: string }[] }>;
        restore(req: { id: string }): Promise<unknown>;
      };
    };
    const { elements } = await api.inspector.list();
    const extracts = elements.filter((e) => e.type === "extract");
    if (extracts.length < 2) throw new Error("need ≥2 seeded extracts");
    const a = extracts[0].id;
    const b = extracts[1].id;
    await api.queue.act({ id: a, action: { kind: "delete" } });
    await api.queue.act({ id: b, action: { kind: "delete" } });
    // Restore A; leave B in the trash.
    await api.trash.restore({ id: a });
    return { trashed: b, restored: a };
  });

  // State before restart: B trashed, A restored.
  expect(await trashIds(page1)).toContain(trashed);
  expect(await trashIds(page1)).not.toContain(restored);
  await app1.close();

  // Relaunch against the SAME data dir (no re-seed — the data is on disk).
  const app2 = await launchApp(dataDir);
  const page2 = await app2.firstWindow();
  await page2.waitForLoadState("domcontentloaded");

  // The trash list persisted: B is still trashed, A is still restored (live).
  const after = await trashIds(page2);
  expect(after).toContain(trashed);
  expect(after).not.toContain(restored);

  // The restored extract is live (findById returns it, not soft-deleted).
  const restoredLive = await page2.evaluate(async (id) => {
    const api = window.appApi as unknown as {
      inspector: {
        get(req: { id: string }): Promise<{ data: { element: { status: string } } | null }>;
      };
    };
    const res = await api.inspector.get({ id });
    return res.data?.element.status ?? null;
  }, restored);
  // The inspector hides soft-deleted elements (returns null); a live one has a status.
  expect(restoredLive).not.toBeNull();

  await app2.close();
});
