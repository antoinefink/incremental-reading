/**
 * Sanitized-HTML → constrained ProseMirror converter (T060).
 *
 * Walks the SANITIZED article HTML (linkedom DOM) into the SAME
 * `{ doc, plainText, blocks }` `PlainTextConversion` shape `plainTextToProseMirrorDoc`
 * returns — using the WIDENED `@interleave/core` ProseMirror types — so the source
 * pipeline (`createWithDocument`) stores it verbatim. The produced doc validates
 * against the constrained editor schema (`buildSchema()`): every node name is in
 * `ALLOWED_NODE_NAMES`, every mark in `ALLOWED_MARK_NAMES`.
 *
 * Stable block ids (T016) sit on exactly the OUTERMOST block of each row, obeying
 * `shouldCarryBlockId` / `BLOCK_ID_NODE_TYPES`: the id is on a top-level
 * paragraph/heading/codeBlock/horizontalRule/image, or on a
 * `listItem`/`blockquote` (NOT its inner paragraph/image), and NEVER on the
 * `bulletList`/`orderedList`
 * containers. The parallel `blocks` list mirrors those row-bearing nodes so
 * `document_blocks` stays in lock-step with the doc.
 *
 * The module imports ONLY the React-free schema/block-id modules from
 * `@interleave/editor` (`./block-ids` for the minter type) — never the barrel that
 * re-exports `SourceEditor`/React — so it bundles cleanly into the main process.
 *
 * Pure: no network, no `fs`, no Electron. Empty/garbage HTML → a valid empty doc.
 */

import type {
  BlockId,
  PlainTextConversion,
  ProseMirrorBlock,
  ProseMirrorBlockNode,
  ProseMirrorBlockquoteNode,
  ProseMirrorBulletListNode,
  ProseMirrorCodeBlockNode,
  ProseMirrorHeadingLevel,
  ProseMirrorHeadingNode,
  ProseMirrorHorizontalRuleNode,
  ProseMirrorInlineNode,
  ProseMirrorListItemNode,
  ProseMirrorMark,
  ProseMirrorOrderedListNode,
  ProseMirrorParagraphNode,
  ProseMirrorTextNode,
} from "@interleave/core";
import { type BlockIdMinter, newBlockId } from "@interleave/editor/block-ids";
import { parseHTML } from "linkedom";

/** Minimal DOM-node shape we depend on (linkedom matches the standard interface). */
interface MinimalNode {
  readonly nodeType: number;
  readonly nodeName: string;
  readonly textContent: string | null;
  readonly childNodes: ArrayLike<MinimalNode>;
  getAttribute?(name: string): string | null;
}

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const ARTICLE_IMAGE_SRC_RE = /^article-image:\/\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/;
const MAX_IMAGE_DIMENSION = 20_000;
const MAX_IMAGE_TEXT_ATTR_LENGTH = 500;

/** Map an `h1`–`h6` tag to a clamped 1–3 heading level (per ALLOWED_HEADING_LEVELS). */
function headingLevel(tag: string): ProseMirrorHeadingLevel {
  const n = Number.parseInt(tag.slice(1), 10);
  if (n <= 1) return 1;
  if (n === 2) return 2;
  return 3;
}

/** Children of a node as a plain array. */
function childrenOf(node: MinimalNode): MinimalNode[] {
  return Array.from(node.childNodes);
}

function hasImageDescendant(node: MinimalNode): boolean {
  for (const child of childrenOf(node)) {
    if (child.nodeType !== ELEMENT_NODE) continue;
    if (child.nodeName.toLowerCase() === "img") return true;
    if (hasImageDescendant(child)) return true;
  }
  return false;
}

function cleanImageSrc(value: string | null | undefined): string | null {
  if (!value) return null;
  const src = value.trim();
  return ARTICLE_IMAGE_SRC_RE.test(src) ? src : null;
}

function replaceControlCharacters(value: string): string {
  return Array.from(value, (char) => {
    const code = char.charCodeAt(0);
    return code < 0x20 || code === 0x7f ? " " : char;
  }).join("");
}

function cleanImageTextAttr(value: string | null | undefined): string | null {
  if (!value) return null;
  const text = replaceControlCharacters(value)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_IMAGE_TEXT_ATTR_LENGTH);
  return text.length > 0 ? text : null;
}

function cleanImageDimension(value: string | null | undefined): number | null {
  if (!value) return null;
  const raw = value.trim();
  if (!/^[1-9]\d{0,4}$/.test(raw)) return null;
  const dimension = Number.parseInt(raw, 10);
  return dimension <= MAX_IMAGE_DIMENSION ? dimension : null;
}

/** The active inline marks while walking inline content. */
type MarkSet = readonly ProseMirrorMark[];

/** Add a mark to the set (deduped by type — one of each is enough for our schema). */
function withMark(marks: MarkSet, mark: ProseMirrorMark): MarkSet {
  if (marks.some((m) => m.type === mark.type)) return marks;
  return [...marks, mark];
}

/**
 * Walk a node's inline descendants into ProseMirror inline nodes (text runs with
 * marks + hard breaks). Block-level children encountered inside inline context
 * are flattened to their text (the sanitizer should have prevented most, but be
 * defensive). Collapses runs of whitespace within a run; trims nothing here
 * (block assembly trims).
 */
function collectInline(node: MinimalNode, marks: MarkSet, out: ProseMirrorInlineNode[]): void {
  for (const child of childrenOf(node)) {
    if (child.nodeType === TEXT_NODE) {
      const text = (child.textContent ?? "").replace(/\s+/g, " ");
      if (text.length === 0) continue;
      const run: ProseMirrorTextNode =
        marks.length > 0 ? { type: "text", text, marks: [...marks] } : { type: "text", text };
      out.push(run);
      continue;
    }
    if (child.nodeType !== ELEMENT_NODE) continue;
    const tag = child.nodeName.toLowerCase();
    if (tag === "br") {
      out.push({ type: "hardBreak" });
      continue;
    }
    if (tag === "strong" || tag === "b") {
      collectInline(child, withMark(marks, { type: "bold" }), out);
      continue;
    }
    if (tag === "em" || tag === "i") {
      collectInline(child, withMark(marks, { type: "italic" }), out);
      continue;
    }
    if (tag === "u") {
      collectInline(child, withMark(marks, { type: "underline" }), out);
      continue;
    }
    if (tag === "code") {
      collectInline(child, withMark(marks, { type: "code" }), out);
      continue;
    }
    if (tag === "a") {
      const href = child.getAttribute?.("href") ?? null;
      const next = href ? withMark(marks, { type: "link", attrs: { href } }) : marks;
      collectInline(child, next, out);
      continue;
    }
    // Any other inline element (shouldn't survive sanitize) ⇒ keep its text.
    collectInline(child, marks, out);
  }
}

/** Trim leading/trailing whitespace-only text runs off an inline list. */
function trimInline(nodes: ProseMirrorInlineNode[]): ProseMirrorInlineNode[] {
  const trimmed = [...nodes];
  while (trimmed.length > 0) {
    const first = trimmed[0];
    if (first && first.type === "text" && first.text.trim().length === 0) trimmed.shift();
    else break;
  }
  while (trimmed.length > 0) {
    const last = trimmed[trimmed.length - 1];
    if (last && last.type === "text" && last.text.trim().length === 0) trimmed.pop();
    else break;
  }
  return trimmed;
}

/** Flatten inline nodes to their concatenated text (for the plainText mirror). */
function inlineText(nodes: readonly ProseMirrorInlineNode[]): string {
  return nodes
    .map((n) => (n.type === "text" ? n.text : " "))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

function imagePlainText(attrs: {
  readonly alt?: string | null;
  readonly title?: string | null;
}): string {
  return attrs.alt ?? attrs.title ?? "";
}

/** Accumulator threaded through the walk: the doc blocks + the parallel block list + plainText. */
interface Acc {
  readonly mint: BlockIdMinter;
  readonly blocks: ProseMirrorBlock[];
  readonly plainText: string[];
}

/** Push a row-bearing block descriptor mirroring an id-bearing node. */
function recordBlock(acc: Acc, blockType: ProseMirrorBlock["blockType"], id: BlockId): void {
  acc.blocks.push({ blockType, order: acc.blocks.length, stableBlockId: id });
}

/** Build a paragraph node from a DOM element, recording its row block. */
function buildParagraph(el: MinimalNode, acc: Acc): ProseMirrorParagraphNode | null {
  const inline = trimInline(
    ((): ProseMirrorInlineNode[] => {
      const out: ProseMirrorInlineNode[] = [];
      collectInline(el, [], out);
      return out;
    })(),
  );
  if (inline.length === 0) return null;
  const id = acc.mint();
  recordBlock(acc, "paragraph", id);
  acc.plainText.push(inlineText(inline));
  return { type: "paragraph", attrs: { blockId: id }, content: inline };
}

/** Build a heading node (level 1–3), recording its row block. */
function buildHeading(el: MinimalNode, tag: string, acc: Acc): ProseMirrorHeadingNode | null {
  const inline = trimInline(
    ((): ProseMirrorInlineNode[] => {
      const out: ProseMirrorInlineNode[] = [];
      collectInline(el, [], out);
      return out;
    })(),
  );
  if (inline.length === 0) return null;
  const id = acc.mint();
  recordBlock(acc, "heading", id);
  acc.plainText.push(inlineText(inline));
  return { type: "heading", attrs: { level: headingLevel(tag), blockId: id }, content: inline };
}

/**
 * Build a code block — a single plain-text run, recording its row block. Code
 * indentation is load-bearing, so we deliberately PRESERVE leading whitespace
 * (only trailing whitespace is trimmed) and mirror the SAME text into plainText
 * so the doc body and the search/preview mirror never diverge.
 */
function buildCodeBlock(el: MinimalNode, acc: Acc): ProseMirrorCodeBlockNode | null {
  const text = (el.textContent ?? "").replace(/\r\n?/g, "\n").replace(/\s+$/, "");
  if (text.length === 0) return null;
  const id = acc.mint();
  recordBlock(acc, "codeBlock", id);
  acc.plainText.push(text);
  return { type: "codeBlock", attrs: { blockId: id }, content: [{ type: "text", text }] };
}

/** Build a horizontal rule, recording its row block. */
function buildHorizontalRule(acc: Acc): ProseMirrorHorizontalRuleNode {
  const id = acc.mint();
  recordBlock(acc, "horizontalRule", id);
  return { type: "horizontalRule", attrs: { blockId: id } };
}

/** Build a constrained article image block from an already-sanitized local img. */
function buildImage(
  el: MinimalNode,
  acc: Acc,
  options: { readonly recordRow?: boolean } = {},
): ProseMirrorBlockNode | null {
  const src = cleanImageSrc(el.getAttribute?.("src"));
  if (!src) return null;
  const recordRow = options.recordRow ?? true;
  const id = recordRow ? acc.mint() : null;

  const attrs = {
    ...(id ? { blockId: id } : {}),
    src,
    alt: cleanImageTextAttr(el.getAttribute?.("alt")),
    title: cleanImageTextAttr(el.getAttribute?.("title")),
    width: cleanImageDimension(el.getAttribute?.("width")),
    height: cleanImageDimension(el.getAttribute?.("height")),
  };
  const text = imagePlainText(attrs);
  if (id) recordBlock(acc, "image", id);
  if (text.length > 0) acc.plainText.push(text);

  return {
    type: "image",
    attrs,
  } satisfies ProseMirrorBlockNode;
}

function pushIdlessParagraph(
  out: ProseMirrorBlockNode[],
  acc: Acc,
  inline: ProseMirrorInlineNode[],
): void {
  const trimmed = trimInline(inline);
  if (trimmed.length === 0) return;
  acc.plainText.push(inlineText(trimmed));
  out.push({ type: "paragraph", content: trimmed });
}

function buildInnerParagraphWithImages(
  el: MinimalNode,
  acc: Acc,
  out: ProseMirrorBlockNode[],
): void {
  let directInline: ProseMirrorInlineNode[] = [];
  const flush = (): void => {
    pushIdlessParagraph(out, acc, directInline);
    directInline = [];
  };

  const walkChildren = (nodes: readonly MinimalNode[]): void => {
    for (const node of nodes) {
      if (node.nodeType === TEXT_NODE) {
        const text = (node.textContent ?? "").replace(/\s+/g, " ");
        if (text.trim().length > 0) directInline.push({ type: "text", text });
        continue;
      }
      if (node.nodeType !== ELEMENT_NODE) continue;
      const tag = node.nodeName.toLowerCase();
      if (tag === "img") {
        flush();
        const image = buildImage(node, acc, { recordRow: false });
        if (image) out.push(image);
        continue;
      }
      if (hasImageDescendant(node)) {
        walkChildren(childrenOf(node));
        continue;
      }
      collectInline(node, [], directInline);
    }
  };

  walkChildren(childrenOf(el));
  flush();
}

/**
 * Build the inner block children of a blockquote / list item — a wrapper whose id
 * lives on the wrapper, so the inner paragraphs/blocks carry NO id (per
 * `shouldCarryBlockId`). We therefore build inner paragraphs WITHOUT minting +
 * recording a row block for them.
 */
function buildInnerBlocks(el: MinimalNode, acc: Acc): ProseMirrorBlockNode[] {
  const out: ProseMirrorBlockNode[] = [];
  // Inline-only content (e.g. a `<li>text</li>`) becomes a single id-less paragraph.
  const directInline: ProseMirrorInlineNode[] = [];
  const flushInline = (): void => {
    const trimmed = trimInline(directInline);
    if (trimmed.length > 0) {
      acc.plainText.push(inlineText(trimmed));
      out.push({ type: "paragraph", content: trimmed });
    }
    directInline.length = 0;
  };

  for (const child of childrenOf(el)) {
    if (child.nodeType === TEXT_NODE) {
      const text = (child.textContent ?? "").replace(/\s+/g, " ");
      if (text.trim().length > 0) directInline.push({ type: "text", text });
      continue;
    }
    if (child.nodeType !== ELEMENT_NODE) continue;
    const tag = child.nodeName.toLowerCase();
    if (tag === "p") {
      flushInline();
      if (hasImageDescendant(child)) {
        buildInnerParagraphWithImages(child, acc, out);
        continue;
      }
      const inner = trimInline(
        ((): ProseMirrorInlineNode[] => {
          const o: ProseMirrorInlineNode[] = [];
          collectInline(child, [], o);
          return o;
        })(),
      );
      if (inner.length > 0) {
        acc.plainText.push(inlineText(inner));
        out.push({ type: "paragraph", content: inner });
      }
      continue;
    }
    if (tag === "ul" || tag === "ol") {
      flushInline();
      const list = buildList(child, tag, acc);
      if (list) out.push(list);
      continue;
    }
    if (tag === "img") {
      flushInline();
      const image = buildImage(child, acc, { recordRow: false });
      if (image) out.push(image);
      continue;
    }
    if (tag === "blockquote") {
      flushInline();
      const quote = buildBlockquote(child, acc);
      if (quote) out.push(quote);
      continue;
    }
    if (/^h[1-6]$/.test(tag)) {
      flushInline();
      const inner = trimInline(
        ((): ProseMirrorInlineNode[] => {
          const o: ProseMirrorInlineNode[] = [];
          collectInline(child, [], o);
          return o;
        })(),
      );
      if (inner.length > 0) {
        acc.plainText.push(inlineText(inner));
        out.push({ type: "paragraph", content: inner });
      }
      continue;
    }
    // Inline element (strong/em/u/a/code/br) directly inside the wrapper.
    collectInline(child, [], directInline);
  }
  flushInline();
  return out;
}

/** Build a blockquote (id on the quote; inner paragraphs id-less). */
function buildBlockquote(el: MinimalNode, acc: Acc): ProseMirrorBlockquoteNode | null {
  const id = acc.mint();
  recordBlock(acc, "blockquote", id);
  const inner = buildInnerBlocks(el, acc);
  const content = inner.length > 0 ? inner : [{ type: "paragraph" as const }];
  return { type: "blockquote", attrs: { blockId: id }, content };
}

/** Build a list item (id on the item; inner paragraphs id-less). */
function buildListItem(el: MinimalNode, acc: Acc): ProseMirrorListItemNode | null {
  const id = acc.mint();
  recordBlock(acc, "listItem", id);
  const inner = buildInnerBlocks(el, acc);
  const content = inner.length > 0 ? inner : [{ type: "paragraph" as const }];
  if (content[0]?.type !== "paragraph") content.unshift({ type: "paragraph" });
  return { type: "listItem", attrs: { blockId: id }, content };
}

/** Build a bullet/ordered list container (NO id; ids live on its items). */
function buildList(
  el: MinimalNode,
  tag: "ul" | "ol",
  acc: Acc,
): ProseMirrorBulletListNode | ProseMirrorOrderedListNode | null {
  const items: ProseMirrorListItemNode[] = [];
  for (const child of childrenOf(el)) {
    if (child.nodeType !== ELEMENT_NODE) continue;
    if (child.nodeName.toLowerCase() !== "li") continue;
    const item = buildListItem(child, acc);
    if (item) items.push(item);
  }
  if (items.length === 0) return null;
  return tag === "ul"
    ? { type: "bulletList", content: items }
    : { type: "orderedList", content: items };
}

/** Walk a top-level (block) DOM element into 0..1 top-level constrained block node. */
function buildTopLevel(el: MinimalNode, acc: Acc): ProseMirrorBlockNode | null {
  const tag = el.nodeName.toLowerCase();
  if (/^h[1-6]$/.test(tag)) return buildHeading(el, tag, acc);
  if (tag === "p") return buildParagraph(el, acc);
  if (tag === "blockquote") return buildBlockquote(el, acc);
  if (tag === "ul" || tag === "ol") return buildList(el, tag, acc);
  if (tag === "pre") return buildCodeBlock(el, acc);
  if (tag === "hr") return buildHorizontalRule(acc);
  if (tag === "img") return buildImage(el, acc);
  // An unknown / wrapper block (div, section, article, code-as-block) ⇒ treat its
  // children as top-level so we never silently lose content. Falls through below.
  return null;
}

/**
 * Convert SANITIZED article HTML into the constrained `{ doc, plainText, blocks }`
 * `PlainTextConversion`. Empty/garbage HTML → a valid empty doc.
 *
 * @param html the SANITIZED article HTML (run {@link sanitizeArticleHtml} first).
 * @param mint optional block-id minter (defaults to the editor's ULID minter).
 */
export function htmlToProseMirrorDoc(
  html: string,
  mint: BlockIdMinter = newBlockId,
): PlainTextConversion {
  const acc: Acc = { mint, blocks: [], plainText: [] };
  const content: ProseMirrorBlockNode[] = [];

  const trimmed = html.trim();
  if (trimmed.length === 0) {
    return { doc: { type: "doc", content: [] }, plainText: "", blocks: [] };
  }

  const { document } = parseHTML(`<body>${trimmed}</body>`);
  const body = document.querySelector("body");
  if (!body) {
    return { doc: { type: "doc", content: [] }, plainText: "", blocks: [] };
  }

  // Walk the body's children. Top-level inline/text becomes a paragraph; wrapper
  // blocks (div/section/article) are unwrapped one level so we never lose content.
  const queue: MinimalNode[] = childrenOf(body as unknown as MinimalNode);
  let pendingInline: ProseMirrorInlineNode[] = [];
  const flushPendingInline = (): void => {
    const inline = trimInline(pendingInline);
    if (inline.length > 0) {
      const id = acc.mint();
      recordBlock(acc, "paragraph", id);
      acc.plainText.push(inlineText(inline));
      content.push({ type: "paragraph", attrs: { blockId: id }, content: inline });
    }
    pendingInline = [];
  };

  const KNOWN_BLOCK = /^(h[1-6]|p|blockquote|ul|ol|pre|hr|img)$/;
  const walk = (nodes: MinimalNode[]): void => {
    for (const node of nodes) {
      if (node.nodeType === TEXT_NODE) {
        const text = (node.textContent ?? "").replace(/\s+/g, " ");
        if (text.trim().length > 0) pendingInline.push({ type: "text", text });
        continue;
      }
      if (node.nodeType !== ELEMENT_NODE) continue;
      const tag = node.nodeName.toLowerCase();
      if (tag === "p" && hasImageDescendant(node)) {
        flushPendingInline();
        walk(childrenOf(node));
        continue;
      }
      if (KNOWN_BLOCK.test(tag)) {
        flushPendingInline();
        const built = buildTopLevel(node, acc);
        if (built) content.push(built);
        continue;
      }
      if (tag === "br") {
        // A bare top-level <br> has no children for collectInline to walk, so emit
        // the hardBreak directly (only meaningful once some inline text precedes it).
        if (pendingInline.length > 0) pendingInline.push({ type: "hardBreak" });
        continue;
      }
      if (
        tag === "strong" ||
        tag === "b" ||
        tag === "em" ||
        tag === "i" ||
        tag === "u" ||
        tag === "code" ||
        tag === "a"
      ) {
        if (hasImageDescendant(node)) {
          walk(childrenOf(node));
          continue;
        }
        // Inline element at the top level ⇒ accumulate into a paragraph.
        collectInline(node, [], pendingInline);
        continue;
      }
      // Wrapper block (div/section/article/…) ⇒ recurse into its children.
      flushPendingInline();
      walk(childrenOf(node));
    }
  };
  walk(queue);
  flushPendingInline();

  return {
    doc: { type: "doc", content },
    plainText: acc.plainText.join("\n\n"),
    blocks: acc.blocks,
  };
}
