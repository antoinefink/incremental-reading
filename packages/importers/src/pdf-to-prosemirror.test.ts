import type { BlockId, ProseMirrorBlockNode } from "@interleave/core";
import { describe, expect, it } from "vitest";
import type { PdfPage } from "./pdf-text";
import { pdfPagesToProseMirrorDoc } from "./pdf-to-prosemirror";

function minter(): () => BlockId {
  let n = 0;
  return () => `pdf-blk-${++n}` as BlockId;
}

function stableBlockId(node: ProseMirrorBlockNode): BlockId | undefined {
  if (node.type === "bulletList" || node.type === "orderedList") {
    return undefined;
  }
  return node.attrs?.blockId;
}

describe("pdfPagesToProseMirrorDoc", () => {
  it("normalizes line whitespace and tags every block with its source page", () => {
    const pages: PdfPage[] = [
      {
        pageNumber: 7,
        width: 600,
        height: 800,
        hasText: true,
        lines: [
          { text: "  First   line  ", x: 0, y: 0, width: 10, height: 10 },
          { text: "Second line", x: 0, y: 20, width: 10, height: 10 },
        ],
      },
    ];

    const conversion = pdfPagesToProseMirrorDoc(pages, minter());

    expect(conversion.plainText).toBe("Page 7\nFirst line\nSecond line");
    expect(conversion.blocks).toEqual([
      { blockType: "heading", order: 0, stableBlockId: "pdf-blk-1", page: 7 },
      { blockType: "paragraph", order: 1, stableBlockId: "pdf-blk-2", page: 7 },
      { blockType: "paragraph", order: 2, stableBlockId: "pdf-blk-3", page: 7 },
    ]);
    expect(conversion.doc.content.map((node) => stableBlockId(node))).toEqual([
      "pdf-blk-1",
      "pdf-blk-2",
      "pdf-blk-3",
    ]);
  });

  it("keeps text-free pages as page headings without paragraph blocks", () => {
    const conversion = pdfPagesToProseMirrorDoc(
      [
        {
          pageNumber: 2,
          width: 600,
          height: 800,
          hasText: false,
          lines: [],
        },
      ],
      minter(),
    );

    expect(conversion.plainText).toBe("Page 2");
    expect(conversion.blocks).toEqual([
      { blockType: "heading", order: 0, stableBlockId: "pdf-blk-1", page: 2 },
    ]);
    expect(conversion.doc.content).toHaveLength(1);
  });
});
