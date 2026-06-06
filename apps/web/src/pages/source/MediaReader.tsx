/**
 * Media reading mode (T073) — the `<video>`/`<audio>` (local) or YouTube IFrame
 * (referenced) body the `SourceReader` swaps in when `documents.get` reports
 * `sourceFormat: "video"`.
 *
 * It loads the source's playable data ONCE through the typed `sources.getMediaData`
 * command (the renderer never resolves a vault path):
 *   - a LOCAL source plays the privileged `media://<elementId>` URL in an HTML5
 *     `<video controls>` / `<audio controls>` (streamed with Range support — the
 *     bytes are never buffered over IPC);
 *   - a YOUTUBE source embeds the IFrame player (`youtube.com/embed/<id>`) — no
 *     bytes, an on-device-rendered iframe; a manual "Set read-point at current time"
 *     captures the time the user enters (the IFrame Player API is a clean upgrade).
 *
 * A transcript pane (when the body has cue paragraphs from `blockTimestamps`) lets
 * the user click a cue to SEEK the player to that cue's `timestampMs`; the
 * currently-playing cue is highlighted (derived from `currentTime` → the nearest
 * cue). A "Set read-point" press persists the current cue's stable block id via
 * `readPoints.set` (a transcript-backed video reuses `read_points` exactly); a
 * transcript-LESS video persists the TITLE-HEADING block id with `offset =
 * floor(currentTimeMs)` (the offset-as-seconds convention), so the single
 * `read_points` table serves both cases with NO new `sources` column. Reopening
 * seeks the player to the saved cue time (or the saved second).
 *
 * Pure UI: typed commands only — no fs/fetch/parse/SQL in the renderer. Outside the
 * desktop shell it degrades to a calm fallback.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import { appApi, isDesktop, type SourcesGetMediaDataResult } from "../../lib/appApi";
import "./media-reader.css";

/** One transcript cue derived from the body + `blockTimestamps`. */
interface Cue {
  /** The stable block id (the read-point anchor). */
  readonly blockId: string;
  /** The cue start in milliseconds. */
  readonly timestampMs: number;
  /** The cue text. */
  readonly text: string;
}

export interface MediaReaderProps {
  /** The media source element id. */
  readonly elementId: string;
  /** The loaded ProseMirror body JSON (the transcript heading + cue paragraphs). */
  readonly prosemirrorJson: unknown;
  /** The block→time map (stable block id → cue start ms) from `documents.get`. */
  readonly blockTimestamps: Readonly<Record<string, number>>;
  /** A clip-start seek target in ms (T074 — a clip's "open source" passes `?t=`). */
  readonly seekToMs?: number | null;
  /** Called after a clip `media_fragment` is created so the parent refreshes the inspector. */
  readonly onClipExtracted?: () => void;
  /** Toast helper from the parent reader (status messages). */
  readonly toast: (message: string) => void;
}

/**
 * Walk the constrained ProseMirror doc + the `blockTimestamps` map into an ordered
 * cue list. The body is a title heading + one paragraph per cue (T073); a paragraph
 * whose stable block id is in `blockTimestamps` is a cue.
 *
 * For a transcript-LESS body (title heading + ONE placeholder paragraph "No transcript
 * available."), `placeholderBlockId` is that placeholder paragraph's stable block id —
 * the literal anchor a transcript-less clip lands on (spec: "the placeholder block id").
 * `titleBlockId` (the heading) remains the read-point anchor and the last-resort clip
 * fallback.
 */
function deriveCues(
  doc: unknown,
  blockTimestamps: Readonly<Record<string, number>>,
): { cues: Cue[]; titleBlockId: string | null; placeholderBlockId: string | null } {
  const cues: Cue[] = [];
  let titleBlockId: string | null = null;
  let placeholderBlockId: string | null = null;
  const root = doc as { content?: unknown[] } | null;
  const content = Array.isArray(root?.content) ? root.content : [];
  for (const node of content) {
    const n = node as {
      type?: string;
      attrs?: { blockId?: string };
      content?: { type?: string; text?: string }[];
    };
    const blockId = n.attrs?.blockId ?? null;
    if (!blockId) continue;
    const text = (n.content ?? []).map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("");
    if (n.type === "heading" && titleBlockId == null) {
      titleBlockId = blockId;
      continue;
    }
    const ts = blockTimestamps[blockId];
    if (typeof ts === "number") {
      cues.push({ blockId, timestampMs: ts, text });
    } else if (placeholderBlockId == null) {
      // The first non-heading block with NO timestamp is the transcript-less
      // placeholder paragraph — the clip anchor for a transcript-less source.
      placeholderBlockId = blockId;
    }
  }
  return { cues, titleBlockId, placeholderBlockId };
}

/** Format ms as `m:ss` / `h:mm:ss` for the transcript pane + chips. */
function fmtTime(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export function MediaReader({
  elementId,
  prosemirrorJson,
  blockTimestamps,
  seekToMs,
  onClipExtracted,
  toast,
}: MediaReaderProps) {
  const desktop = isDesktop();
  const [media, setMedia] = useState<SourcesGetMediaDataResult | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [currentMs, setCurrentMs] = useState(0);
  const mediaElRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);

  // Clip-select state (T074): an in-point / out-point pair the user sets on the
  // player, a busy flag while the clip is created, and an editable caption.
  const [clipInMs, setClipInMs] = useState<number | null>(null);
  const [clipOutMs, setClipOutMs] = useState<number | null>(null);
  const [clipCaption, setClipCaption] = useState("");
  const [clipBusy, setClipBusy] = useState(false);

  const { cues, titleBlockId, placeholderBlockId } = useMemo(
    () => deriveCues(prosemirrorJson, blockTimestamps),
    [prosemirrorJson, blockTimestamps],
  );
  const hasTranscript = cues.length > 0;

  // Load the playable data once per element.
  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    setMedia(null);
    setLoadError(null);
    void appApi
      .getMediaData({ elementId })
      .then((result) => {
        if (!cancelled) setMedia(result);
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [desktop, elementId]);

  // The cue currently playing (the last cue whose start <= currentMs).
  const activeCueIndex = useMemo(() => {
    let idx = -1;
    for (let i = 0; i < cues.length; i += 1) {
      const cue = cues[i];
      if (cue && cue.timestampMs <= currentMs) idx = i;
      else break;
    }
    return idx;
  }, [cues, currentMs]);

  /** Seek the local player to a millisecond offset. */
  const seekTo = useCallback((ms: number) => {
    const el = mediaElRef.current;
    if (el) {
      el.currentTime = ms / 1000;
      void el.play?.().catch(() => {});
    }
  }, []);

  // Resume from the saved read-point once the media + cues are known.
  const resumedRef = useRef(false);
  useEffect(() => {
    if (!desktop || resumedRef.current) return;
    // Only resume the LOCAL player (the YouTube IFrame has no seek without the API).
    if (media?.mediaSource !== "local") return;
    resumedRef.current = true;
    void appApi
      .getReadPoint({ elementId })
      .then((result) => {
        const rp = result.readPoint;
        if (!rp) return;
        // Transcript-backed: the block id is a cue → resume at the cue's timestamp.
        const cue = cues.find((c) => c.blockId === rp.blockId);
        if (cue) {
          seekTo(cue.timestampMs);
          return;
        }
        // Transcript-less: the title-heading block id carries `offset` = seconds.
        if (rp.blockId === titleBlockId && rp.offset > 0) {
          seekTo(rp.offset * 1000);
        }
      })
      .catch(() => {});
  }, [desktop, media?.mediaSource, elementId, cues, titleBlockId, seekTo]);

  /**
   * Persist the timestamp read-point. Transcript-backed → the ACTIVE cue's block id
   * (offset 0). Transcript-less → the TITLE-heading block id with `offset =
   * floor(currentSeconds)` (the offset-as-seconds convention). Both write the single
   * `read_points` row.
   */
  const setReadPoint = useCallback(async () => {
    try {
      let blockId: string | null = null;
      let offset = 0;
      if (hasTranscript && activeCueIndex >= 0) {
        blockId = cues[activeCueIndex]?.blockId ?? null;
        offset = 0;
      } else if (titleBlockId) {
        blockId = titleBlockId;
        offset = Math.floor(currentMs / 1000);
      }
      if (!blockId) {
        toast("Play the media first to set a read-point.");
        return;
      }
      await appApi.setReadPoint({ elementId, documentId: elementId, blockId, offset });
      toast(
        hasTranscript
          ? "Read-point set at the current cue."
          : `Read-point set at ${fmtTime(currentMs)}.`,
      );
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not set the read-point.");
    }
  }, [hasTranscript, activeCueIndex, cues, titleBlockId, currentMs, elementId, toast]);

  // Seek to the clip-start target once (T074 — a clip's "open source" passes `?t=`).
  const seekedRef = useRef(false);
  useEffect(() => {
    if (!desktop || seekedRef.current) return;
    if (typeof seekToMs !== "number" || seekToMs < 0) return;
    if (media?.mediaSource !== "local") return;
    seekedRef.current = true;
    seekTo(seekToMs);
  }, [desktop, seekToMs, media?.mediaSource, seekTo]);

  /** Mark the current playback time as the clip IN-point (`[`). */
  const setClipIn = useCallback(() => {
    const ms = Math.floor(currentMs);
    setClipInMs(ms);
    // If the out-point now precedes the in-point, drop it.
    setClipOutMs((out) => (out != null && out <= ms ? null : out));
  }, [currentMs]);

  /** Mark the current playback time as the clip OUT-point (`]`). */
  const setClipOut = useCallback(() => {
    setClipOutMs(Math.floor(currentMs));
  }, [currentMs]);

  /** Clear the pending clip selection. */
  const clearClip = useCallback(() => {
    setClipInMs(null);
    setClipOutMs(null);
    setClipCaption("");
  }, []);

  // The valid pending window (in < out), else null.
  const pendingClip = useMemo(() => {
    if (clipInMs == null || clipOutMs == null) return null;
    if (clipOutMs <= clipInMs) return null;
    return { startMs: clipInMs, endMs: clipOutMs };
  }, [clipInMs, clipOutMs]);

  /**
   * The anchor block id + transcript segment for the pending clip. The anchor is the
   * FIRST cue whose start falls in `[startMs, endMs)`; when transcript-less it is the
   * placeholder paragraph block id (spec: "the placeholder block id"), falling back to
   * the title heading only if no placeholder exists. The segment joins the cue texts in
   * range so the clip body holds the spoken text.
   */
  const clipAnchor = useMemo(() => {
    if (!pendingClip) return null;
    const inRange = cues.filter(
      (c) => c.timestampMs >= pendingClip.startMs && c.timestampMs < pendingClip.endMs,
    );
    const anchorBlockId = inRange[0]?.blockId ?? placeholderBlockId ?? titleBlockId;
    const transcriptSegment =
      inRange
        .map((c) => c.text)
        .join(" ")
        .trim() || null;
    return anchorBlockId ? { anchorBlockId, transcriptSegment } : null;
  }, [pendingClip, cues, placeholderBlockId, titleBlockId]);

  // Pre-fill the caption with the transcript segment (once a window is set).
  useEffect(() => {
    if (pendingClip && clipAnchor?.transcriptSegment && clipCaption === "") {
      setClipCaption(clipAnchor.transcriptSegment.slice(0, 200));
    }
  }, [pendingClip, clipAnchor, clipCaption]);

  /** Create the clip `media_fragment` from the pending window. */
  const createClip = useCallback(async () => {
    if (!pendingClip || !clipAnchor || clipBusy) return;
    setClipBusy(true);
    try {
      await appApi.extractClip({
        sourceElementId: elementId,
        startMs: pendingClip.startMs,
        endMs: pendingClip.endMs,
        anchorBlockId: clipAnchor.anchorBlockId,
        transcriptSegment: clipAnchor.transcriptSegment,
        caption: clipCaption.trim() || null,
      });
      toast(`Clip ${fmtTime(pendingClip.startMs)}–${fmtTime(pendingClip.endMs)} saved as a topic.`);
      clearClip();
      onClipExtracted?.();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not create the clip.");
    } finally {
      setClipBusy(false);
    }
  }, [
    pendingClip,
    clipAnchor,
    clipBusy,
    clipCaption,
    elementId,
    toast,
    clearClip,
    onClipExtracted,
  ]);

  // The `[` / `]` keyboard pair sets the in/out points (ignored while typing).
  useEffect(() => {
    if (!desktop) return;
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "[") {
        e.preventDefault();
        setClipIn();
      } else if (e.key === "]") {
        e.preventDefault();
        setClipOut();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [desktop, setClipIn, setClipOut]);

  if (!desktop) {
    return (
      <div className="reader-state" data-testid="media-reader-nodesktop">
        <span className="reader-state__icon">
          <Icon name="media" size={26} />
        </span>
        <p className="max-w-sm">
          The media reader plays through the desktop bridge — open the Electron app to watch a video
          or audio source.
        </p>
      </div>
    );
  }

  return (
    <div className="media-reader" data-testid="media-reader">
      <div className="media-reader-bar">
        <button
          type="button"
          className="reader-btn reader-btn--primary"
          data-testid="media-set-readpoint"
          onClick={() => void setReadPoint()}
        >
          <Icon name="bookmark" size={14} /> Set read-point
        </button>
        <span className="media-reader-clip-controls">
          <button
            type="button"
            className="reader-btn"
            data-testid="media-clip-in"
            title="Set clip in-point ( [ )"
            onClick={setClipIn}
          >
            [ In{clipInMs != null ? ` ${fmtTime(clipInMs)}` : ""}
          </button>
          <button
            type="button"
            className="reader-btn"
            data-testid="media-clip-out"
            title="Set clip out-point ( ] )"
            onClick={setClipOut}
          >
            Out{clipOutMs != null ? ` ${fmtTime(clipOutMs)}` : ""} ]
          </button>
        </span>
        <span className="media-reader-time" data-testid="media-current-time">
          {fmtTime(currentMs)}
          {media?.durationMs ? ` / ${fmtTime(media.durationMs)}` : ""}
        </span>
      </div>

      {pendingClip ? (
        <div className="media-reader-clip-popover" data-testid="media-clip-popover">
          <div className="media-reader-clip-range">
            Clip {fmtTime(pendingClip.startMs)}–{fmtTime(pendingClip.endMs)}
          </div>
          <input
            type="text"
            className="media-reader-clip-caption"
            data-testid="media-clip-caption"
            placeholder="Caption (optional)"
            value={clipCaption}
            onChange={(e) => setClipCaption(e.target.value)}
          />
          <div className="media-reader-clip-actions">
            <button
              type="button"
              className="reader-btn reader-btn--primary"
              data-testid="media-clip-confirm"
              disabled={clipBusy || !clipAnchor}
              onClick={() => void createClip()}
            >
              {clipBusy ? "Creating topic…" : "Clip this segment as a topic"}
            </button>
            <button
              type="button"
              className="reader-btn"
              data-testid="media-clip-cancel"
              onClick={clearClip}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {loadError ? (
        <p className="media-reader-error" data-testid="media-reader-error">
          {loadError}
        </p>
      ) : null}

      <div
        className={
          hasTranscript ? "media-reader-body media-reader-body--split" : "media-reader-body"
        }
      >
        <div className="media-reader-player">
          {media == null ? (
            <div className="media-reader-loading">Loading media…</div>
          ) : media.mediaSource === "youtube" && media.youtubeId ? (
            <iframe
              className="media-reader-iframe"
              data-testid="media-reader-iframe"
              src={`https://www.youtube.com/embed/${media.youtubeId}`}
              title="YouTube video"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
            />
          ) : media.mediaSource === "local" && media.mediaUrl && media.mediaKind === "audio" ? (
            // biome-ignore lint/a11y/useMediaCaption: captions render in the transcript pane (T073)
            <audio
              ref={mediaElRef as React.RefObject<HTMLAudioElement>}
              className="media-reader-audio"
              data-testid="media-reader-audio"
              src={media.mediaUrl}
              controls
              onTimeUpdate={(e) => setCurrentMs(e.currentTarget.currentTime * 1000)}
            />
          ) : media.mediaSource === "local" && media.mediaUrl ? (
            // biome-ignore lint/a11y/useMediaCaption: captions render in the transcript pane (T073)
            <video
              ref={mediaElRef as React.RefObject<HTMLVideoElement>}
              className="media-reader-video"
              data-testid="media-reader-video"
              src={media.mediaUrl}
              controls
              onTimeUpdate={(e) => setCurrentMs(e.currentTarget.currentTime * 1000)}
            />
          ) : (
            <div className="media-reader-loading" data-testid="media-reader-unplayable">
              This media source has no playable data.
            </div>
          )}
        </div>

        {hasTranscript ? (
          <div className="media-reader-transcript" data-testid="media-reader-transcript">
            <div className="media-reader-transcript-head">Transcript</div>
            <ol className="media-reader-cues">
              {cues.map((cue, i) => (
                <li key={cue.blockId}>
                  <button
                    type="button"
                    className={
                      i === activeCueIndex
                        ? "media-reader-cue media-reader-cue--active"
                        : "media-reader-cue"
                    }
                    data-testid="media-reader-cue"
                    data-active={i === activeCueIndex ? "true" : undefined}
                    title="Click to seek · Shift-click to set a clip in/out point"
                    onClick={(e) => {
                      // Shift-click is the transcript-cue alternate entry to clip
                      // selection (T074): first Shift-click sets the in-point, the
                      // next sets the out-point. A plain click seeks the player.
                      if (e.shiftKey) {
                        if (clipInMs == null || clipOutMs != null) {
                          setClipInMs(cue.timestampMs);
                          setClipOutMs(null);
                          setClipCaption("");
                        } else {
                          // The window is half-open `[in, out)`, so land the out-point
                          // at the END of the clicked cue — the next cue's start, or
                          // `clickedCue + 1ms` for the last cue — so the clicked cue's
                          // text is INCLUDED in the saved transcript segment.
                          const nextCueStart = cues[i + 1]?.timestampMs;
                          const cueEnd =
                            typeof nextCueStart === "number" ? nextCueStart : cue.timestampMs + 1;
                          setClipOutMs(Math.max(cueEnd, clipInMs + 1));
                        }
                        return;
                      }
                      if (media?.mediaSource === "local") seekTo(cue.timestampMs);
                    }}
                  >
                    <span className="media-reader-cue-time">{fmtTime(cue.timestampMs)}</span>
                    <span className="media-reader-cue-text">{cue.text}</span>
                  </button>
                </li>
              ))}
            </ol>
          </div>
        ) : (
          <div className="media-reader-noscript" data-testid="media-reader-noscript">
            No transcript available — play the media and set timestamp read-points; clip a segment
            by setting an in-point ( [ ) and an out-point ( ] ), then save it as a topic.
          </div>
        )}
      </div>
    </div>
  );
}
