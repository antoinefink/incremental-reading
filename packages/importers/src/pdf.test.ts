/**
 * Unit tests for the pure PDF transforms (T064), against the tiny committed
 * fixture PDFs under `src/__fixtures__/` (a 2-page text PDF, a heading+body PDF,
 * and a scanned/image-only PDF with no text layer — see `scripts/make-fixtures.mjs`).
 *
 * Proves: `extractPdfPages` returns the right page count + non-empty lines for the
 * text PDFs and `hasText: false` for the scanned PDF; `pdfPagesToProseMirrorDoc`
 * maps each page to a "Page N" heading + the page paragraphs (each block tagged
 * with its `page`), produces a doc that VALIDATES against `buildSchema()` with
 * every node ∈ `ALLOWED_NODE_NAMES` / mark ∈ `ALLOWED_MARK_NAMES`, gives every
 * row-bearing node a unique stable id, and maps the scanned PDF to "Page N"
 * headings with empty bodies (no crash).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BlockId } from "@interleave/core";
// The React-free schema subpath (no `SourceEditor`/JSX) so the importers tsconfig
// — which does not set `--jsx` — typechecks the test, matching how the production
// transforms import `@interleave/editor/block-ids`.
import { ALLOWED_MARK_NAMES, ALLOWED_NODE_NAMES, buildSchema } from "@interleave/editor/schema";
import { describe, expect, it } from "vitest";
import { extractPdfPages } from "./pdf-text";
import { pdfPagesToProseMirrorDoc } from "./pdf-to-prosemirror";

const here = path.dirname(fileURLToPath(import.meta.url));

function readFixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(path.join(here, "__fixtures__", name)));
}

/** A deterministic block-id minter (so tests can assert specific ids/uniqueness). */
function counterMinter(): () => BlockId {
  let n = 0;
  return () => `blk-${++n}` as BlockId;
}

/** Assert the doc validates against the constrained editor schema. */
function assertValidatesAgainstSchema(doc: unknown): void {
  const schema = buildSchema();
  // `Schema.nodeFromJSON` throws on a disallowed node/mark/attr, so a clean parse
  // proves the doc is admissible — no direct `@tiptap/pm` import needed.
  expect(() => schema.nodeFromJSON(doc)).not.toThrow();
  const node = schema.nodeFromJSON(doc);
  const allowedNodes = new Set<string>(ALLOWED_NODE_NAMES);
  const allowedMarks = new Set<string>(ALLOWED_MARK_NAMES);
  node.descendants((child) => {
    expect(allowedNodes.has(child.type.name)).toBe(true);
    for (const mark of child.marks) expect(allowedMarks.has(mark.type.name)).toBe(true);
    return true;
  });
  expect(allowedNodes.has(node.type.name)).toBe(true);
}

describe("extractPdfPages", () => {
  it("returns per-page text lines for a 2-page text PDF", async () => {
    const pages = await extractPdfPages(readFixture("two-page-text.pdf"));
    expect(pages).toHaveLength(2);
    expect(pages[0]?.pageNumber).toBe(1);
    expect(pages[1]?.pageNumber).toBe(2);
    expect(pages[0]?.hasText).toBe(true);
    expect(pages[1]?.hasText).toBe(true);
    expect(pages[0]?.lines.length).toBeGreaterThan(0);
    // The lines carry the real text + top-down boxes.
    expect(pages[0]?.lines.map((l) => l.text).join(" ")).toContain("spaced repetition");
    expect(pages[1]?.lines.map((l) => l.text).join(" ")).toContain("forgetting curve");
    for (const line of pages[0]?.lines ?? []) {
      expect(line.width).toBeGreaterThan(0);
      // y is measured from the page top, so it is within [0, height].
      expect(line.y).toBeGreaterThanOrEqual(0);
      expect(line.y).toBeLessThanOrEqual(pages[0]?.height ?? 0);
    }
  });

  it("returns hasText:false for every page of a scanned/image-only PDF", async () => {
    const pages = await extractPdfPages(readFixture("scanned-no-text.pdf"));
    expect(pages.length).toBeGreaterThanOrEqual(1);
    for (const page of pages) {
      expect(page.hasText).toBe(false);
      expect(page.lines).toHaveLength(0);
    }
  });

  it("extracts the heading + body lines of a single-page PDF", async () => {
    const pages = await extractPdfPages(readFixture("heading-body.pdf"));
    expect(pages).toHaveLength(1);
    expect(pages[0]?.hasText).toBe(true);
    const text = pages[0]?.lines.map((l) => l.text).join(" ") ?? "";
    expect(text).toContain("The Spacing Effect");
    expect(text).toContain("cramming");
  });
});

describe("pdfPagesToProseMirrorDoc", () => {
  it("maps a 2-page PDF to two 'Page N' headings + page paragraphs, each block tagged with its page", async () => {
    const pages = await extractPdfPages(readFixture("two-page-text.pdf"));
    const conversion = pdfPagesToProseMirrorDoc(pages, counterMinter());

    // Two page-headings, in order, each level-3.
    const headings = conversion.blocks.filter((b) => b.blockType === "heading");
    expect(headings).toHaveLength(2);
    expect(headings[0]?.page).toBe(1);
    expect(headings[1]?.page).toBe(2);

    // Every block carries a page (1 or 2), and the paragraphs follow their heading.
    expect(conversion.blocks.every((b) => b.page === 1 || b.page === 2)).toBe(true);
    const page1Blocks = conversion.blocks.filter((b) => b.page === 1);
    const page2Blocks = conversion.blocks.filter((b) => b.page === 2);
    expect(page1Blocks.length).toBeGreaterThan(1); // heading + ≥1 paragraph
    expect(page2Blocks.length).toBeGreaterThan(1);

    // The doc node content opens with a "Page 1" heading.
    const firstNode = (conversion.doc.content[0] ?? null) as {
      type: string;
      attrs?: { level?: number };
      content?: { text?: string }[];
    } | null;
    expect(firstNode?.type).toBe("heading");
    expect(firstNode?.attrs?.level).toBe(3);
    expect(firstNode?.content?.[0]?.text).toBe("Page 1");

    // The plainText mirror is page-prefixed and search-friendly.
    expect(conversion.plainText).toContain("Page 1");
    expect(conversion.plainText).toContain("Page 2");
    expect(conversion.plainText).toContain("spaced repetition");

    // Every row-bearing node has a UNIQUE stable id.
    const ids = conversion.blocks.map((b) => b.stableBlockId);
    expect(new Set(ids).size).toBe(ids.length);

    // The doc validates against the constrained schema.
    assertValidatesAgainstSchema(conversion.doc);
  });

  it("maps a scanned PDF to 'Page N' headings with empty bodies (no crash)", async () => {
    const pages = await extractPdfPages(readFixture("scanned-no-text.pdf"));
    const conversion = pdfPagesToProseMirrorDoc(pages, counterMinter());
    // Only headings, no paragraphs (the page has no text).
    expect(conversion.blocks.every((b) => b.blockType === "heading")).toBe(true);
    expect(conversion.blocks.length).toBe(pages.length);
    assertValidatesAgainstSchema(conversion.doc);
  });

  it("maps an empty page list to a valid empty doc", () => {
    const conversion = pdfPagesToProseMirrorDoc([], counterMinter());
    expect(conversion.doc.content).toHaveLength(0);
    expect(conversion.blocks).toHaveLength(0);
    expect(conversion.plainText).toBe("");
    assertValidatesAgainstSchema(conversion.doc);
  });
});
