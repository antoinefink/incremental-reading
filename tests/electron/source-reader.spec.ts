/**
 * Source reading mode E2E (T018) — drives the real Electron app.
 *
 * `/source/$id` is now a real incremental reading workspace: a serif reading
 * column rendered by the constrained editor, a read-point marker, extracted-span
 * display markers, a progress bar, and an action bar — all reading through
 * `window.appApi` (`documents.get` / `readPoints.get` / `readPoints.set` /
 * `inspector.get`). This spec launches the BUILT desktop app against a fresh data
 * dir seeded with the shared demo collection (a source with 4 blocks, a child
 * extract anchored at `blk_def_p1`, and a read-point at `blk_def_p1`) and asserts:
 *
 *   (a) EDIT → RELOAD: opening the source, editing the body, and reopening the
 *       route shows the persisted edit (the T015 persistence path, through the
 *       reader);
 *   (b) REOPEN → RESUME-AT-READ-POINT: the read-point divider renders before the
 *       first unread block (`blk_def_p2`, the block after the read-point's
 *       `blk_def_p1`), not at the top;
 *   (c) the reader renders in BOTH light and dark themes;
 *   (d) extracted-span display markers are present (the definition block carries
 *       the `extracted` class), and the reader reaches data through the bridge
 *       (no generic `db.query`).
 *
 * The full restart-app persistence guarantee is covered by the T015/T017
 * repository + document/read-point E2E specs (and lands again in T049); this spec
 * proves the reader surface itself works against the real bridge.
 */

import { type AddressInfo, createServer, type Server } from "node:http";
import { expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

let dataDir: string;
/** The seeded source id, resolved once via the bridge. */
let sourceId: string;
/**
 * The renderer base URL (`app://bundle`), captured from the first window. The
 * custom `app://` scheme is non-special, so `URL#origin` is the string `"null"`;
 * we keep `protocol + "//" + host` instead so SPA route navigation works.
 */
let rendererBaseUrl: string;
let fixtureServer: Server;
let fixtureBaseUrl: string;

const RICH_ARTICLE_PATH = "/rich-source";
const RICH_FIGURE_PATH = "/figures/rich.png";
const RICH_ARTICLE_TITLE = "Rich Source Rendering";
const RICH_FIGURE_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);
const RICH_ARTICLE_HTML = `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="utf-8" /><title>${RICH_ARTICLE_TITLE}</title></head>
  <body>
    <article>
      <h1>${RICH_ARTICLE_TITLE}</h1>
      <p>First rich paragraph before the emphasized claim.</p>
      <p>The reader should preserve <strong>bold imported claim</strong> and paragraph rhythm.</p>
      <p><img src="${RICH_FIGURE_PATH}" alt="Rich source diagram" width="320" height="180" /></p>
      <p>Final rich paragraph after the local article image.</p>
    </article>
  </body>
</html>`;

test.beforeAll(async () => {
  ensureBuilt();
  dataDir = makeDataDir();
  fixtureServer = createServer((req, res) => {
    if (req.url === RICH_ARTICLE_PATH) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(RICH_ARTICLE_HTML);
      return;
    }
    if (req.url === RICH_FIGURE_PATH) {
      res.writeHead(200, {
        "content-type": "image/png",
        "content-length": String(RICH_FIGURE_BYTES.byteLength),
      });
      res.end(RICH_FIGURE_BYTES);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  await new Promise<void>((resolve) => fixtureServer.listen(0, "127.0.0.1", resolve));
  const { port } = fixtureServer.address() as AddressInfo;
  fixtureBaseUrl = `http://127.0.0.1:${port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => fixtureServer.close(() => resolve()));
});

/** Resolve the seeded "On the Measure of Intelligence" source id via the bridge. */
async function resolveSourceId(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const api = window.appApi as unknown as {
      inspector: {
        list(): Promise<{ elements: { id: string; type: string; title: string }[] }>;
      };
    };
    const { elements } = await api.inspector.list();
    // The demo seeds two sources; pick the article with the 4-block body + the
    // read-point at `blk_def_p1` (not the inbox "Bitter Lesson" source).
    const source = elements.find(
      (e) => e.type === "source" && e.title === "On the Measure of Intelligence",
    );
    if (!source) throw new Error("seeded source not found");
    return source.id;
  });
}

/** Open `/source/<id>` via the SPA route and wait for the reader to render. */
async function openReader(page: Page, id: string): Promise<void> {
  if (!rendererBaseUrl) {
    const url = new URL(page.url());
    rendererBaseUrl = `${url.protocol}//${url.host}`;
  }
  await page.goto(`${rendererBaseUrl}/source/${id}`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("reader-title")).toBeVisible();
  // The editor mounts asynchronously after the document loads.
  await expect(page.locator(".reader .ProseMirror")).toBeVisible();
}

/** Create a tall text source so scroll-extreme assertions are meaningful. */
async function createTallSource(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const api = window.appApi as unknown as {
      sources: {
        importManual(req: {
          title: string;
          body: string;
          priority: "A" | "B" | "C" | "D";
        }): Promise<{ id: string }>;
      };
      inbox: {
        triage(req: { id: string; action: { kind: "accept" } }): Promise<unknown>;
      };
    };
    const paragraphs = Array.from({ length: 80 }, (_, index) =>
      index === 0
        ? "Scroll sentinel top paragraph."
        : index === 79
          ? "Scroll sentinel bottom paragraph."
          : `Scroll filler paragraph ${index}. This text makes the reader body tall enough to require scrolling.`,
    );
    const { id } = await api.sources.importManual({
      title: "Scroll extent article",
      body: paragraphs.join("\n\n"),
      priority: "C",
    });
    await api.inbox.triage({ id, action: { kind: "accept" } });
    return id;
  });
}

/** Import a rich HTML article through the real URL-import bridge, then accept it. */
async function createRichSource(page: Page): Promise<string> {
  return page.evaluate(async (url) => {
    const api = window.appApi as unknown as {
      sources: {
        importUrl(req: {
          url: string;
          priority?: "A" | "B" | "C" | "D";
          forceNewVersion?: boolean;
        }): Promise<{ status: "imported"; id: string } | { status: "duplicate" }>;
      };
      inbox: {
        triage(req: { id: string; action: { kind: "accept" } }): Promise<unknown>;
      };
    };
    const result = await api.sources.importUrl({ url, priority: "C", forceNewVersion: true });
    if (result.status !== "imported") throw new Error("rich fixture import was not imported");
    await api.inbox.triage({ id: result.id, action: { kind: "accept" } });
    return result.id;
  }, `${fixtureBaseUrl}${RICH_ARTICLE_PATH}`);
}

test("the reader reaches documents/readPoints/inspector through the bridge, not raw SQL", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const url = new URL(page.url());
  rendererBaseUrl = `${url.protocol}//${url.host}`;
  sourceId = await resolveSourceId(page);

  const surface = await page.evaluate(() => {
    const api = window.appApi as unknown as {
      documents?: { get?: unknown };
      readPoints?: { get?: unknown; set?: unknown };
      inspector?: { get?: unknown };
      db?: { query?: unknown };
    };
    return {
      hasDocGet: typeof api?.documents?.get === "function",
      hasRpGet: typeof api?.readPoints?.get === "function",
      hasRpSet: typeof api?.readPoints?.set === "function",
      hasInspGet: typeof api?.inspector?.get === "function",
      // biome-ignore lint/suspicious/noExplicitAny: probing for a forbidden method
      hasQuery: typeof (api as any)?.db?.query === "function",
    };
  });
  expect(surface.hasDocGet).toBe(true);
  expect(surface.hasRpGet).toBe(true);
  expect(surface.hasRpSet).toBe(true);
  expect(surface.hasInspGet).toBe(true);
  expect(surface.hasQuery).toBe(false);

  await app.close();
});

test("the source reader opens imported rich article structure and local images", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true, allowLoopbackImport: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const richSourceId = await createRichSource(page);
  await openReader(page, richSourceId);

  await expect(page.getByTestId("reader-title")).toHaveText(RICH_ARTICLE_TITLE);
  const body = page.locator(".reader .ProseMirror");
  await expect(body.locator("p")).toHaveCount(3);
  await expect(body.locator("p").first()).toContainText("First rich paragraph");
  await expect(body.locator("strong")).toHaveText("bold imported claim");

  const image = body.getByRole("img", { name: "Rich source diagram" });
  await expect(image).toBeVisible();
  const imageSrc = await image.getAttribute("src");
  expect(imageSrc).toMatch(new RegExp(`^article-image://${richSourceId}/[A-Za-z0-9_-]+$`));
  expect(imageSrc).not.toMatch(/^(https?:|file:|data:)/);

  const renderedOrder = await body.evaluate((root) =>
    Array.from(root.querySelectorAll(":scope > p, :scope > img")).map((child) => ({
      tag: child.tagName.toLowerCase(),
      text: child.textContent?.trim() ?? "",
      alt: child instanceof HTMLImageElement ? child.alt : null,
    })),
  );
  expect(renderedOrder).toEqual([
    { tag: "p", text: "First rich paragraph before the emphasized claim.", alt: null },
    {
      tag: "p",
      text: "The reader should preserve bold imported claim and paragraph rhythm.",
      alt: null,
    },
    { tag: "img", text: "", alt: "Rich source diagram" },
    { tag: "p", text: "Final rich paragraph after the local article image.", alt: null },
  ]);

  await app.close();
});

test("the reader shows title, body, progress, action bar, and extracted-span markers", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await openReader(page, sourceId);

  // Header + provenance.
  await expect(page.getByTestId("reader-title")).toHaveText("On the Measure of Intelligence");
  await expect(page.getByTestId("reader-url")).toContainText("arxiv.org");

  // The body rendered (the definition paragraph is present).
  await expect(page.locator(".reader .ProseMirror")).toContainText("skill-acquisition efficiency");

  // Action bar: read-point plus working source lifecycle exits.
  await expect(page.getByTestId("reader-set-readpoint")).toBeEnabled();
  await expect(page.getByTestId("reader-postpone")).toBeEnabled();
  await expect(page.getByTestId("reader-mark-done")).toBeEnabled();

  // Progress bar present.
  await expect(page.getByTestId("reader-pbar-fill")).toBeVisible();

  // Extracted-span display marker: the seeded extract anchors at the definition
  // block (`blk_def_p1`), so that block carries the `extracted` class.
  await expect(page.locator('.reader [data-block-id="blk_def_p1"].extracted')).toBeVisible();

  await app.close();
});

test("the article body scroller reaches both bottom and top", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const tallSourceId = await createTallSource(page);
  await openReader(page, tallSourceId);

  const shellAndReaderScroll = await page.evaluate(async () => {
    const shell = document.querySelector(".shell-page") as HTMLElement | null;
    const screen = document.querySelector(".source-reader-screen") as HTMLElement | null;
    const reader = document.querySelector(".reader-page") as HTMLElement | null;
    const paragraphs = Array.from(document.querySelectorAll(".reader .ProseMirror p"));
    const first = paragraphs[0] as HTMLElement | undefined;
    const last = paragraphs.at(-1) as HTMLElement | undefined;
    if (!shell || !screen || !reader || !first || !last) {
      throw new Error("reader scroll containers not found");
    }

    reader.scrollTop = reader.scrollHeight;
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const readerBottomRect = reader.getBoundingClientRect();
    const lastRect = last.getBoundingClientRect();
    const bottom = {
      readerTop: reader.scrollTop,
      readerClientHeight: reader.clientHeight,
      readerScrollHeight: reader.scrollHeight,
      shellTop: shell.scrollTop,
      shellOverflowY: getComputedStyle(shell).overflowY,
      bottomSentinelVisible:
        lastRect.top >= readerBottomRect.top - 1 && lastRect.bottom <= readerBottomRect.bottom + 1,
    };

    reader.scrollTop = 0;
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const readerTopRect = reader.getBoundingClientRect();
    const firstRect = first.getBoundingClientRect();
    const top = {
      readerTop: reader.scrollTop,
      shellTop: shell.scrollTop,
      shellOverflowY: getComputedStyle(shell).overflowY,
      topSentinelVisible:
        firstRect.top >= readerTopRect.top - 1 && firstRect.bottom <= readerTopRect.bottom + 1,
    };

    return { bottom, top };
  });

  expect(shellAndReaderScroll.bottom.shellOverflowY).toBe("hidden");
  expect(shellAndReaderScroll.top.shellOverflowY).toBe("hidden");
  expect(shellAndReaderScroll.bottom.bottomSentinelVisible).toBe(true);
  expect(shellAndReaderScroll.top.topSentinelVisible).toBe(true);
  expect(shellAndReaderScroll.bottom.shellTop).toBe(0);
  expect(shellAndReaderScroll.top.shellTop).toBe(0);
  expect(
    shellAndReaderScroll.bottom.readerTop + shellAndReaderScroll.bottom.readerClientHeight,
  ).toBeGreaterThanOrEqual(shellAndReaderScroll.bottom.readerScrollHeight - 1);
  expect(shellAndReaderScroll.top.readerTop).toBe(0);
  await expect(page.locator(".reader .ProseMirror")).toContainText(
    "Scroll sentinel top paragraph.",
  );
  await expect(page.locator(".reader .ProseMirror")).toContainText(
    "Scroll sentinel bottom paragraph.",
  );

  await app.close();
});

test("the Library breadcrumb opens the Library route", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await openReader(page, sourceId);

  await page
    .getByRole("navigation", { name: "Breadcrumb" })
    .getByRole("button", { name: "Library" })
    .click();

  await expect(page).toHaveURL(/\/library$/);
  await expect(page.getByTestId("route-library")).toBeVisible();

  await app.close();
});

test("(b) reopening resumes at the read-point: the divider renders before the first unread block", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await openReader(page, sourceId);

  // The seeded read-point is at `blk_def_p1`; the first UNREAD block is the next
  // one (`blk_def_p2`). The reader inserts the `.readpoint` divider before it.
  const divider = page.locator(".reader .readpoint");
  await expect(divider).toBeVisible();
  await expect(divider).toContainText("unread from here");

  // The divider sits immediately before the first-unread block in the DOM.
  const dividerThenBlock = page.locator('.reader .readpoint + [data-block-id="blk_def_p2"]');
  await expect(dividerThenBlock).toHaveCount(1);

  await app.close();
});

test("(a) editing the body and reopening the route shows the persisted edit", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await openReader(page, sourceId);

  const marker = ` [edited-${Date.now()}]`;

  // Type into the editor: place the caret at the end of the first paragraph and
  // append a unique marker. The reader saves debounced through documents.save.
  const firstBlock = page.locator('.reader [data-block-id="blk_intro_p1"]');
  await firstBlock.click();
  await page.keyboard.press("End");
  await page.keyboard.type(marker);

  // Wait for the debounced save to land in SQLite via the bridge.
  await expect
    .poll(
      async () => {
        return page.evaluate(async (id: string) => {
          const api = window.appApi as unknown as {
            documents: {
              get(req: { elementId: string }): Promise<{ document: { plainText: string } | null }>;
            };
          };
          const { document } = await api.documents.get({ elementId: id });
          return document?.plainText ?? "";
        }, sourceId);
      },
      { timeout: 6000 },
    )
    .toContain(marker);

  // Reopen the route fresh; the edit is still in the rendered body.
  await openReader(page, sourceId);
  await expect(page.locator(".reader .ProseMirror")).toContainText(marker);

  await app.close();
});

test("(c) the reader renders in both light and dark themes", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await openReader(page, sourceId);

  const html = page.locator("html");
  const before = await html.getAttribute("data-theme");

  // Flip the theme via the shell's user-chip menu.
  await page.getByTestId("user-chip").click();
  await page
    .getByTestId(before === "light" ? "shell-theme-option-dark" : "shell-theme-option-light")
    .click();
  const after = await html.getAttribute("data-theme");
  expect(after).not.toBe(before);

  // The reader is still intact + the read-point divider still renders.
  await expect(page.getByTestId("reader-title")).toBeVisible();
  await expect(page.locator(".reader .readpoint")).toBeVisible();

  await app.close();
});
