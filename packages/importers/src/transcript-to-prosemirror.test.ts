import type { BlockId } from "@interleave/core";
import { describe, expect, it } from "vitest";
import { NO_TRANSCRIPT_PLACEHOLDER, transcriptToProseMirrorDoc } from "./transcript-to-prosemirror";

function minter(): () => BlockId {
  let n = 0;
  return () => `cue-blk-${++n}` as BlockId;
}

describe("transcriptToProseMirrorDoc", () => {
  it("formats cue timestamps, trims the title, and stores cue start times on blocks", () => {
    const conversion = transcriptToProseMirrorDoc(
      {
        title: "  Lecture  ",
        cues: [
          { startMs: 42_000, endMs: 45_000, text: "Early cue" },
          { startMs: 3_707_000, endMs: 3_710_000, text: "Hour cue" },
        ],
      },
      minter(),
    );

    expect(conversion.plainText).toBe("Lecture\n[0:42] Early cue\n[1:01:47] Hour cue");
    expect(conversion.blocks).toEqual([
      { blockType: "heading", order: 0, stableBlockId: "cue-blk-1", timestampMs: null },
      { blockType: "paragraph", order: 1, stableBlockId: "cue-blk-2", timestampMs: 42_000 },
      { blockType: "paragraph", order: 2, stableBlockId: "cue-blk-3", timestampMs: 3_707_000 },
    ]);
  });

  it("uses a stable placeholder paragraph but keeps transcript-less plain text title-only", () => {
    const conversion = transcriptToProseMirrorDoc({ title: "", cues: [] }, minter());
    const placeholder = conversion.doc.content[1];
    const firstInline = placeholder?.type === "paragraph" ? placeholder.content?.[0] : null;
    const text = firstInline?.type === "text" ? firstInline.text : null;

    expect(conversion.plainText).toBe("Media");
    expect(text).toBe(NO_TRANSCRIPT_PLACEHOLDER);
    expect(conversion.blocks[1]).toEqual({
      blockType: "paragraph",
      order: 1,
      stableBlockId: "cue-blk-2",
      timestampMs: null,
    });
  });
});
