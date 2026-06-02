/**
 * PDF pages → constrained ProseMirror document (T064).
 *
 * PDF text has no semantic blocks, so this imposes a deterministic,
 * lineage-stable structure on the `extractPdfPages` output: each page opens with
 * a `heading` (level 3) "Page N" label, followed by one `paragraph` per detected
 * text line of that page. Every row-bearing node is minted ONE stable `blockId`
 * (the default minter is the editor's ULID; injectable for tests) and is tagged
 * with its 1-based `page` in the parallel `blocks` list — the page number lives
 * ONLY in `blocks[].page` (→ `document_blocks.page`), NOT as a schema attribute
 * (the constrained schema's single additive global attr is `blockId`).
 *
 * The output is the SAME `{ doc, plainText, blocks }` `PlainTextConversion` shape
 * `htmlToProseMirrorDoc` returns, so the source pipeline (`createWithDocument`)
 * stores it verbatim. It validates against `buildSchema()`: every node ∈
 * `ALLOWED_NODE_NAMES`, every mark ∈ `ALLOWED_MARK_NAMES`. A text-free page → a
 * valid "Page N" heading with NO paragraph; empty `pages` → a valid empty doc.
 *
 * `plainText` is the page texts joined with blank lines, each page prefixed with
 * its "Page N" label, so search/preview reads naturally (the same mirror
 * convention `htmlToProseMirrorDoc` uses).
 *
 * Pure: no I/O, no Electron. Imports ONLY the React-free block-id minter from
 * `@interleave/editor/block-ids`.
 */

import type {
  BlockId,
  PlainTextConversion,
  ProseMirrorBlock,
  ProseMirrorBlockNode,
  ProseMirrorHeadingNode,
  ProseMirrorParagraphNode,
} from "@interleave/core";
import { type BlockIdMinter, newBlockId } from "@interleave/editor/block-ids";
import type { PdfPage } from "./pdf-text";

/** The heading level used for the per-page "Page N" label. */
const PAGE_HEADING_LEVEL = 3;

/**
 * Convert parsed PDF pages into the constrained `{ doc, plainText, blocks }`
 * conversion. Each page → a "Page N" heading + one paragraph per line, all
 * id-bearing rows tagged with their 1-based `page` in the `blocks` mirror.
 *
 * @param pages the per-page text from {@link extractPdfPages}.
 * @param mint optional block-id minter (defaults to the editor's ULID minter).
 */
export function pdfPagesToProseMirrorDoc(
  pages: readonly PdfPage[],
  mint: BlockIdMinter = newBlockId,
): PlainTextConversion {
  const content: ProseMirrorBlockNode[] = [];
  const blocks: ProseMirrorBlock[] = [];
  const plainTextParts: string[] = [];

  for (const page of pages) {
    const pageNumber = page.pageNumber;
    const pageLabel = `Page ${pageNumber}`;

    // The page-label heading (one id-bearing row, tagged with the page).
    const headingId = mint();
    const heading: ProseMirrorHeadingNode = {
      type: "heading",
      attrs: { level: PAGE_HEADING_LEVEL, blockId: headingId },
      content: [{ type: "text", text: pageLabel }],
    };
    content.push(heading);
    blocks.push({
      blockType: "heading",
      order: blocks.length,
      stableBlockId: headingId,
      page: pageNumber,
    });

    const pageText: string[] = [pageLabel];
    for (const line of page.lines) {
      const text = line.text.replace(/\s+/g, " ").trim();
      if (text.length === 0) continue;
      const id = mint();
      const paragraph: ProseMirrorParagraphNode = {
        type: "paragraph",
        attrs: { blockId: id },
        content: [{ type: "text", text }],
      };
      content.push(paragraph);
      blocks.push({
        blockType: "paragraph",
        order: blocks.length,
        stableBlockId: id,
        page: pageNumber,
      });
      pageText.push(text);
    }
    plainTextParts.push(pageText.join("\n"));
  }

  return {
    doc: { type: "doc", content },
    // Pages separated by a blank line; each page's lines on their own lines.
    plainText: plainTextParts.join("\n\n"),
    blocks,
  };
}

/** Re-export so callers can build a deterministic test minter. */
/** A stable block id (re-exported for test typing). */
export type { BlockId, BlockIdMinter };
