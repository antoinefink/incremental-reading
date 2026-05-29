/**
 * Document editor persistence E2E (T015) — drives the real Electron app.
 *
 * The T018 reader UI (the `/source/$id` page that drops the Tiptap editor in) is
 * built later; T015's guarantee is the persistence PATH: a source body saved
 * through `window.appApi.documents.save` (→ `DocumentRepository.upsert`, logging
 * `update_document`) reloads byte-for-byte through `documents.get`, and survives
 * a full app restart. This spec exercises exactly that round-trip through the
 * real bridge + native SQLite, with no raw DB/Node/fs access in the renderer.
 *
 * It asserts:
 *   1. the `documents.{get,save}` bridge surface exists (and no generic
 *      `db.query` was added);
 *   2. a created source's body can be replaced with edited ProseMirror JSON +
 *      plain text and read back IDENTICALLY in the same session;
 *   3. after a full Electron restart against the same data dir, the edited body
 *      is still there (the Definition-of-Done restart requirement).
 */

import { expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

interface DocumentPayload {
  prosemirrorJson: unknown;
  plainText: string;
  schemaVersion: number;
  updatedAt: string;
}

/** Minimal mirror of the bridge surface the in-renderer closures touch. */
interface RendererAppApi {
  sources: { importManual(req: { title: string; body?: string }): Promise<{ id: string }> };
  documents: {
    get(req: { elementId: string }): Promise<{ document: DocumentPayload | null }>;
    save(req: {
      elementId: string;
      prosemirrorJson: unknown;
      plainText: string;
      schemaVersion?: number;
    }): Promise<{ document: DocumentPayload }>;
  };
}
declare global {
  interface Window {
    appApi?: RendererAppApi;
  }
}

test.describe.configure({ mode: "serial" });

let dataDir: string;
/** The source element id created in the first test, reused across the restart. */
let sourceId: string;

/** The edited ProseMirror body the test saves + expects back after restart. */
const editedJson = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Edited title" }] },
    {
      type: "paragraph",
      content: [
        { type: "text", text: "edited ", marks: [{ type: "bold" }] },
        { type: "text", text: "body" },
      ],
    },
  ],
};
const editedPlainText = "Edited title\nedited body";

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
});

/** Evaluate a fn in the renderer's main world (where `window.appApi` lives). */
async function inRenderer<T>(page: Page, fn: () => Promise<T> | T): Promise<T> {
  return page.evaluate(fn);
}

test("documents.{get,save} exist on the bridge and there is no generic db.query", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const surface = await inRenderer(page, () => {
    const api = window.appApi;
    return {
      hasGet: typeof api?.documents?.get === "function",
      hasSave: typeof api?.documents?.save === "function",
      // biome-ignore lint/suspicious/noExplicitAny: probing for a forbidden method
      hasQuery: typeof (api as any)?.db?.query === "function",
    };
  });
  expect(surface.hasGet).toBe(true);
  expect(surface.hasSave).toBe(true);
  expect(surface.hasQuery).toBe(false);

  await app.close();
});

test("editing a source body saves and reloads identically in the same session", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const result = await page.evaluate(
    async ({ json, plain }) => {
      const api = window.appApi;
      if (!api) throw new Error("no appApi");
      // Create a source with an initial body.
      const created = await api.sources.importManual({
        title: "Editable source",
        body: "Original first paragraph.\n\nOriginal second paragraph.",
      });
      // Replace the body with edited ProseMirror JSON + plain text.
      await api.documents.save({ elementId: created.id, prosemirrorJson: json, plainText: plain });
      // Reload it through the bridge.
      const reloaded = await api.documents.get({ elementId: created.id });
      return { id: created.id, doc: reloaded.document };
    },
    { json: editedJson, plain: editedPlainText },
  );

  sourceId = result.id;
  expect(sourceId).toBeTruthy();
  expect(result.doc).not.toBeNull();
  expect(result.doc?.prosemirrorJson).toEqual(editedJson);
  expect(result.doc?.plainText).toBe(editedPlainText);
  expect(result.doc?.schemaVersion).toBe(1);

  await app.close();
});

test("the edited body survives a full app restart", async () => {
  // A brand-new Electron process, SAME data dir → the edit persists.
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const persisted = await page.evaluate(async (id: string) => {
    const api = window.appApi;
    if (!api) throw new Error("no appApi");
    const r = await api.documents.get({ elementId: id });
    return r.document;
  }, sourceId);

  expect(persisted).not.toBeNull();
  expect(persisted?.prosemirrorJson).toEqual(editedJson);
  expect(persisted?.plainText).toBe(editedPlainText);

  await app.close();
});
