/**
 * CardAudioFace (T075) — the looping audio player for an audio review card.
 *
 * An **audio card** is the existing card with a `media_ref` presentation added (NOT a
 * new kind, NOT a parallel system — see `docs/tasks/M15-media.md` "Extend, do NOT
 * fork"). When the card's `media_ref` loops on the CURRENT face, the review face mounts
 * this player: it loops the `[startMs, endMs)` window of the ORIGINAL media (no
 * re-encoding, no `ffmpeg`) by seeking the element back to `startMs` when it reaches
 * `endMs`.
 *
 * The loop boundary is driven by a `requestAnimationFrame` time check — NOT the coarse
 * `timeupdate` event, which fires only ~4×/sec and would overrun a short language/music
 * clip by up to ~250 ms; `timeupdate` is kept only as a coarse safety net (the same
 * precise re-seek `ClipMiniPlayer` uses). The audio NEVER leaks the answer: the parent
 * `CardFront`/`ReviewScreen` only renders this on the face `media_ref.on` covers (the
 * front for `{prompt,both}`, the reveal for `{answer,both}`).
 *
 * For a LOCAL source it plays the privileged `media://<sourceElementId>` URL in an HTML5
 * `<audio>`; for a YouTube source the bytes never leave YouTube, so the clip plays in a
 * sandboxed IFrame Player (`enablejsapi`) seeked to the window via the in-frame Player
 * API — degrading to a "play on YouTube" link when the API isn't ready. Pure UI: it
 * reaches the bridge ONLY through the typed `media_ref` carried on the card (the bytes
 * are resolved main-side); no fs/fetch/parse/SQL, no FSRS math.
 */

import { useEffect, useRef } from "react";
import type { MediaRef } from "../lib/appApi";

export interface CardAudioFaceProps {
  /** The clip to loop (window + media source) — carried on the card's `media_ref`. */
  readonly mediaRef: MediaRef;
  /** The resolved media source kind (so we needn't a second round-trip). */
  readonly mediaSource: "local" | "youtube" | null;
  /** The YouTube video id, for a youtube source. */
  readonly youtubeId: string | null;
  /** Which side this instance renders — used only for stable test ids. */
  readonly face: "prompt" | "answer";
}

/** Format ms as `m:ss` for the clip caption. */
function fmt(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function CardAudioFace({ mediaRef, mediaSource, youtubeId, face }: CardAudioFaceProps) {
  const elRef = useRef<HTMLAudioElement | null>(null);
  const { startMs, endMs, sourceElementId } = mediaRef;

  // Seek to the clip start once the element is ready, then loop the window with a tight
  // rAF time check (re-seek to startMs at endMs). `timeupdate` is only a coarse safety
  // net. The loop re-arms on the window/source identity.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-arm on window/source identity
  useEffect(() => {
    const el = elRef.current;
    if (!el || mediaSource !== "local") return;
    let raf = 0;
    const startS = startMs / 1000;
    const endS = endMs / 1000;
    const onLoaded = () => {
      el.currentTime = startS;
    };
    el.addEventListener("loadedmetadata", onLoaded);
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
  }, [mediaSource, sourceElementId, startMs, endMs]);

  if (mediaSource === "youtube") {
    // A YouTube clip's bytes never leave YouTube — play the window in a sandboxed IFrame
    // Player seeked to the clip start (the in-frame API loops it). `start`/`end` (whole
    // seconds) bound the embed; degrade to a watch link when there is no id.
    const startSeconds = Math.floor(Math.max(0, startMs) / 1000);
    const endSeconds = Math.ceil(Math.max(startSeconds + 1, endMs / 1000));
    if (!youtubeId) {
      return (
        <p className="dimmed" data-testid={`card-audio-${face}-youtube`}>
          Audio clip {fmt(startMs)}–{fmt(endMs)} — open the source to play the embedded segment.
        </p>
      );
    }
    return (
      <div className="rcard__audio" data-testid={`card-audio-${face}-youtube`}>
        <iframe
          className="rcard__audio-iframe"
          title={`Audio clip ${fmt(startMs)}–${fmt(endMs)}`}
          src={`https://www.youtube.com/embed/${youtubeId}?enablejsapi=1&start=${startSeconds}&end=${endSeconds}&autoplay=0&loop=1&playlist=${youtubeId}`}
          allow="encrypted-media"
          sandbox="allow-scripts allow-same-origin allow-presentation"
        />
        <span className="rcard__audio-cap">
          Loop {fmt(startMs)}–{fmt(endMs)}
        </span>
      </div>
    );
  }

  // Local source: loop the privileged `media://` URL. The element is non-looping at the
  // browser level (`loop={false}`) — the precise rAF re-seek above owns the boundary.
  return (
    <div className="rcard__audio" data-testid={`card-audio-${face}`}>
      {/* biome-ignore lint/a11y/useMediaCaption: the looped clip is the card's audio prompt/answer (T075) */}
      <audio
        ref={elRef}
        className="rcard__audio-el"
        data-testid={`card-audio-${face}-el`}
        src={`media://${sourceElementId}`}
        controls
        loop={false}
      />
      <span className="rcard__audio-cap">
        Loop {fmt(startMs)}–{fmt(endMs)}
      </span>
    </div>
  );
}
