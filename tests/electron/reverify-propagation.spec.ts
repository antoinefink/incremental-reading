/**
 * T123 — Stale propagation through the lineage DAG (E2E).
 *
 * "Source lineage is sacred" — but the dirty bit must flow FORWARD. When a source
 * block is edited, the live extracts/cards derived from it must gain a queryable
 * "this might no longer match its source" flag, atomically, surviving a restart, and
 * clearing when the content is restored. This spec drives the BUILT desktop app
 * against a fresh seeded data dir and proves the full round-trip through the real
 * bridge (`documents.save` → block reconciliation → propagation):
 *
 *   (a) EDIT → FLAG: extracting a paragraph then editing that block's text flags the
 *       derived extract (`scheduler.needsReverify`) and bumps the source's
 *       `blockProcessing.summary.needsReverifyOutputs`;
 *   (b) RESTART: relaunching against the same data dir still shows the flag (it is
 *       durable, op-logged content staleness, not in-memory);
 *   (c) RESTORE: saving the original block text back clears the flag everywhere.
 *
 * It edits the INTRO paragraph (`blk_intro_p1`) so it never collides with the seed's
 * existing extract (anchored at `blk_def_p1`).
 */

import { expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

let dataDir: string;
let baseUrl: string;
let sourceId: string;

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
});

async function resolveSourceId(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const api = window.appApi as unknown as {
      inspector: { list(): Promise<{ elements: { id: string; type: string; title: string }[] }> };
    };
    const { elements } = await api.inspector.list();
    const source = elements.find(
      (e) => e.type === "source" && e.title === "On the Measure of Intelligence",
    );
    if (!source) throw new Error("seeded source not found");
    return source.id;
  });
}

async function openReader(page: Page, id: string): Promise<void> {
  await page.goto(`${baseUrl}/source/${id}`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("reader-title")).toBeVisible();
  await expect(page.locator(".reader .ProseMirror")).toBeVisible();
}

async function selectBlockText(page: Page, blockId: string): Promise<string> {
  const block = page.locator(`.reader [data-block-id="${blockId}"]`);
  await block.click({ clickCount: 3 });
  return page.evaluate(() => window.getSelection()?.toString() ?? "");
}

/** The source's extract-child ids, via the bridge. */
async function extractChildIds(page: Page): Promise<string[]> {
  return page.evaluate(async (elementId) => {
    const api = window.appApi as unknown as {
      inspector: {
        get(req: { id: string }): Promise<{
          data: { children: { id: string; type: string }[] } | null;
        }>;
      };
    };
    const { data } = await api.inspector.get({ id: elementId });
    return (data?.children ?? []).filter((c) => c.type === "extract").map((c) => c.id);
  }, sourceId);
}

/** Extract the intro paragraph and return the id of the resulting extract element. */
async function extractIntroParagraph(page: Page): Promise<string> {
  const before = await extractChildIds(page);
  const selected = await selectBlockText(page, "blk_intro_p1");
  expect(selected.trim().length).toBeGreaterThanOrEqual(3);
  await expect(page.getByTestId("selection-toolbar")).toBeVisible();
  await page.getByTestId("sel-tool-extract").click();
  await expect.poll(async () => (await extractChildIds(page)).length).toBe(before.length + 1);
  const after = await extractChildIds(page);
  const created = after.find((id) => !before.includes(id));
  if (!created) throw new Error("no new extract child created");
  return created;
}

interface DocPayload {
  readonly prosemirrorJson: unknown;
  readonly plainText: string;
  readonly schemaVersion: number;
}

/** Fetch the source document payload (so the original can be restored verbatim later). */
async function getSourceDoc(page: Page): Promise<DocPayload> {
  return page.evaluate(async (elementId) => {
    const api = window.appApi as unknown as {
      documents: {
        get(req: { elementId: string }): Promise<{ document: DocPayload | null }>;
      };
    };
    const { document } = await api.documents.get({ elementId });
    if (!document) throw new Error("source document not found");
    return document;
  }, sourceId);
}

/**
 * Save a document payload verbatim through the REAL `documents.save` → reconcile →
 * propagation path. Omits `blocks` so the stable block ids extracts anchor to are
 * preserved by the main side. Restoring the captured original payload returns the
 * edited block's content hash to its pre-stale value (driving the un-stale clear).
 */
async function saveSourceDoc(page: Page, doc: DocPayload): Promise<void> {
  await page.evaluate(
    async ({ elementId, payload }) => {
      const api = window.appApi as unknown as {
        documents: {
          save(req: {
            elementId: string;
            prosemirrorJson: unknown;
            plainText: string;
            schemaVersion?: number;
          }): Promise<unknown>;
        };
      };
      await api.documents.save({
        elementId,
        prosemirrorJson: payload.prosemirrorJson,
        plainText: payload.plainText,
        schemaVersion: payload.schemaVersion,
      });
    },
    { elementId: sourceId, payload: doc },
  );
}

/** Return a copy of `doc` with `blk_intro_p1`'s text replaced by `newText`. */
function withEditedIntro(doc: DocPayload, newText: string): DocPayload {
  const clone = JSON.parse(JSON.stringify(doc.prosemirrorJson)) as { content?: unknown[] };
  const visit = (node: { attrs?: { blockId?: unknown }; content?: unknown[] }): void => {
    if (node?.attrs?.blockId === "blk_intro_p1") {
      node.content = [{ type: "text", text: newText }];
      return;
    }
    for (const child of node?.content ?? []) visit(child as never);
  };
  visit(clone as never);
  return { ...doc, prosemirrorJson: clone };
}

/** Read `scheduler.needsReverify` for an element via the inspector bridge. */
async function inspectNeedsReverify(page: Page, id: string): Promise<boolean> {
  return page.evaluate(async (elementId) => {
    const api = window.appApi as unknown as {
      inspector: {
        get(req: { id: string }): Promise<{
          data: { scheduler: { needsReverify?: boolean } } | null;
        }>;
      };
    };
    const { data } = await api.inspector.get({ id: elementId });
    return data?.scheduler.needsReverify === true;
  }, id);
}

/** The source's count of derived outputs needing re-verify, via the bridge. */
async function reverifyOutputCount(page: Page, id: string): Promise<number> {
  return page.evaluate(async (elementId) => {
    const api = window.appApi as unknown as {
      blockProcessing: {
        summary(req: { sourceElementId: string }): Promise<{
          summary: { needsReverifyOutputs: number };
        }>;
      };
    };
    const { summary } = await api.blockProcessing.summary({ sourceElementId: elementId });
    return summary.needsReverifyOutputs;
  }, id);
}

test("editing a source block flags its derived extract, survives restart, and clears on restore", async () => {
  // (a) SETUP: extract the intro paragraph, then edit that block's text.
  let app = await launchApp(dataDir, { seedOnEmpty: true });
  let page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  baseUrl = (() => {
    const url = new URL(page.url());
    return `${url.protocol}//${url.host}`;
  })();
  sourceId = await resolveSourceId(page);
  await openReader(page, sourceId);

  const extractId = await extractIntroParagraph(page);
  expect(await inspectNeedsReverify(page, extractId)).toBe(false);
  expect(await reverifyOutputCount(page, sourceId)).toBe(0);

  // Capture the ORIGINAL document so it can be restored verbatim later (the block hash
  // must return to its pre-stale value to drive the un-stale clear).
  const originalDoc = await getSourceDoc(page);

  // EDIT → FLAG: rewriting the anchored block content stales it and flags the extract.
  await saveSourceDoc(
    page,
    withEditedIntro(
      originalDoc,
      "This intro paragraph has been substantially rewritten since extraction.",
    ),
  );
  await expect.poll(() => inspectNeedsReverify(page, extractId)).toBe(true);
  await expect.poll(() => reverifyOutputCount(page, sourceId)).toBeGreaterThanOrEqual(1);

  // (b) RESTART: the content-staleness flag is durable.
  await app.close();
  app = await launchApp(dataDir);
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  baseUrl = (() => {
    const url = new URL(page.url());
    return `${url.protocol}//${url.host}`;
  })();
  expect(await inspectNeedsReverify(page, extractId)).toBe(true);
  expect(await reverifyOutputCount(page, sourceId)).toBeGreaterThanOrEqual(1);

  // (c) RESTORE: saving the ORIGINAL document back returns the block to its pre-stale
  // content hash, which clears the derived flag everywhere it showed.
  await saveSourceDoc(page, originalDoc);
  await expect.poll(() => inspectNeedsReverify(page, extractId)).toBe(false);
  await expect.poll(() => reverifyOutputCount(page, sourceId)).toBe(0);

  await app.close();
});
