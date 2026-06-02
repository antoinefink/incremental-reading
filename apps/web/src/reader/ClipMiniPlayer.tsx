/**
 * ClipMiniPlayer (T074) — a looping mini player for a media `media_fragment` clip.
 *
 * A clip is a `{ startMs, endMs }` TIME WINDOW onto the ORIGINAL media (NO re-encoding,
 * no sub-file). This player loads the playable data for the clip's media SOURCE through
 * the typed `sources.getMediaData` command (the renderer never resolves a vault path),
 * then loops the `[startMs, endMs)` window by seeking the original element back to
 * `startMs` when it reaches `endMs`.
 *
 * The loop boundary is driven by a `requestAnimationFrame` time check (NOT the coarse
 * `timeupdate` event, which fires only ~4×/sec and would overrun a short clip by up to
 * ~250 ms — audible on tight clips); `timeupdate` is kept only as a coarse safety net.
 * This is the same precise re-seek the T075 audio card uses.
 *
 * For a LOCAL source it plays the privileged `media://<sourceElementId>` URL in an HTML5
 * `<video>`/`<audio>`; for a YouTube source it shows a calm placeholder + an actionable
 * "play the segment" link to `youtube.com/watch?v=<id>&t=<startSeconds>s` (YouTube's `t`
 * param seeks the web player to the clip start — a real seek without the IFrame Player
 * API, whose in-frame loop lands with the audio card). Pure UI: typed commands only —
 * no fs/fetch/parse/SQL.
 */

import { useEffect, useRef, useState } from "react";
import { appApi, isDesktop, type SourcesGetMediaDataResult } from "../lib/appApi";

export interface ClipMiniPlayerProps {
  /** The media SOURCE element id (the original asset to seek). */
  readonly sourceElementId: string;
  /** The clip start in milliseconds. */
  readonly startMs: number;
  /** The clip end in milliseconds. */
  readonly endMs: number;
}

/** Format ms as `m:ss` for the clip caption. */
function fmt(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function ClipMiniPlayer({ sourceElementId, startMs, endMs }: ClipMiniPlayerProps) {
  const desktop = isDesktop();
  const [media, setMedia] = useState<SourcesGetMediaDataResult | null>(null);
  const elRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);

  // Load the source's playable data once.
  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    setMedia(null);
    void appApi
      .getMediaData({ elementId: sourceElementId })
      .then((res) => {
        if (!cancelled) setMedia(res);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [desktop, sourceElementId]);

  // Seek to the clip start once the element is ready, then loop the window with a
  // tight rAF time check (re-seek to startMs at endMs). `timeupdate` is a safety net.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the loop re-arms on the window/media identity
  useEffect(() => {
    const el = elRef.current;
    if (!el || media?.mediaSource !== "local") return;
    let raf = 0;
    const startS = startMs / 1000;
    const endS = endMs / 1000;
    const onLoaded = () => {
      el.currentTime = startS;
    };
    el.addEventListener("loadedmetadata", onLoaded);
    // If metadata is already available, seek immediately.
    if (el.readyState >= 1) el.currentTime = startS;

    const tick = () => {
      if (el.currentTime >= endS || el.currentTime < startS - 0.05) {
        el.currentTime = startS;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    const onTimeUpdate = () => {
      if (el.currentTime >= endS) el.currentTime = startS;
    };
    el.addEventListener("timeupdate", onTimeUpdate);

    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("loadedmetadata", onLoaded);
      el.removeEventListener("timeupdate", onTimeUpdate);
    };
  }, [media?.mediaSource, media?.mediaUrl, startMs, endMs]);

  if (!desktop) {
    return <p className="dimmed">Clip plays through the desktop bridge.</p>;
  }
  if (media == null) {
    return <p className="dimmed">Loading clip…</p>;
  }
  if (media.mediaSource === "youtube") {
    // A clip is a time window on the original — for a YouTube source the bytes never
    // leave YouTube, so the segment plays on `youtube.com` seeked to the clip start via
    // the `&t=<seconds>s` param (a real seek; the in-frame loop lands with the audio
    // card's IFrame Player API). `open source` jumps the in-app reader to the same start.
    const startSeconds = Math.floor(Math.max(0, startMs) / 1000);
    const watchUrl = media.youtubeId
      ? `https://www.youtube.com/watch?v=${media.youtubeId}&t=${startSeconds}s`
      : null;
    return (
      <p className="dimmed" data-testid="clip-mini-youtube">
        YouTube clip {fmt(startMs)}–{fmt(endMs)}
        {watchUrl ? (
          <>
            {" — "}
            <a
              href={watchUrl}
              target="_blank"
              rel="noreferrer"
              className="extract-clip__youtube-link"
              data-testid="clip-mini-youtube-link"
            >
              play the segment on YouTube
            </a>
          </>
        ) : (
          " — open the reader to play the embedded segment."
        )}
      </p>
    );
  }
  if (!media.mediaUrl) {
    return <p className="dimmed">This media source has no playable data.</p>;
  }
  return media.mediaKind === "audio" ? (
    // biome-ignore lint/a11y/useMediaCaption: the clip is the transcript segment shown beside it (T074)
    <audio
      ref={elRef as React.RefObject<HTMLAudioElement>}
      className="extract-clip__player"
      data-testid="clip-mini-audio"
      src={media.mediaUrl}
      controls
      loop={false}
    />
  ) : (
    // biome-ignore lint/a11y/useMediaCaption: the clip is the transcript segment shown beside it (T074)
    <video
      ref={elRef as React.RefObject<HTMLVideoElement>}
      className="extract-clip__player"
      data-testid="clip-mini-video"
      src={media.mediaUrl}
      controls
      loop={false}
    />
  );
}
