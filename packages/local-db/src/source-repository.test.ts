/**
 * SourceRepository document/asset-seam tests (T060).
 *
 * Pins the three seams URL import (T060) adds to the source pipeline, against a
 * fresh in-memory migrated DB:
 *  - a PRE-BUILT `conversion` is stored VERBATIM (no re-conversion) — the doc,
 *    plainText, and blocks come straight from the importer; the raw-`body`
 *    fallback path is unchanged;
 *  - a PRE-MINTED `id` is adopted by the created source element (so the vault
 *    path `assets/sources/<id>/` is known before the row exists);
 *  - the `createWithDocumentWithin` + `AssetRepository.createWithin` tx seam is
 *    atomic: a throw during the asset insert rolls the source row back too (no
 *    orphan source/asset).
 */

import type { BlockId, PlainTextConversion } from "@interleave/core";
import { priorityFromLabel } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AssetRepository } from "./asset-repository";
import { DocumentRepository } from "./document-repository";
import { ElementRepository } from "./element-repository";
import { newElementId } from "./ids";
import { OperationLogRepository } from "./operation-log-repository";
import { SourceRepository } from "./source-repository";
import { createInMemoryDb } from "./test-db";

let handle: DbHandle;

beforeEach(() => {
  handle = createInMemoryDb();
});

afterEach(() => {
  handle.sqlite.close();
});

/** A small pre-built conversion mixing a heading + paragraph + list-item block. */
function buildConversion(): PlainTextConversion {
  return {
    doc: {
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 1, blockId: "h-1" as BlockId },
          content: [{ type: "text", text: "Title" }],
        },
        {
          type: "paragraph",
          attrs: { blockId: "p-1" as BlockId },
          content: [{ type: "text", text: "Body para." }],
        },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              attrs: { blockId: "li-1" as BlockId },
              content: [{ type: "paragraph", content: [{ type: "text", text: "an item" }] }],
            },
          ],
        },
      ],
    },
    plainText: "Title\n\nBody para.\n\nan item",
    blocks: [
      { blockType: "heading", order: 0, stableBlockId: "h-1" as BlockId },
      { blockType: "paragraph", order: 1, stableBlockId: "p-1" as BlockId },
      { blockType: "listItem", order: 2, stableBlockId: "li-1" as BlockId },
    ],
  };
}

describe("SourceRepository.createWithDocument (T060 pre-built conversion)", () => {
  it("stores a pre-built conversion verbatim (no re-conversion)", () => {
    const repo = new SourceRepository(handle.db);
    const conversion = buildConversion();
    const result = repo.createWithDocument({
      title: "URL source",
      priority: priorityFromLabel("C"),
      status: "inbox",
      stage: "raw_source",
      conversion,
      // A `body` is present too — `conversion` must WIN over it.
      body: "this body must be ignored",
    });

    // The returned doc/plainText/blockCount mirror the supplied conversion exactly.
    expect(result.prosemirrorJson).toEqual(conversion.doc);
    expect(result.plainText).toBe(conversion.plainText);
    expect(result.blockCount).toBe(3);

    // The stored document row + blocks match the conversion, not a re-conversion
    // of the body text.
    const doc = new DocumentRepository(handle.db).findById(result.element.id);
    expect(doc?.plainText).toBe("Title\n\nBody para.\n\nan item");
    expect(JSON.parse(JSON.stringify(doc?.prosemirrorJson))).toEqual(conversion.doc);
    const blocks = new DocumentRepository(handle.db).listBlocks(result.element.id);
    expect(blocks.map((b) => b.blockType)).toEqual(["heading", "paragraph", "listItem"]);
    expect(blocks.map((b) => b.stableBlockId)).toEqual(["h-1", "p-1", "li-1"]);

    // It still lands as an inbox source with the create/update ops appended.
    expect(result.element.status).toBe("inbox");
    const ops = new OperationLogRepository(handle.db)
      .listForElement(result.element.id)
      .map((e) => e.opType);
    expect(ops).toContain("create_element");
    expect(ops).toContain("create_source");
    expect(ops).toContain("update_document");
  });

  it("persists per-block page numbers for a paginated (PDF) conversion (T064)", () => {
    const repo = new SourceRepository(handle.db);
    // A 2-page PDF-style conversion: each row carries its 1-based page.
    const conversion: PlainTextConversion = {
      doc: {
        type: "doc",
        content: [
          {
            type: "heading",
            attrs: { level: 3, blockId: "pg-1-h" as BlockId },
            content: [{ type: "text", text: "Page 1" }],
          },
          {
            type: "paragraph",
            attrs: { blockId: "pg-1-p" as BlockId },
            content: [{ type: "text", text: "First page body." }],
          },
          {
            type: "heading",
            attrs: { level: 3, blockId: "pg-2-h" as BlockId },
            content: [{ type: "text", text: "Page 2" }],
          },
        ],
      },
      plainText: "Page 1\nFirst page body.\n\nPage 2",
      blocks: [
        { blockType: "heading", order: 0, stableBlockId: "pg-1-h" as BlockId, page: 1 },
        { blockType: "paragraph", order: 1, stableBlockId: "pg-1-p" as BlockId, page: 1 },
        { blockType: "heading", order: 2, stableBlockId: "pg-2-h" as BlockId, page: 2 },
      ],
    };
    const result = repo.createWithDocument({
      title: "A PDF",
      priority: priorityFromLabel("C"),
      conversion,
    });
    const blocks = new DocumentRepository(handle.db).listBlocks(result.element.id);
    expect(blocks.map((b) => b.page)).toEqual([1, 1, 2]);
  });

  it("stores page = null for a non-paginated (HTML/text) conversion (T064)", () => {
    const repo = new SourceRepository(handle.db);
    const result = repo.createWithDocument({
      title: "HTML source",
      priority: priorityFromLabel("C"),
      conversion: buildConversion(), // no per-block page → null
    });
    const blocks = new DocumentRepository(handle.db).listBlocks(result.element.id);
    expect(blocks.every((b) => b.page === null)).toBe(true);
  });

  it("falls back to converting the raw body when no conversion is supplied", () => {
    const repo = new SourceRepository(handle.db);
    const result = repo.createWithDocument({
      title: "Manual source",
      priority: priorityFromLabel("C"),
      body: "Alpha line.\n\nBeta line.",
    });
    expect(result.blockCount).toBe(2);
    expect(result.plainText).toBe("Alpha line.\n\nBeta line.");
    const blocks = new DocumentRepository(handle.db).listBlocks(result.element.id);
    expect(blocks.every((b) => b.blockType === "paragraph")).toBe(true);
  });

  it("adopts a pre-minted source id (vault path known up front)", () => {
    const repo = new SourceRepository(handle.db);
    const id = newElementId();
    const result = repo.createWithDocument({
      id,
      title: "Pre-minted",
      priority: priorityFromLabel("C"),
      conversion: buildConversion(),
    });
    expect(result.element.id).toBe(id);
    // The element is findable by the pre-minted id.
    expect(new ElementRepository(handle.db).findById(id)?.title).toBe("Pre-minted");
  });
});

describe("createWithDocumentWithin + AssetRepository.createWithin (T060 atomic seam)", () => {
  it("commits the source + its snapshot asset rows in one transaction", () => {
    const sources = new SourceRepository(handle.db);
    const assets = new AssetRepository(handle.db);
    const id = newElementId();

    handle.db.transaction((tx) => {
      sources.createWithDocumentWithin(tx, {
        id,
        title: "Atomic",
        priority: priorityFromLabel("C"),
        conversion: buildConversion(),
        snapshotKey: `sources/${id}/cleaned.html`,
      });
      assets.createWithin(tx, {
        owningElementId: id,
        kind: "source_html",
        vaultRoot: "assets",
        relativePath: `sources/${id}/original.html`,
        contentHash: "hash-original",
        mime: "text/html",
        size: 100,
      });
      assets.createWithin(tx, {
        owningElementId: id,
        kind: "source_html",
        vaultRoot: "assets",
        relativePath: `sources/${id}/cleaned.html`,
        contentHash: "hash-cleaned",
        mime: "text/html",
        size: 50,
      });
    });

    expect(new SourceRepository(handle.db).findById(id)?.source.snapshotKey).toBe(
      `sources/${id}/cleaned.html`,
    );
    const rows = new AssetRepository(handle.db).listForElementByKind(id, "source_html");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.contentHash).sort()).toEqual(["hash-cleaned", "hash-original"]);
  });

  it("rolls the source row back when an asset insert throws (no orphan)", () => {
    const sources = new SourceRepository(handle.db);
    const assets = new AssetRepository(handle.db);
    const id = newElementId();

    expect(() =>
      handle.db.transaction((tx) => {
        sources.createWithDocumentWithin(tx, {
          id,
          title: "Will roll back",
          priority: priorityFromLabel("C"),
          conversion: buildConversion(),
        });
        assets.createWithin(tx, {
          owningElementId: id,
          kind: "source_html",
          vaultRoot: "assets",
          relativePath: `sources/${id}/original.html`,
          contentHash: "h",
          mime: "text/html",
          size: 1,
        });
        // Simulate a downstream failure (e.g. a second snapshot write throwing).
        throw new Error("boom during asset write");
      }),
    ).toThrow(/boom during asset write/);

    // The source element, its document, and any asset row are all absent.
    expect(new SourceRepository(handle.db).findById(id)).toBeNull();
    expect(new ElementRepository(handle.db).findById(id)).toBeNull();
    expect(new AssetRepository(handle.db).listForElement(id)).toHaveLength(0);
  });
});
