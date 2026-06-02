/**
 * PdfRegionService integration tests (T065) — against a real temp-file SQLite DB +
 * a temp `assetsDir`. Imports a fixture PDF (so a real source + page-block exists),
 * then drives `DbService.extractRegion` (the same path the IPC handler uses) with a
 * tiny in-memory PNG.
 *
 * Proves: the service lands an `image` asset under the canonical media layout
 * (`media/<asset_id>/original.bin`, mime `image/png`; the renderer ships the PNG
 * bytes), creates a scheduled `media_fragment` extract whose `source_locations` row carries
 * the page + region (and label "Page N · region"), appends `create_extract`, and the
 * whole thing survives re-opening the DB on the same file (restart-persistence).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MIGRATIONS_DIR } from "@interleave/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DbService } from "./db-service";

const FIXTURES = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "packages",
  "importers",
  "src",
  "__fixtures__",
);

/** A minimal valid 1×1 PNG (the crop bytes the renderer would ship). */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let dir: string;
let dbPath: string;
let assetsDir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "interleave-pdfregion-"));
  dbPath = path.join(dir, "app.sqlite");
  assetsDir = path.join(dir, "assets");
  fs.mkdirSync(assetsDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function openSvc(): DbService {
  const svc = new DbService();
  svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR, assetsDir });
  return svc;
}

/** Import a fixture PDF and return its source id + the second page's first block id. */
async function importPdf(svc: DbService): Promise<{ sourceId: string; pageBlockId: string }> {
  const fixture = path.join(FIXTURES, "two-page-text.pdf");
  const { id } = await svc.pdfImportService.importFromFile({ filePath: fixture });
  const blocks = svc.repos.documents.listBlocks(id as never);
  const page2First = blocks.find((b) => b.page === 2);
  if (!page2First) throw new Error("fixture has no page 2 block");
  return { sourceId: id, pageBlockId: page2First.stableBlockId };
}

describe("PdfRegionService.extractRegion (T065)", () => {
  it("creates a media_fragment extract + a vault image + a page+region source location", async () => {
    const svc = openSvc();
    const { sourceId, pageBlockId } = await importPdf(svc);

    const region = { x0: 0.1, y0: 0.2, x1: 0.6, y1: 0.7 };
    const png = PNG_1X1.buffer.slice(
      PNG_1X1.byteOffset,
      PNG_1X1.byteOffset + PNG_1X1.byteLength,
    ) as ArrayBuffer;
    const result = await svc.extractRegion({
      sourceElementId: sourceId,
      page: 2,
      pageBlockId,
      region,
      imagePng: png,
      caption: "A figure",
    });

    // The element is a scheduled `media_fragment` owned by the source.
    const element = svc.repos.elements.findById(result.id as never);
    expect(element?.type).toBe("media_fragment");
    expect(element?.sourceId).toBe(sourceId);
    expect(element?.status).toBe("scheduled");
    expect(element?.dueAt).not.toBeNull();

    // The image asset lives under the canonical media layout (bytes in the vault,
    // mime `image/png`); the asset is owned by the new media_fragment element.
    const assets = svc.repos.assets.listForElementByKind(result.id as never, "image");
    expect(assets).toHaveLength(1);
    const rel = assets[0]?.location.vaultPath.relativePath ?? "";
    expect(rel).toMatch(/^media\/.+\/original\.bin$/);
    expect(assets[0]?.mime).toBe("image/png");
    expect(fs.existsSync(path.join(assetsDir, ...rel.split("/")))).toBe(true);

    // The source location carries the page + region + label.
    const loc = svc.repos.sources.findLocationForElement(result.id as never);
    expect(loc?.page).toBe(2);
    expect(loc?.region).toEqual(region);
    expect(loc?.label).toBe("Page 2 · region");

    // A create_extract op was appended (lineage is logged).
    const ops = svc.repos.operationLog.listForElement(result.id as never).map((e) => e.opType);
    expect(ops).toContain("create_extract");

    // getRegionImage serves the bytes back through the typed command.
    const img = await svc.getRegionImage({ elementId: result.id });
    expect(img.bytes).not.toBeNull();
    expect(img.mime).toBe("image/png");

    svc.close();
  });

  it("survives re-opening the DB on the same file (restart-persistence)", async () => {
    const svc = openSvc();
    const { sourceId, pageBlockId } = await importPdf(svc);
    const region = { x0: 0.2, y0: 0.3, x1: 0.7, y1: 0.8 };
    const png = PNG_1X1.buffer.slice(
      PNG_1X1.byteOffset,
      PNG_1X1.byteOffset + PNG_1X1.byteLength,
    ) as ArrayBuffer;
    const { id } = await svc.extractRegion({
      sourceElementId: sourceId,
      page: 2,
      pageBlockId,
      region,
      imagePng: png,
    });
    svc.close();

    const reopened = openSvc();
    const element = reopened.repos.elements.findById(id as never);
    expect(element?.type).toBe("media_fragment");
    const loc = reopened.repos.sources.findLocationForElement(id as never);
    expect(loc?.page).toBe(2);
    expect(loc?.region).toEqual(region);
    const assets = reopened.repos.assets.listForElementByKind(id as never, "image");
    expect(assets).toHaveLength(1);
    expect(
      fs.existsSync(
        path.join(assetsDir, ...(assets[0]?.location.vaultPath.relativePath ?? "").split("/")),
      ),
    ).toBe(true);
    reopened.close();
  });

  it("rejects a region for a missing source", async () => {
    const svc = openSvc();
    const png = PNG_1X1.buffer.slice(
      PNG_1X1.byteOffset,
      PNG_1X1.byteOffset + PNG_1X1.byteLength,
    ) as ArrayBuffer;
    await expect(
      svc.extractRegion({
        sourceElementId: "el_missing",
        page: 1,
        pageBlockId: "nope",
        region: { x0: 0, y0: 0, x1: 0.5, y1: 0.5 },
        imagePng: png,
      }),
    ).rejects.toThrow();
    svc.close();
  });
});
