/**
 * Mark-processed E2E (T026) — drives the real Electron app.
 *
 * Marking a paragraph "processed" DIMS it (`.dimmed`) so the user can declutter a
 * long source WITHOUT deleting any content. A processed span is a lightweight,
 * REVERSIBLE reading annotation persisted as a `document_marks` row
 * (`markType: "processed_span"`, a STABLE block id + range) — NOT an extract, NOT an
 * element, NOT lineage — reusing the SAME T020 `documents.marks.*` bridge. This spec
 * launches the BUILT desktop app against a fresh seeded data dir and proves the full
 * T026 round-trip:
 *
 *   (a) MARK PROCESSED: clicking a paragraph's "mark processed" button dims the
 *       block (`.dimmed`) and creates exactly one `processed_span` `document_marks`
 *       row (and NO new element — it is an annotation), WITHOUT deleting the body
 *       text (the paragraph's text is still present);
 *   (b) RELOAD: reopening the route still shows the block dimmed (loaded from
 *       `documents.marks.list`);
 *   (c) RESTART: relaunching the Electron app against the same data dir still shows
 *       the dimmed block — it survives an app restart (the DoD bar) and the source
 *       body is intact;
 *   (d) RESTORE: clicking the (now restore) button deletes the `document_marks` row,
 *       the dimming is gone, and the text is unchanged — fully reversible.
 *
 * It reuses the shared seeded source ("On the Measure of Intelligence") and the same
 * launch/route helpers as the T018/T019/T020 reader specs.
 */

import { expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

let dataDir: string;
let baseUrl: string;
let sourceId: string;

// A seeded body paragraph (the shared fixture's blocks include this stable id).
const BLOCK_ID = "blk_intro_p1";

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
});

/** Resolve the seeded article source id via the bridge. */
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
  // The per-paragraph overlay needs the editor measured before the test interacts.
  await expect(page.getByTestId("processed-overlay")).toBeAttached();
}

/** Count `processed_span` document_marks rows for the source via the bridge. */
async function processedCount(page: Page, id: string): Promise<number> {
  return page.evaluate(async (elementId) => {
    const api = window.appApi as unknown as {
      documents: {
        marks: {
          list(req: { elementId: string; markType?: string }): Promise<{ marks: { id: string }[] }>;
        };
      };
    };
    const { marks } = await api.documents.marks.list({ elementId, markType: "processed_span" });
    return marks.length;
  }, id);
}

/** Read the seeded paragraph's text from the document body via the bridge. */
async function blockText(page: Page, id: string, blockId: string): Promise<string> {
  return page.evaluate(
    async ({ elementId, targetBlockId }) => {
      const api = window.appApi as unknown as {
        documents: {
          get(req: { elementId: string }): Promise<{
            document: { prosemirrorJson: { content?: unknown[] } } | null;
          }>;
        };
      };
      const { document } = await api.documents.get({ elementId });
      const content = (document?.prosemirrorJson?.content ?? []) as {
        attrs?: { blockId?: string };
        content?: { text?: string }[];
      }[];
      const block = content.find((b) => b.attrs?.blockId === targetBlockId);
      return (block?.content ?? []).map((t) => t.text ?? "").join("");
    },
    { elementId: id, targetBlockId: blockId },
  );
}

/** Count live source elements via the bridge (to prove marking makes none). */
async function sourceElementCount(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const api = window.appApi as unknown as {
      inspector: { list(): Promise<{ elements: { type: string }[] }> };
    };
    const { elements } = await api.inspector.list();
    return elements.filter((e) => e.type === "source").length;
  });
}

/** The dimmed paragraph block (a node decoration applies `.dimmed` + the mark id). */
function dimmedBlock(page: Page) {
  return page.locator(".reader .ProseMirror p.dimmed[data-processed-mark-id]");
}

test("marking processed dims a paragraph, persists, survives restart, and is reversible", async () => {
  // (a) MARK PROCESSED.
  let app = await launchApp(dataDir, { seedOnEmpty: true });
  let page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;
  sourceId = await resolveSourceId(page);
  await openReader(page, sourceId);

  const sourcesBefore = await sourceElementCount(page);
  const textBefore = await blockText(page, sourceId, BLOCK_ID);
  expect(textBefore.trim().length).toBeGreaterThan(0);
  expect(await processedCount(page, sourceId)).toBe(0);

  // Click the paragraph's "mark processed (dim)" button.
  await page.getByTestId(`processed-toggle-${BLOCK_ID}`).click();
  await expect(page.getByText("Marked processed")).toBeVisible();
  await expect.poll(() => processedCount(page, sourceId)).toBe(1);
  // The block is now dimmed, exactly one processed row, NO new element, body intact.
  await expect(dimmedBlock(page).first()).toBeVisible();
  expect(await sourceElementCount(page)).toBe(sourcesBefore);
  expect(await blockText(page, sourceId, BLOCK_ID)).toBe(textBefore);

  // (b) RELOAD: the dimming is still there after navigating away + back.
  await page.goto(`${baseUrl}/queue`);
  await openReader(page, sourceId);
  await expect(dimmedBlock(page).first()).toBeVisible();
  expect(await processedCount(page, sourceId)).toBe(1);

  // (c) RESTART: relaunch the app against the same data dir — dimming survives and
  // the source body is unchanged (never destroyed).
  await app.close();
  app = await launchApp(dataDir);
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await openReader(page, sourceId);
  await expect(dimmedBlock(page).first()).toBeVisible();
  expect(await processedCount(page, sourceId)).toBe(1);
  expect(await blockText(page, sourceId, BLOCK_ID)).toBe(textBefore);

  // (d) RESTORE: clicking the restore button removes the dimming; after a reload the
  // block is back to normal and the row is gone — fully reversible.
  await page.getByTestId(`processed-toggle-${BLOCK_ID}`).click();
  await expect(page.getByText("Restored")).toBeVisible();
  await expect.poll(() => processedCount(page, sourceId)).toBe(0);
  await page.goto(`${baseUrl}/queue`);
  await openReader(page, sourceId);
  await expect(dimmedBlock(page)).toHaveCount(0);
  expect(await processedCount(page, sourceId)).toBe(0);
  expect(await blockText(page, sourceId, BLOCK_ID)).toBe(textBefore);

  await app.close();
});
