/**
 * MediaReader clip-anchor tests (T074 — hardening).
 *
 * Covers the renderer seam the spec calls out for the TRANSCRIPT-LESS clip path:
 *  - a transcript-less media body is a title heading + ONE placeholder paragraph
 *    ("No transcript available."). The spec says a transcript-less clip anchors to
 *    "the placeholder block id" — so when the user sets an in/out point with the
 *    `[`/`]` keys (no cues to Shift-click) and confirms, `sources.extractClip` is
 *    called with `anchorBlockId` = the PLACEHOLDER paragraph's block id, NOT the
 *    title heading (which stays the read-point anchor).
 *
 * The component is presentational: it ships only the window + the anchor block id +
 * the (null) transcript segment over the mocked `extractClip`. The media element is
 * driven with a synthetic `timeUpdate` to advance `currentMs`. No SQLite/IPC/fs.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  getMediaData: vi.fn(),
  getReadPoint: vi.fn(),
  extractClip: vi.fn(),
  toast: vi.fn(),
  onClipExtracted: vi.fn(),
}));

vi.mock("../../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../../lib/appApi")>("../../lib/appApi");
  return {
    ...actual,
    isDesktop: () => true,
    appApi: {
      getMediaData: h.getMediaData,
      getReadPoint: h.getReadPoint,
      extractClip: h.extractClip,
    },
  };
});

import { MediaReader } from "./MediaReader";

const TITLE_BLOCK = "mblk-title";
const PLACEHOLDER_BLOCK = "mblk-ph";

/** A transcript-LESS media body: a title heading + ONE placeholder paragraph. */
const TRANSCRIPTLESS_DOC = {
  type: "doc",
  content: [
    {
      type: "heading",
      attrs: { level: 2, blockId: TITLE_BLOCK },
      content: [{ type: "text", text: "An untitled clip" }],
    },
    {
      type: "paragraph",
      attrs: { blockId: PLACEHOLDER_BLOCK },
      content: [{ type: "text", text: "No transcript available." }],
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  h.getMediaData.mockResolvedValue({
    mediaSource: "local",
    mediaKind: "video",
    mediaUrl: "media://src_1",
    mime: "video/mp4",
    youtubeId: null,
    durationMs: 60_000,
  });
  h.getReadPoint.mockResolvedValue({ readPoint: null });
  h.extractClip.mockResolvedValue({ id: "frag_1", element: {}, location: {} });
});

function renderReader() {
  return render(
    <MediaReader
      elementId="src_1"
      prosemirrorJson={TRANSCRIPTLESS_DOC}
      blockTimestamps={{}} // no cue timestamps → transcript-less
      onClipExtracted={h.onClipExtracted}
      toast={h.toast}
    />,
  );
}

describe("MediaReader transcript-less clip anchor (T074)", () => {
  it("anchors a transcript-less clip to the placeholder block id, not the title heading", async () => {
    renderReader();

    // The transcript-less notice (no cue rows) confirms the placeholder body.
    await waitFor(() => expect(screen.getByTestId("media-reader-noscript")).toBeInTheDocument());
    expect(screen.queryByTestId("media-reader-cue")).not.toBeInTheDocument();

    const video = await screen.findByTestId("media-reader-video");

    // Set the in-point at 0s, advance playback to 5s, set the out-point there.
    fireEvent.keyDown(window, { key: "[" });
    act(() => {
      // Advance currentTime → fires the component's onTimeUpdate (currentMs = 5000).
      Object.defineProperty(video, "currentTime", { value: 5, configurable: true });
      fireEvent.timeUpdate(video);
    });
    fireEvent.keyDown(window, { key: "]" });

    // The confirm popover appears for the valid [0, 5000) window.
    const confirm = await screen.findByTestId("media-clip-confirm");
    expect(confirm).not.toBeDisabled();
    fireEvent.click(confirm);

    await waitFor(() => expect(h.extractClip).toHaveBeenCalledTimes(1));
    const arg = h.extractClip.mock.calls[0]?.[0];
    expect(arg).toMatchObject({
      sourceElementId: "src_1",
      startMs: 0,
      endMs: 5000,
      anchorBlockId: PLACEHOLDER_BLOCK, // the placeholder paragraph, per spec
      transcriptSegment: null, // no cues in range
    });
    expect(arg.anchorBlockId).not.toBe(TITLE_BLOCK);
  });
});
