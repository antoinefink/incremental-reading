/**
 * EPUB parse-transform tests (T067) — pure, fixture-driven (no I/O beyond reading
 * the committed `.epub` fixtures off disk). They prove `parseEpub` reads the right
 * metadata + spine order + nav/ncx titles, that `chapterToProseMirror` maps a
 * chapter to the constrained schema with stable block ids + lifted footnotes, and
 * that a malformed archive throws the typed `EpubParseError`.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { ALLOWED_MARK_NAMES, ALLOWED_NODE_NAMES, buildSchema } from "@interleave/editor/schema";
import { describe, expect, it } from "vitest";
import { chapterToProseMirror, EpubParseError, type ParsedEpubChapter, parseEpub } from "./epub";

const FIXTURES = path.join(__dirname, "__fixtures__", "epub");

function readFixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(path.join(FIXTURES, name)));
}

const NODE_NAMES = new Set<string>([...ALLOWED_NODE_NAMES, "doc", "text"]);
const MARK_NAMES = new Set<string>([...ALLOWED_MARK_NAMES]);

/** Walk every node in a conversion doc, asserting names + collecting block ids. */
function validateConversion(doc: unknown): { blockIds: string[]; nodeNames: Set<string> } {
  // `nodeFromJSON` throws if the doc violates the constrained schema (no direct
  // `@tiptap/pm/model` import needed — `buildSchema()` builds the node for us).
  expect(() => buildSchema().nodeFromJSON(doc)).not.toThrow();
  const blockIds: string[] = [];
  const nodeNames = new Set<string>();
  const walk = (node: Record<string, unknown>): void => {
    const type = node.type as string;
    nodeNames.add(type);
    const attrs = node.attrs as { blockId?: string } | undefined;
    if (attrs?.blockId) blockIds.push(attrs.blockId);
    for (const mark of (node.marks ?? []) as { type: string }[]) {
      expect(MARK_NAMES.has(mark.type)).toBe(true);
    }
    for (const child of (node.content ?? []) as Record<string, unknown>[]) walk(child);
  };
  walk(doc as Record<string, unknown>);
  for (const name of nodeNames) expect(NODE_NAMES.has(name)).toBe(true);
  return { blockIds, nodeNames };
}

describe("parseEpub (EPUB3)", () => {
  const parsed = parseEpub(readFixture("epub3-three-chapters.epub"));

  it("reads the OPF metadata", () => {
    expect(parsed.metadata.title).toBe("The Memory Book");
    expect(parsed.metadata.author).toBe("Ada Lovelace");
    expect(parsed.metadata.language).toBe("en");
    expect(parsed.metadata.publishedAt).toBe("2021-03-14");
    expect(parsed.metadata.identifier).toBe("urn:uuid:1234-epub3");
  });

  it("returns chapters in spine order with nav titles + 0-based ordinals", () => {
    expect(parsed.chapters.map((c) => c.title)).toEqual([
      "Beginnings",
      "The Spacing Effect",
      "Conclusions",
    ]);
    expect(parsed.chapters.map((c) => c.order)).toEqual([0, 1, 2]);
  });
});

describe("parseEpub (EPUB2 / toc.ncx)", () => {
  const parsed = parseEpub(readFixture("epub2-toc-ncx.epub"));

  it("reads metadata + resolves chapter titles from the NCX", () => {
    expect(parsed.metadata.title).toBe("A Short Reader");
    expect(parsed.metadata.author).toBe("Grace Hopper");
    expect(parsed.metadata.identifier).toBe("isbn-epub2-0001");
    expect(parsed.chapters.map((c) => c.title)).toEqual(["Opening", "Closing"]);
  });
});

describe("chapterToProseMirror", () => {
  const parsed = parseEpub(readFixture("epub3-three-chapters.epub"));
  const byTitle = (t: string): ParsedEpubChapter => {
    const c = parsed.chapters.find((ch) => ch.title === t);
    if (!c) throw new Error(`no chapter ${t}`);
    return c;
  };

  it("maps headings/paragraphs/lists to the constrained schema with unique block ids", () => {
    const conv = chapterToProseMirror(byTitle("Beginnings"));
    const { blockIds, nodeNames } = validateConversion(conv.doc);
    expect(nodeNames.has("heading")).toBe(true);
    expect(nodeNames.has("paragraph")).toBe(true);
    expect(nodeNames.has("bulletList")).toBe(true);
    expect(nodeNames.has("listItem")).toBe(true);
    // Every row-bearing node carries a unique blockId.
    expect(blockIds.length).toBeGreaterThan(0);
    expect(new Set(blockIds).size).toBe(blockIds.length);
    expect(conv.footnotes).toHaveLength(0);
  });

  it("lifts footnotes into an endnotes section + keeps a [n] marker in the body", () => {
    const conv = chapterToProseMirror(byTitle("The Spacing Effect"));
    validateConversion(conv.doc);
    // The note body was lifted out and surfaced as a footnote.
    expect(conv.footnotes).toHaveLength(1);
    expect(conv.footnotes[0]?.marker).toBe("1");
    expect(conv.footnotes[0]?.text).toContain("Ebbinghaus");
    // The in-text [1] marker survives in the body plain text, and butts straight
    // up against the trailing period (no stray space: `practice[1].`, not `[1] .`).
    expect(conv.plainText).toContain("[1]");
    expect(conv.plainText).toContain("massed practice[1].");
    expect(conv.plainText).not.toContain("[1] .");
    // …and the endnotes section ("Notes" heading + the note paragraph) is appended.
    expect(conv.plainText).toContain("Notes");
    expect(conv.plainText).toContain("Ebbinghaus");
  });

  it("threads a shared minter so ids are stable across chapters without collision", () => {
    let counter = 0;
    const mint = () => `blk-${counter++}` as never;
    const a = chapterToProseMirror(byTitle("Beginnings"), mint);
    const b = chapterToProseMirror(byTitle("Conclusions"), mint);
    const ids = (doc: unknown): string[] => validateConversion(doc).blockIds;
    const all = [...ids(a.doc), ...ids(b.doc)];
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("error paths", () => {
  it("throws EpubParseError('not_a_zip') for a non-ZIP file", () => {
    try {
      parseEpub(readFixture("malformed.epub"));
      throw new Error("expected parseEpub to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(EpubParseError);
      expect((err as EpubParseError).code).toBe("not_a_zip");
    }
  });
});
