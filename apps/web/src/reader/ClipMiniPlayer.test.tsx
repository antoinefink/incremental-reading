/**
 * ClipMiniPlayer tests (T074 — hardening).
 *
 * Covers the inspector mini-player's two media-source branches:
 *  - a LOCAL source mounts an HTML5 `<video>`/`<audio>` seeked/looped over the clip
 *    window (the privileged `media://<sourceId>` URL);
 *  - a YOUTUBE source (whose bytes never leave YouTube) renders an actionable
 *    "play the segment on YouTube" link to `watch?v=<id>&t=<startSeconds>s` — a real
 *    seek to the clip start without the deferred IFrame Player API.
 *
 * Presentational only: it loads the source's playable data through the mocked
 * `sources.getMediaData` and renders. No SQLite/IPC/fs.
 */

import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  getMediaData: vi.fn(),
}));

vi.mock("../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../lib/appApi")>("../lib/appApi");
  return {
    ...actual,
    isDesktop: () => true,
    appApi: { getMediaData: h.getMediaData },
  };
});

import { ClipMiniPlayer } from "./ClipMiniPlayer";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ClipMiniPlayer (T074)", () => {
  it("renders an HTML5 video for a local source", async () => {
    h.getMediaData.mockResolvedValue({
      mediaSource: "local",
      mediaKind: "video",
      mediaUrl: "media://src_1",
      mime: "video/mp4",
      youtubeId: null,
      durationMs: 60_000,
    });
    render(<ClipMiniPlayer sourceElementId="src_1" startMs={42_000} endMs={75_000} />);
    await waitFor(() => expect(screen.getByTestId("clip-mini-video")).toBeInTheDocument());
  });

  it("renders a seek link to the clip start for a YouTube source", async () => {
    h.getMediaData.mockResolvedValue({
      mediaSource: "youtube",
      mediaKind: null,
      mediaUrl: null,
      mime: null,
      youtubeId: "dQw4w9WgXcQ",
      durationMs: 212_000,
    });
    render(<ClipMiniPlayer sourceElementId="src_1" startMs={42_000} endMs={75_000} />);

    const link = await screen.findByTestId("clip-mini-youtube-link");
    // 42_000 ms → 42s; the `&t=` param seeks the YouTube web player to the clip start.
    expect(link).toHaveAttribute("href", "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s");
    expect(link).toHaveAttribute("target", "_blank");
    // The calm caption still shows the precise clip range.
    expect(screen.getByTestId("clip-mini-youtube")).toHaveTextContent("0:42–1:15");
  });

  it("degrades a YouTube source with no video id to a calm caption (no broken link)", async () => {
    h.getMediaData.mockResolvedValue({
      mediaSource: "youtube",
      mediaKind: null,
      mediaUrl: null,
      mime: null,
      youtubeId: null,
      durationMs: null,
    });
    render(<ClipMiniPlayer sourceElementId="src_1" startMs={0} endMs={5000} />);
    await waitFor(() => expect(screen.getByTestId("clip-mini-youtube")).toBeInTheDocument());
    expect(screen.queryByTestId("clip-mini-youtube-link")).not.toBeInTheDocument();
  });
});
