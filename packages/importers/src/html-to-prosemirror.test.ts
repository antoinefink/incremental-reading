/**
 * htmlToProseMirrorDoc tests (T060).
 *
 * Pins the HTML→ProseMirror conversion: the constrained node/mark mapping, stable
 * block-id placement (one id per row, on the outermost block — listItem/blockquote
 * carry it, their inner paragraph does not, list containers never do), the
 * parallel `blocks` mirror, the empty-doc edge, AND — the load-bearing assertion —
 * that the produced doc validates against the constrained editor schema:
 * `buildSchema().nodeFromJSON(doc)` does not throw and every node/mark is in
 * the allowed set.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ALLOWED_MARK_NAMES, ALLOWED_NODE_NAMES, buildSchema } from "@interleave/editor/schema";
import { describe, expect, it } from "vitest";
import { htmlToProseMirrorDoc } from "./html-to-prosemirror";
import { extractArticle } from "./readability";
import { sanitizeArticleHtml } from "./sanitize";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const fixture = (name: string): string => readFileSync(path.join(fixturesDir, name), "utf8");

/**
 * A minimal structural shape for a built ProseMirror node — we only walk it for
 * node/mark names, so we avoid importing `@tiptap/pm/model` (not a direct dep;
 * `buildSchema().nodeFromJSON` builds the node for us).
 */
interface BuiltNode {
  readonly type: { readonly name: string };
  readonly marks: readonly { readonly type: { readonly name: string } }[];
  descendants(fn: (node: BuiltNode) => boolean): void;
}

/** A deterministic block-id minter for stable assertions. */
function counterMinter(): () => never {
  let n = 0;
  return (() => `blk-${n++}`) as unknown as () => never;
}

/** Collect every node name + mark name appearing in a built PM document. */
function collectNames(doc: BuiltNode): { nodes: Set<string>; marks: Set<string> } {
  const nodes = new Set<string>();
  const marks = new Set<string>();
  doc.descendants((node) => {
    nodes.add(node.type.name);
    for (const mark of node.marks) marks.add(mark.type.name);
    return true;
  });
  nodes.add(doc.type.name);
  return { nodes, marks };
}

describe("htmlToProseMirrorDoc", () => {
  it("maps headings, paragraphs, lists, blockquotes, and code to the right nodes", () => {
    const html = sanitizeArticleHtml(`
      <h1>Title</h1>
      <h4>Deep heading clamps to 3</h4>
      <p>A <strong>bold</strong> and <em>italic</em> and <a href="https://x.test">linked</a> run.</p>
      <ul><li>one</li><li>two</li></ul>
      <ol><li>first</li></ol>
      <blockquote><p>quoted</p></blockquote>
      <pre><code>const x = 1;</code></pre>
      <hr />`);
    const { doc, blocks } = htmlToProseMirrorDoc(html, counterMinter());
    const types = doc.content.map((n) => n.type);
    expect(types).toEqual([
      "heading",
      "heading",
      "paragraph",
      "bulletList",
      "orderedList",
      "blockquote",
      "codeBlock",
      "horizontalRule",
    ]);
    // h4 clamps to level 3.
    const deep = doc.content[1];
    expect(deep?.type).toBe("heading");
    if (deep?.type === "heading") expect(deep.attrs.level).toBe(3);

    // The parallel block list mirrors the ROW-bearing nodes (list ids on items).
    expect(blocks.map((b) => b.blockType)).toEqual([
      "heading",
      "heading",
      "paragraph",
      "listItem",
      "listItem",
      "listItem",
      "blockquote",
      "codeBlock",
      "horizontalRule",
    ]);
  });

  it("maps strong/em/u/a/code to bold/italic/underline/link/code marks", () => {
    const html = sanitizeArticleHtml(
      `<p><strong>b</strong> <em>i</em> <u>u</u> <code>c</code> <a href="https://x.test/y">L</a></p>`,
    );
    const { doc } = htmlToProseMirrorDoc(html, counterMinter());
    const pm = buildSchema().nodeFromJSON(doc) as unknown as BuiltNode;
    const { marks } = collectNames(pm);
    expect(marks).toEqual(new Set(["bold", "italic", "underline", "code", "link"]));
  });

  it("places exactly one stable block id per row, on the outermost block", () => {
    const html = sanitizeArticleHtml(
      `<ul><li><p>alpha</p></li></ul><blockquote><p>q</p></blockquote>`,
    );
    const { doc, blocks } = htmlToProseMirrorDoc(html, counterMinter());
    const list = doc.content[0];
    expect(list?.type).toBe("bulletList");
    if (list?.type === "bulletList") {
      const item = list.content?.[0];
      // The id lives on the listItem...
      expect(item?.attrs?.blockId).toBe("blk-0");
      // ...not on the list container (no attrs/blockId on bulletList).
      expect((list as { attrs?: unknown }).attrs).toBeUndefined();
      // ...and not on the inner paragraph.
      const innerPara = item?.content?.[0];
      expect((innerPara as { attrs?: { blockId?: string } })?.attrs?.blockId).toBeUndefined();
    }
    const quote = doc.content[1];
    expect(quote?.type).toBe("blockquote");
    if (quote?.type === "blockquote") {
      expect(quote.attrs?.blockId).toBe("blk-1");
      const innerPara = quote.content?.[0];
      expect((innerPara as { attrs?: { blockId?: string } })?.attrs?.blockId).toBeUndefined();
    }
    // The blocks list has exactly the two row-bearing nodes, with unique ids.
    expect(blocks.map((b) => b.stableBlockId)).toEqual(["blk-0", "blk-1"]);
  });

  it("produces a doc that validates against the constrained schema", () => {
    const html = sanitizeArticleHtml(`
      <h1>Doc</h1>
      <p>Para with <strong>marks</strong>.</p>
      <ul><li>item</li></ul>
      <blockquote><p>quote</p></blockquote>
      <pre><code>code()</code></pre>
      <hr />`);
    const { doc } = htmlToProseMirrorDoc(html, counterMinter());
    // The schema accepts the doc — nodeFromJSON throws on any disallowed node/mark.
    const schema = buildSchema();
    expect(() => schema.nodeFromJSON(doc)).not.toThrow();
    const { nodes, marks } = collectNames(schema.nodeFromJSON(doc) as unknown as BuiltNode);
    for (const name of nodes) expect(ALLOWED_NODE_NAMES).toContain(name);
    for (const name of marks) expect(ALLOWED_MARK_NAMES).toContain(name);
  });

  it("returns a valid empty doc for empty / whitespace-only HTML", () => {
    for (const html of ["", "   ", "\n\t  \n"]) {
      const { doc, plainText, blocks } = htmlToProseMirrorDoc(html, counterMinter());
      expect(doc).toEqual({ type: "doc", content: [] });
      expect(plainText).toBe("");
      expect(blocks).toHaveLength(0);
      // Still a valid schema doc.
      expect(() => buildSchema().nodeFromJSON(doc)).not.toThrow();
    }
  });

  it("unwraps wrapper blocks (div/section) so no content is lost", () => {
    const { doc, plainText } = htmlToProseMirrorDoc(
      `<div><section><p>kept</p></section></div>`,
      counterMinter(),
    );
    expect(doc.content.map((n) => n.type)).toEqual(["paragraph"]);
    expect(plainText).toBe("kept");
  });

  it("mirrors the doc into plainText for search/preview", () => {
    const html = sanitizeArticleHtml(`<h1>H</h1><p>First.</p><p>Second.</p>`);
    const { plainText } = htmlToProseMirrorDoc(html, counterMinter());
    expect(plainText).toBe("H\n\nFirst.\n\nSecond.");
  });

  it("converts already-local article images into constrained image nodes", () => {
    const html = sanitizeArticleHtml(`
      <p>Before.</p>
      <p><img src="article-image://src_1/asset_1" alt="Architecture diagram" title="Figure title" width="640" height="480" /></p>
      <p>After.</p>`);
    const { doc, plainText, blocks } = htmlToProseMirrorDoc(html, counterMinter());

    expect(doc.content.map((n) => n.type)).toEqual(["paragraph", "image", "paragraph"]);
    const image = doc.content[1];
    expect(image?.type).toBe("image");
    if (image?.type === "image") {
      expect(image.attrs).toEqual({
        blockId: "blk-1",
        src: "article-image://src_1/asset_1",
        alt: "Architecture diagram",
        title: "Figure title",
        width: 640,
        height: 480,
      });
    }
    expect(plainText).toBe("Before.\n\nArchitecture diagram\n\nAfter.");
    expect(blocks.map((b) => b.blockType)).toEqual(["paragraph", "image", "paragraph"]);
    expect(blocks.map((b) => b.stableBlockId)).toEqual(["blk-0", "blk-1", "blk-2"]);
    expect(() => buildSchema().nodeFromJSON(doc)).not.toThrow();
  });

  it("splits mixed image paragraphs into valid block content", () => {
    const html = sanitizeArticleHtml(
      `<p>Before <img src="article-image://src_1/asset_1" alt="Inline figure" /> after.</p>`,
    );
    const { doc, plainText, blocks } = htmlToProseMirrorDoc(html, counterMinter());

    expect(doc.content.map((n) => n.type)).toEqual(["paragraph", "image", "paragraph"]);
    expect(plainText).toBe("Before\n\nInline figure\n\nafter.");
    expect(blocks.map((b) => b.blockType)).toEqual(["paragraph", "image", "paragraph"]);
    expect(() => buildSchema().nodeFromJSON(doc)).not.toThrow();
  });

  it("keeps images nested in list item and blockquote paragraphs", () => {
    const html = sanitizeArticleHtml(`
      <ul><li><p>Before <img src="article-image://src_1/asset_1" alt="List figure" /> after.</p></li></ul>
      <blockquote><p><img src="article-image://src_1/asset_2" alt="Quote figure" /></p></blockquote>`);
    const { doc, plainText, blocks } = htmlToProseMirrorDoc(html, counterMinter());

    expect(plainText).toContain("List figure");
    expect(plainText).toContain("Quote figure");
    expect(blocks.map((b) => b.blockType)).toEqual(["listItem", "blockquote"]);
    expect(JSON.stringify(doc)).toContain("article-image://src_1/asset_1");
    expect(JSON.stringify(doc)).toContain("article-image://src_1/asset_2");
    expect(() => buildSchema().nodeFromJSON(doc)).not.toThrow();
  });

  it("converts the list-and-blockquote-heavy fixture through the full pipeline", () => {
    // The fixture is the spec's "list-and-blockquote-heavy article"; run the real
    // pipeline (Readability → sanitize → convert) the service uses.
    const article = extractArticle(fixture("structured-article.html"), {
      url: "https://example.com/queue",
    });
    const html = sanitizeArticleHtml(article.contentHtml);
    const { doc, blocks, plainText } = htmlToProseMirrorDoc(html, counterMinter());

    // Every structural element survives as its constrained node type.
    const types = new Set(doc.content.map((n) => n.type));
    expect(types).toContain("heading");
    expect(types).toContain("paragraph");
    expect(types).toContain("bulletList");
    expect(types).toContain("orderedList");
    expect(types).toContain("blockquote");
    expect(types).toContain("codeBlock");
    expect(types).toContain("horizontalRule");

    // The blocks mirror puts ids on list ITEMS, not on the list containers.
    const blockTypes = blocks.map((b) => b.blockType);
    expect(blockTypes).toContain("listItem");
    expect(blockTypes).not.toContain("bulletList");
    expect(blockTypes).not.toContain("orderedList");

    // The prose + the code block content survive into plainText.
    expect(plainText).toContain("A good queue balances three concerns");
    expect(plainText).toContain("high-value material is protected first");
    expect(plainText).toContain("Score each candidate by priority");
    expect(plainText).toContain("import too much material without");
    expect(plainText).toContain("return candidates.sort(byScore)[0];");

    // The whole doc validates against the constrained schema.
    const schema = buildSchema();
    expect(() => schema.nodeFromJSON(doc)).not.toThrow();
    const { nodes, marks } = collectNames(schema.nodeFromJSON(doc) as unknown as BuiltNode);
    for (const name of nodes) expect(ALLOWED_NODE_NAMES).toContain(name);
    for (const name of marks) expect(ALLOWED_MARK_NAMES).toContain(name);
  });
});
