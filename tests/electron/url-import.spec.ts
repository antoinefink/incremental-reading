/**
 * Automatic URL import E2E (T060) — drives the real Electron app against a LOCAL
 * fixture HTTP server (no live network).
 *
 * The test starts a tiny Node `http` server serving a known article HTML, pastes
 * its URL into the inbox "Import from URL" affordance, and proves the whole
 * local-first pipeline end to end:
 *
 *   1. the renderer reaches import ONLY through `window.appApi.sources.importUrl`
 *      (no generic `db.query`);
 *   2. pasting the URL fetches + cleans + snapshots the page MAIN-side and lands
 *      an `inbox` source whose body + provenance (originalUrl / canonicalUrl /
 *      accessedAt / snapshotKey) are stored, with article images downloaded into
 *      the local vault and referenced through `article-image://`;
 *   3. after an APP RESTART against the same data dir, the source, its provenance,
 *      its body, both snapshots, and its downloaded image files survive.
 *
 * NOTE: the fixture server binds 127.0.0.1, which the SSRF guard normally blocks —
 * the test sets INTERLEAVE_ALLOW_LOOPBACK_IMPORT=1 so the guard permits loopback
 * for the E2E (production keeps it blocked). See main/url-import-service.ts.
 */

import fs from "node:fs";
import { type AddressInfo, createServer, type Server } from "node:http";
import path from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

const ARTICLE_PATH = "/spacing";
const FIGURE_PATH = "/figures/spacing.png";
const ARTICLE_TITLE = "The Spacing Effect";
const FIGURE_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x73, 0x70, 0x61, 0x63, 0x69, 0x6e, 0x67,
]);
const ARTICLE_HTML = `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="utf-8" /><title>${ARTICLE_TITLE} — A Guide</title></head>
  <body>
    <header><nav>Home · About</nav></header>
    <article>
      <h1>${ARTICLE_TITLE}</h1>
      <p class="byline" rel="author">By Hermann Ebbinghaus</p>
      <p>Spaced repetition exploits the spacing effect: information is retained far better
         when study sessions are distributed over time rather than crammed into a block.</p>
      <p>After each successful recall the optimal interval lengthens, because the memory
         trace has been reconsolidated and decays more slowly than before.</p>
      <p><img src="${FIGURE_PATH}" alt="Spacing curve diagram" width="320" height="180" /></p>
      <p>The classic forgetting curve shows retention falls off exponentially without
         reinforcement; reviewing just before forgetting flattens that curve cheaply.</p>
    </article>
    <footer>© 2026 Memory Lab</footer>
  </body>
</html>`;

let server: Server;
let baseUrl: string;
let dataDir: string;

test.beforeAll(async () => {
  ensureBuilt();
  dataDir = makeDataDir();
  server = createServer((req, res) => {
    if (req.url === ARTICLE_PATH) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(ARTICLE_HTML);
      return;
    }
    if (req.url === FIGURE_PATH) {
      res.writeHead(200, {
        "content-type": "image/png",
        "content-length": String(FIGURE_BYTES.byteLength),
      });
      res.end(FIGURE_BYTES);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Launch the app with loopback import permitted (so the SSRF guard allows the test server). */
async function launch(): Promise<ElectronApplication> {
  return launchApp(dataDir, { allowLoopbackImport: true });
}

/** Read one source's provenance + body through the bridge. */
async function readSource(page: Page, id: string) {
  return page.evaluate(async (sourceId) => {
    const api = window.appApi as unknown as {
      inbox: {
        get(req: { id: string }): Promise<{
          detail: {
            provenance: {
              originalUrl: string | null;
              canonicalUrl: string | null;
              accessedAt: string | null;
            };
            bodyPreview: string | null;
          } | null;
        }>;
      };
    };
    const { detail } = await api.inbox.get({ id: sourceId });
    return detail;
  }, id);
}

/** Read one source's persisted document through the bridge. */
async function readDocument(page: Page, id: string) {
  return page.evaluate(async (sourceId) => {
    const api = window.appApi as unknown as {
      documents: {
        get(req: { elementId: string }): Promise<{
          document: { prosemirrorJson: unknown; plainText: string } | null;
        }>;
      };
    };
    const { document } = await api.documents.get({ elementId: sourceId });
    return document;
  }, id);
}

function imageSrcsFromDoc(doc: unknown): string[] {
  const out: string[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const candidate = node as {
      type?: unknown;
      attrs?: { src?: unknown };
      content?: unknown[];
    };
    if (candidate.type === "image" && typeof candidate.attrs?.src === "string") {
      out.push(candidate.attrs.src);
    }
    for (const child of candidate.content ?? []) visit(child);
  };
  visit(doc);
  return out;
}

test("the inbox exposes sources.importUrl on the bridge (not raw SQL)", async () => {
  const app = await launch();
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const surface = await page.evaluate(() => {
    const api = window.appApi as unknown as {
      sources?: { importUrl?: unknown };
      db?: { query?: unknown };
    };
    return {
      hasImportUrl: typeof api?.sources?.importUrl === "function",
      hasQuery: typeof api?.db?.query === "function",
    };
  });
  expect(surface.hasImportUrl).toBe(true);
  expect(surface.hasQuery).toBe(false);
  await app.close();
});

test("pasting a URL fetches + cleans + snapshots the page into an inbox source", async () => {
  const app = await launch();
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await page.getByTestId("nav-inbox").click();
  await expect(page.getByTestId("route-inbox")).toBeVisible();
  await expect(page.getByTestId("inbox-empty")).toBeVisible();

  // Open the Import-from-URL modal via the "Paste URL" chip.
  await page.getByTestId("inbox-import-paste-url").click();
  await expect(page.getByTestId("import-url-modal")).toBeVisible();
  await page.getByTestId("import-url-input").fill(`${baseUrl}${ARTICLE_PATH}`);
  await page.getByTestId("import-url-submit").click();

  // The modal closes and the cleaned source lands in the inbox list + preview.
  await expect(page.getByTestId("import-url-modal")).toBeHidden({ timeout: 20_000 });
  await expect(page.getByTestId("inbox-row")).toHaveCount(1);
  await expect(page.getByTestId("inbox-preview-title")).toContainText(ARTICLE_TITLE);
  await expect(page.getByTestId("inbox-preview")).toContainText("exploits the spacing effect");

  // Through the bridge: provenance carries the original + canonical URL +
  // accessed date, and the body preview holds the cleaned article text.
  const id = await page.evaluate(async () => {
    const api = window.appApi as unknown as {
      inbox: { list(): Promise<{ items: { id: string }[] }> };
    };
    const { items } = await api.inbox.list();
    return items[0]?.id as string;
  });
  const detail = await readSource(page, id);
  expect(detail?.provenance.originalUrl).toBe(`${baseUrl}${ARTICLE_PATH}`);
  expect(detail?.provenance.canonicalUrl).toBe(`${baseUrl}${ARTICLE_PATH}`);
  expect(detail?.provenance.accessedAt).not.toBeNull();
  expect(detail?.bodyPreview).toContain("Spaced repetition exploits the spacing effect");

  const document = await readDocument(page, id);
  const imageSrcs = imageSrcsFromDoc(document?.prosemirrorJson);
  expect(imageSrcs).toHaveLength(1);
  expect(imageSrcs[0]).toMatch(new RegExp(`^article-image://${id}/[A-Za-z0-9_-]+$`));
  expect(document?.plainText).toContain("Spacing curve diagram");

  // The snapshot files and downloaded image exist in the vault.
  const sourceDir = path.join(dataDir, "assets", "sources", id);
  expect(fs.existsSync(path.join(sourceDir, "original.html"))).toBe(true);
  const cleanedPath = path.join(sourceDir, "cleaned.html");
  expect(fs.existsSync(cleanedPath)).toBe(true);
  const cleaned = fs.readFileSync(cleanedPath, "utf-8");
  expect(cleaned).toContain(imageSrcs[0] as string);
  expect(cleaned).not.toContain(`${baseUrl}${FIGURE_PATH}`);
  const imageAssetId = imageSrcs[0]?.split("/").at(-1);
  expect(imageAssetId).toBeTruthy();
  const imagesDir = path.join(sourceDir, "images");
  expect(fs.existsSync(imagesDir)).toBe(true);
  expect(fs.readdirSync(imagesDir).some((name) => name.endsWith(".png"))).toBe(true);

  await app.close();
});

test("the imported URL source + its snapshots survive an app restart", async () => {
  const app = await launch();
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await page.getByTestId("nav-inbox").click();
  await expect(page.getByTestId("route-inbox")).toBeVisible();

  // Still in the inbox with its title + body after restart.
  await expect(page.getByTestId("inbox-row")).toHaveCount(1);
  await page.getByTestId("inbox-row").click();
  await expect(page.getByTestId("inbox-preview-title")).toContainText(ARTICLE_TITLE);
  await expect(page.getByTestId("inbox-preview")).toContainText("interval lengthens");

  // Provenance + body confirmed through the bridge; snapshots still on disk.
  const id = await page.evaluate(async () => {
    const api = window.appApi as unknown as {
      inbox: { list(): Promise<{ items: { id: string }[] }> };
    };
    const { items } = await api.inbox.list();
    return items[0]?.id as string;
  });
  const detail = await readSource(page, id);
  expect(detail?.provenance.originalUrl).toBe(`${baseUrl}${ARTICLE_PATH}`);
  expect(detail?.bodyPreview).toContain("Spaced repetition exploits the spacing effect");

  const document = await readDocument(page, id);
  const imageSrcs = imageSrcsFromDoc(document?.prosemirrorJson);
  expect(imageSrcs).toHaveLength(1);
  expect(document?.plainText).toContain("Spacing curve diagram");

  const sourceDir = path.join(dataDir, "assets", "sources", id);
  expect(fs.existsSync(path.join(sourceDir, "original.html"))).toBe(true);
  const cleanedPath = path.join(sourceDir, "cleaned.html");
  expect(fs.existsSync(cleanedPath)).toBe(true);
  expect(fs.readFileSync(cleanedPath, "utf-8")).toContain(imageSrcs[0] as string);
  expect(fs.existsSync(path.join(sourceDir, "images"))).toBe(true);

  await app.close();
});

// --- T061: canonical-URL & content-hash dedup, reuse-or-new-version prompt. ---

test("re-importing the SAME url is detected as a duplicate (no second source)", async () => {
  const app = await launch();
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await page.getByTestId("nav-inbox").click();
  await expect(page.getByTestId("route-inbox")).toBeVisible();
  // One source already imported by the earlier tests.
  await expect(page.getByTestId("inbox-row")).toHaveCount(1);

  // Paste the SAME URL again — the main process detects the canonical-URL dup and
  // returns the "already imported" outcome WITHOUT creating anything.
  await page.getByTestId("inbox-import-paste-url").click();
  await expect(page.getByTestId("import-url-modal")).toBeVisible();
  await page.getByTestId("import-url-input").fill(`${baseUrl}${ARTICLE_PATH}`);
  await page.getByTestId("import-url-submit").click();

  // The duplicate panel appears (modal stays open); still ONE inbox row.
  await expect(page.getByTestId("import-url-duplicate")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("import-url-open-existing")).toBeVisible();
  await expect(page.getByTestId("import-url-modal")).toBeVisible();
  await page.getByTestId("import-url-duplicate-cancel").click();
  await expect(page.getByTestId("import-url-modal")).toBeHidden();
  await expect(page.getByTestId("inbox-row")).toHaveCount(1);

  await app.close();
});

test("'Import new version' explicitly creates a SECOND source for the same url", async () => {
  const app = await launch();
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await page.getByTestId("nav-inbox").click();
  await expect(page.getByTestId("route-inbox")).toBeVisible();
  await expect(page.getByTestId("inbox-row")).toHaveCount(1);

  await page.getByTestId("inbox-import-paste-url").click();
  await expect(page.getByTestId("import-url-modal")).toBeVisible();
  await page.getByTestId("import-url-input").fill(`${baseUrl}${ARTICLE_PATH}`);
  await page.getByTestId("import-url-submit").click();

  // On the duplicate prompt, choose "Import new version" — a second source lands.
  await expect(page.getByTestId("import-url-duplicate")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("import-url-new-version").click();
  await expect(page.getByTestId("import-url-modal")).toBeHidden({ timeout: 20_000 });
  await expect(page.getByTestId("inbox-row")).toHaveCount(2);

  await app.close();
});

test("both sources (and the new version) survive an app restart", async () => {
  const app = await launch();
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await page.getByTestId("nav-inbox").click();
  await expect(page.getByTestId("route-inbox")).toBeVisible();
  // The original + the explicit new version both persist.
  await expect(page.getByTestId("inbox-row")).toHaveCount(2);

  // Both share the same canonical URL (the index is non-unique by design).
  const canonicals = await page.evaluate(async () => {
    const api = window.appApi as unknown as {
      inbox: { list(): Promise<{ items: { id: string }[] }> };
      inspector: {
        get(req: { id: string }): Promise<{
          data: { provenance: { canonicalUrl: string | null } | null } | null;
        }>;
      };
    };
    const { items } = await api.inbox.list();
    const out: (string | null | undefined)[] = [];
    for (const it of items) {
      const { data } = await api.inspector.get({ id: it.id });
      out.push(data?.provenance?.canonicalUrl);
    }
    return out;
  });
  expect(canonicals).toHaveLength(2);
  expect(canonicals[0]).toBe(`${baseUrl}${ARTICLE_PATH}`);
  expect(canonicals[1]).toBe(`${baseUrl}${ARTICLE_PATH}`);

  await app.close();
});
