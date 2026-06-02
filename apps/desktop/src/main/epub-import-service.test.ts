/**
 * EpubImportService integration tests (T067) — against a real temp-file SQLite DB +
 * a temp `assetsDir`, pointing `importFromFile` at the committed `.epub` fixtures
 * (`@interleave/importers/src/__fixtures__/epub`). No Electron is involved — the
 * service is built through `DbService` (the same accessor the IPC layer uses).
 *
 * Proves: a successful import writes `sources/<bookId>/original.epub` under the vault
 * (its contentHash matches the file), creates an `inbox` book `source` whose
 * `snapshotKey` is the epub path, creates N chapter `topic`s linked `parent_child` to
 * the book with the book as their `sourceId`, each with a readable body + a
 * `source_locations` row (page = spine ordinal, label = chapter title), and appends
 * `create_element`/`create_source`/`update_document`/`add_relation` ops; the whole
 * tree + the `.epub` survive re-opening the DB (restart-persistence); and a malformed
 * `.epub` throws the typed `EpubImportError` and leaves NO source/asset/file.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MIGRATIONS_DIR } from "@interleave/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DbService } from "./db-service";
import { EpubImportError } from "./epub-import-service";

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
  "epub",
);

let dir: string;
let dbPath: string;
let assetsDir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "interleave-epubimp-"));
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

function sha256File(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

describe("EpubImportService.importFromFile", () => {
  it("imports an EPUB3 book into an inbox book source + chapter topics with lineage", async () => {
    const svc = openSvc();
    const fixture = path.join(FIXTURES, "epub3-three-chapters.epub");
    const result = await svc.epubImportService.importFromFile({ absPath: fixture });
    const bookId = result.bookId;

    expect(result.status).toBe("imported");
    expect(result.chapterCount).toBe(3);
    expect(result.item.status).toBe("inbox");
    expect(result.item.type).toBe("source");

    // The original .epub lives in the vault; its hash matches the file bytes.
    const epubRel = path.join("sources", bookId, "original.epub");
    expect(fs.existsSync(path.join(assetsDir, epubRel))).toBe(true);
    const assets = svc.repos.assets.listForElement(bookId as never);
    const epubAsset = assets.find((a) => a.kind === "source_epub");
    expect(epubAsset).toBeDefined();
    expect(epubAsset?.contentHash).toBe(sha256File(fixture));
    expect(epubAsset?.location.vaultPath.relativePath).toBe(`sources/${bookId}/original.epub`);

    // The book source carries the metadata + the epub as its snapshotKey.
    const book = svc.repos.sources.findById(bookId as never);
    expect(book?.element.type).toBe("source");
    expect(book?.element.title).toBe("The Memory Book");
    expect(book?.source.author).toBe("Ada Lovelace");
    expect(book?.source.snapshotKey).toBe(`sources/${bookId}/original.epub`);
    // Imported material defaults to a non-dominating priority (C ≈ 0.25–0.5).
    expect(book?.element.priority).toBeLessThan(0.75);

    // The book overview body is a STRUCTURED table of contents: the title as a
    // heading + the chapter titles as a bulletList (not one mashed paragraph).
    const bookDoc = svc.repos.documents.findById(bookId as never);
    const bookContent = (bookDoc?.prosemirrorJson as { content?: Array<{ type: string }> })
      ?.content;
    expect(bookContent?.[0]?.type).toBe("heading");
    expect(bookContent?.some((n) => n.type === "bulletList")).toBe(true);
    const bookBlocks = svc.repos.documents.listBlocks(bookId as never);
    // One heading row + one listItem row per chapter (3 chapters → 4 rows).
    expect(bookBlocks.map((b) => b.blockType)).toEqual([
      "heading",
      "listItem",
      "listItem",
      "listItem",
    ]);
    expect(bookDoc?.plainText).toContain("Beginnings");
    expect(bookDoc?.plainText).toContain("The Spacing Effect");

    // N chapter topics, linked parent_child to the book, with the book as sourceId.
    const children = svc.repos.elements.listChildren(bookId as never);
    const topics = children.filter((c) => c.type === "topic");
    expect(topics).toHaveLength(3);
    for (const topic of topics) {
      expect(topic.sourceId).toBe(bookId);
      expect(topic.parentId).toBe(bookId);
      expect(topic.status).toBe("inbox");
      // Each chapter has a readable body.
      const blocks = svc.repos.documents.listBlocks(topic.id);
      expect(blocks.length).toBeGreaterThan(0);
      // Each chapter has a source_locations anchor to the book (page + label).
      const loc = svc.repos.sources.findLocationForElement(topic.id);
      expect(loc?.sourceElementId).toBe(bookId);
      expect(typeof loc?.page).toBe("number");
      expect(loc?.label && loc.label.length > 0).toBe(true);
    }

    // The chapters appear in spine order with their page ordinals 1..3.
    const pages = topics
      .map((t) => svc.repos.sources.findLocationForElement(t.id)?.page)
      .sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(pages).toEqual([1, 2, 3]);

    // The footnote chapter ("The Spacing Effect") lifted its note into an endnotes
    // section + kept a [1] marker (proving footnotes are preserved, not dropped).
    const noteTopic = topics.find((t) => t.title === "The Spacing Effect");
    expect(noteTopic).toBeDefined();
    const noteDoc = svc.repos.documents.findById(noteTopic?.id as never);
    expect(noteDoc?.plainText).toContain("[1]");
    expect(noteDoc?.plainText).toContain("Ebbinghaus");

    // The right ops were appended (book source + a chapter relation).
    const bookOps = svc.repos.operationLog.listForElement(bookId as never).map((e) => e.opType);
    expect(bookOps).toContain("create_element");
    expect(bookOps).toContain("create_source");
    expect(bookOps).toContain("update_document");
    expect(bookOps).toContain("add_relation");

    svc.close();
  });

  it("imports an EPUB2 (toc.ncx) book + resolves NCX chapter titles", async () => {
    const svc = openSvc();
    const fixture = path.join(FIXTURES, "epub2-toc-ncx.epub");
    const { bookId, chapterCount } = await svc.epubImportService.importFromFile({
      absPath: fixture,
    });
    expect(chapterCount).toBe(2);
    const titles = svc.repos.elements
      .listChildren(bookId as never)
      .filter((c) => c.type === "topic")
      .map((c) => c.title)
      .sort();
    expect(titles).toEqual(["Closing", "Opening"]);
    svc.close();
  });

  it("survives re-opening the DB on the same file (restart-persistence)", async () => {
    const svc = openSvc();
    const fixture = path.join(FIXTURES, "epub3-three-chapters.epub");
    const { bookId } = await svc.epubImportService.importFromFile({ absPath: fixture });
    svc.close();

    const reopened = openSvc();
    const book = reopened.repos.sources.findById(bookId as never);
    expect(book?.source.snapshotKey).toBe(`sources/${bookId}/original.epub`);
    const topics = reopened.repos.elements
      .listChildren(bookId as never)
      .filter((c) => c.type === "topic");
    expect(topics).toHaveLength(3);
    // The chapter bodies + their book anchors persist.
    for (const topic of topics) {
      expect(reopened.repos.documents.listBlocks(topic.id).length).toBeGreaterThan(0);
      expect(reopened.repos.sources.findLocationForElement(topic.id)?.sourceElementId).toBe(bookId);
    }
    // The .epub file + asset row survive.
    expect(fs.existsSync(path.join(assetsDir, "sources", bookId, "original.epub"))).toBe(true);
    expect(
      reopened.repos.assets.listForElement(bookId as never).some((a) => a.kind === "source_epub"),
    ).toBe(true);
    reopened.close();
  });

  it("rejects a malformed .epub with a typed error + writes no source/asset/file", async () => {
    const svc = openSvc();
    const fixture = path.join(FIXTURES, "malformed.epub");
    const before = svc.listInbox().items.length;
    await expect(svc.epubImportService.importFromFile({ absPath: fixture })).rejects.toBeInstanceOf(
      EpubImportError,
    );
    await expect(svc.epubImportService.importFromFile({ absPath: fixture })).rejects.toMatchObject({
      code: "not_a_zip",
    });
    // Nothing landed in the inbox, and no `sources/` dir was left behind.
    expect(svc.listInbox().items.length).toBe(before);
    const sourcesDir = path.join(assetsDir, "sources");
    const entries = fs.existsSync(sourcesDir) ? fs.readdirSync(sourcesDir) : [];
    expect(entries).toHaveLength(0);
    svc.close();
  });

  it("rolls back + removes the vault dir when the transaction fails mid-book", async () => {
    // Force a failure AFTER the .epub is written + the book/asset rows are inserted in
    // the tx (the malformed fixture throws before mkdir, so this is the only path that
    // exercises the `wroteDir` rmSync cleanup). The service holds the SAME sources repo
    // object as `svc.repos.sources`, so stubbing one method makes the in-tx chapter
    // insert throw → the whole tx rolls back → the partial dir is removed.
    const svc = openSvc();
    const fixture = path.join(FIXTURES, "epub3-three-chapters.epub");
    const original = svc.repos.sources.createTopicWithDocumentWithin;
    svc.repos.sources.createTopicWithDocumentWithin = () => {
      throw new Error("injected tx failure");
    };
    const before = svc.listInbox().items.length;

    await expect(svc.epubImportService.importFromFile({ absPath: fixture })).rejects.toThrow(
      "injected tx failure",
    );

    // Restore so the assertions read a clean repo.
    svc.repos.sources.createTopicWithDocumentWithin = original;

    // The book source + asset row rolled back (the tx is atomic), and nothing landed
    // in the inbox.
    expect(svc.listInbox().items.length).toBe(before);
    // The partial `sources/<bookId>/` dir (with the written original.epub) was removed —
    // no orphan files linger after the failure.
    const sourcesDir = path.join(assetsDir, "sources");
    const entries = fs.existsSync(sourcesDir) ? fs.readdirSync(sourcesDir) : [];
    expect(entries).toHaveLength(0);
    svc.close();
  });

  it("rejects a non-.epub extension with code 'not_epub'", async () => {
    const svc = openSvc();
    const notEpub = path.join(dir, "notes.txt");
    fs.writeFileSync(notEpub, "plain text");
    await expect(svc.epubImportService.importFromFile({ absPath: notEpub })).rejects.toMatchObject({
      code: "not_epub",
    });
    svc.close();
  });
});
