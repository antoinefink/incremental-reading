import type { BlockId } from "@interleave/core";
import { describe, expect, it } from "vitest";
import { extractHtmlTitle, htmlFileToProseMirrorDoc } from "./html-file";

function counterMint(): () => BlockId {
  let n = 0;
  return () => `blk-${++n}` as BlockId;
}

describe("extractHtmlTitle", () => {
  it("extracts and trims the document title", () => {
    expect(extractHtmlTitle("<html><head><title>  Article title  </title></head></html>")).toBe(
      "Article title",
    );
  });

  it("returns null when the title is absent or empty", () => {
    expect(extractHtmlTitle("<html><body>No title</body></html>")).toBeNull();
    expect(extractHtmlTitle("<title>   </title>")).toBeNull();
  });
});

describe("htmlFileToProseMirrorDoc", () => {
  it("sanitizes untrusted HTML before converting to the constrained document", () => {
    const conversion = htmlFileToProseMirrorDoc(
      `<article>
        <h1 onclick="steal()">Title</h1>
        <script>alert(1)</script>
        <p>Safe <strong>body</strong>.</p>
        <a href="javascript:alert(1)">bad link text</a>
      </article>`,
      counterMint(),
    );

    expect(conversion.plainText).toContain("Title");
    expect(conversion.plainText).toContain("Safe body.");
    expect(conversion.plainText).toContain("bad link text");
    expect(conversion.plainText).not.toContain("alert");
    expect(conversion.blocks.map((b) => b.stableBlockId)).toEqual(["blk-1", "blk-2", "blk-3"]);
  });

  it("returns a valid empty document for empty HTML", () => {
    const conversion = htmlFileToProseMirrorDoc("   ", counterMint());

    expect(conversion.doc).toEqual({ type: "doc", content: [] });
    expect(conversion.plainText).toBe("");
    expect(conversion.blocks).toEqual([]);
  });
});
