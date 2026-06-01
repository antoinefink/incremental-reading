/**
 * Asset-vault scaling E2E (T059) — drives the real Electron app's typed
 * `window.appApi.vault.*` surface against a LOCAL fixture HTTP server.
 *
 * It proves the file-centric maintenance loop end to end, entirely through the
 * bridge (no raw fs/SQL in the renderer):
 *
 *   1. import a URL source (which writes `original.html` + `cleaned.html` vault
 *      snapshots), then `vault.verify` → those referenced files are `ok`, no
 *      mismatches/missing, no extra files;
 *   2. soft-delete then HARD-purge the source (the purge's cascade FK deletes the
 *      snapshot `assets` ROWS but leaves their FILES on disk — that is exactly what
 *      makes those files orphans);
 *   3. `vault.findOrphans` → those leftover snapshot FILES appear;
 *   4. `vault.collectOrphans({ confirm: true })` frees them;
 *   5. after an APP RESTART against the same data dir, the freed files stay gone.
 *
 * NOTE: the fixture server binds 127.0.0.1 (the SSRF guard normally blocks it), so
 * the test launches with `INTERLEAVE_ALLOW_LOOPBACK_IMPORT=1`.
 */

import fs from "node:fs";
import { type AddressInfo, createServer, type Server } from "node:http";
import path from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

const ARTICLE_PATH = "/vault-article";
const ARTICLE_TITLE = "Vault Scaling";
const ARTICLE_HTML = `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="utf-8" /><title>${ARTICLE_TITLE} — Notes</title></head>
  <body>
    <article>
      <h1>${ARTICLE_TITLE}</h1>
      <p>The asset vault stores large binaries on the local filesystem, never in SQLite —
         only metadata, hashes, and relative paths live in the database.</p>
      <p>Orphan collection reclaims vault files that no live asset row references, which is
         the bytes a hard-purge's cascade leaves behind on disk.</p>
    </article>
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

async function launch(): Promise<ElectronApplication> {
  return launchApp(dataDir, { allowLoopbackImport: true });
}

/** Import a URL through the bridge and return the created source id. */
async function importUrl(page: Page, url: string): Promise<string> {
  return page.evaluate(async (u) => {
    const api = window.appApi as unknown as {
      sources: {
        importUrl(req: {
          url: string;
        }): Promise<
          { status: "imported"; id: string } | { status: "duplicate"; matches: unknown[] }
        >;
      };
    };
    const result = await api.sources.importUrl({ url: u });
    if (result.status !== "imported") throw new Error("expected an imported source");
    return result.id;
  }, url);
}

/** Run `vault.verify` through the bridge. */
async function verify(page: Page) {
  return page.evaluate(async () => {
    const api = window.appApi as unknown as {
      vault: {
        verify(): Promise<{
          ok: number;
          mismatched: string[];
          missing: string[];
          extraFiles: string[];
        }>;
      };
    };
    return api.vault.verify();
  });
}

/** Run `vault.findOrphans` through the bridge. */
async function findOrphans(page: Page) {
  return page.evaluate(async () => {
    const api = window.appApi as unknown as {
      vault: {
        findOrphans(): Promise<{
          orphans: { relativePath: string; size: number }[];
          totalBytes: number;
        }>;
      };
    };
    return api.vault.findOrphans();
  });
}

test("vault.verify covers the imported snapshots with no orphans or mismatches", async () => {
  const app = await launch();
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const id = await importUrl(page, `${baseUrl}${ARTICLE_PATH}`);

  // Both snapshot files are on disk.
  const sourceDir = path.join(dataDir, "assets", "sources", id);
  expect(fs.existsSync(path.join(sourceDir, "original.html"))).toBe(true);
  expect(fs.existsSync(path.join(sourceDir, "cleaned.html"))).toBe(true);

  // verify: the two referenced snapshot rows hash OK; nothing missing/mismatched/extra.
  const report = await verify(page);
  expect(report.ok).toBeGreaterThanOrEqual(2);
  expect(report.mismatched).toEqual([]);
  expect(report.missing).toEqual([]);
  expect(report.extraFiles).toEqual([]);

  // No orphans while the source is live.
  const orphans = await findOrphans(page);
  expect(orphans.orphans).toEqual([]);

  await app.close();
});

test("hard-purging the source orphans its snapshot files, which collectOrphans frees", async () => {
  const app = await launch();
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // The source imported by the previous test is still in the inbox.
  const id = await page.evaluate(async () => {
    const api = window.appApi as unknown as {
      inbox: { list(): Promise<{ items: { id: string }[] }> };
    };
    const { items } = await api.inbox.list();
    return items[0]?.id as string;
  });
  expect(id).toBeTruthy();

  const sourceDir = path.join(dataDir, "assets", "sources", id);

  // Soft-delete (triage) then HARD-purge through the bridge. The purge's cascade FK
  // deletes the snapshot `assets` ROWS while leaving their FILES on disk.
  await page.evaluate(async (sourceId) => {
    const api = window.appApi as unknown as {
      inbox: { triage(req: { id: string; action: { kind: "delete" } }): Promise<unknown> };
      trash: { purge(req: { id: string }): Promise<{ purged: boolean }> };
    };
    await api.inbox.triage({ id: sourceId, action: { kind: "delete" } });
    await api.trash.purge({ id: sourceId });
  }, id);

  // The snapshot files are now unreferenced (rows gone) but still on disk.
  expect(fs.existsSync(path.join(sourceDir, "original.html"))).toBe(true);
  expect(fs.existsSync(path.join(sourceDir, "cleaned.html"))).toBe(true);

  // findOrphans surfaces exactly those leftover snapshot files.
  const orphans = await findOrphans(page);
  const orphanPaths = orphans.orphans.map((o) => o.relativePath).sort();
  expect(orphanPaths).toContain(`sources/${id}/original.html`);
  expect(orphanPaths).toContain(`sources/${id}/cleaned.html`);
  expect(orphans.totalBytes).toBeGreaterThan(0);

  // collectOrphans({ confirm: true }) frees them.
  const result = await page.evaluate(async () => {
    const api = window.appApi as unknown as {
      vault: {
        collectOrphans(req: { confirm: true }): Promise<{ removed: number; freedBytes: number }>;
      };
    };
    return api.vault.collectOrphans({ confirm: true });
  });
  expect(result.removed).toBeGreaterThanOrEqual(2);
  expect(result.freedBytes).toBeGreaterThan(0);

  // The orphan files are gone.
  expect(fs.existsSync(path.join(sourceDir, "original.html"))).toBe(false);
  expect(fs.existsSync(path.join(sourceDir, "cleaned.html"))).toBe(false);

  await app.close();
});

test("the freed orphan files stay gone after an app restart", async () => {
  const app = await launch();
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // The inbox is empty (the source was purged) and there are no orphans to find.
  const orphans = await findOrphans(page);
  expect(orphans.orphans).toEqual([]);

  // A fresh verify is clean — no extra files, nothing missing/mismatched.
  const report = await verify(page);
  expect(report.mismatched).toEqual([]);
  expect(report.missing).toEqual([]);
  expect(report.extraFiles).toEqual([]);

  await app.close();
});
