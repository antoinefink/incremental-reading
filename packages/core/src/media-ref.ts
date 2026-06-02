/**
 * MediaRef (T075) — the audio-card presentation carrier.
 *
 * An **audio card** is the existing `card` model with a *presentation modifier*
 * added, NOT a new `kind` and NOT a parallel table (see `docs/tasks/M15-media.md`
 * "Extend, do NOT fork"). The carrier is one nullable `cards.media_ref` column whose
 * parsed shape is this {@link MediaRef}: which clip of the original media to LOOP, and
 * on which face.
 *
 * - `sourceElementId` — the media **`source`** element (the original asset the player
 *   seeks). NOT the clip `media_fragment` — the card loops the ORIGINAL file by time,
 *   never a cut/re-encoded sub-file (the milestone stays `ffmpeg`-free).
 * - `startMs`/`endMs` — the clip window, integer milliseconds, `0 ≤ startMs < endMs`.
 *   Copied from the originating `media_fragment`'s `source_locations.clip` at create
 *   time so the card is **self-contained** (it doesn't have to re-resolve the fragment
 *   to know its window).
 * - `on` — `"prompt"` / `"answer"` / `"both"`: whether the loop plays on the front
 *   (prompt), only after reveal (answer), or both. The card's TEXT (`prompt`/`answer`/
 *   `cloze`) is unchanged — an audio card can ALSO carry a written side; `on` decides
 *   which face additionally plays audio.
 *
 * Pure types + a pure validator only — no Zod here (`@interleave/core` is dependency-
 * free; the IPC `MediaRefSchema` lives in the desktop contract, mirroring how
 * `RegionRect`/`ClipWindow` keep their Zod in the contract). The renderer does NO FSRS
 * math and never resolves a vault path; it only reads this shape to drive the looping
 * `<audio>`/IFrame player in `CardFront`.
 */

import type { ElementId } from "./ids";

/** Which face of the card additionally plays the looped audio clip. */
export const MEDIA_REF_FACES = ["prompt", "answer", "both"] as const;
export type MediaRefFace = (typeof MEDIA_REF_FACES)[number];

/**
 * The audio-card clip reference stored on `cards.media_ref` (T075). A time window on
 * the ORIGINAL media (`sourceElementId`), looped on the chosen face — never a cut file.
 */
export interface MediaRef {
  /** The media `source` element id (the original asset the player seeks). */
  readonly sourceElementId: ElementId;
  /** The clip start in milliseconds (`>= 0`). */
  readonly startMs: number;
  /** The clip end in milliseconds (`> startMs`). */
  readonly endMs: number;
  /** Which face loops the clip — `prompt` (front), `answer` (reveal), or `both`. */
  readonly on: MediaRefFace;
}

/** True when `value` is a valid {@link MediaRefFace}. */
export function isMediaRefFace(value: unknown): value is MediaRefFace {
  return typeof value === "string" && (MEDIA_REF_FACES as readonly string[]).includes(value);
}

/**
 * Validate + normalize an untrusted value into a {@link MediaRef}, or `null` when it is
 * malformed (a non-object, a missing/empty source id, an inverted/negative window, or an
 * unknown face). Accepts EITHER a parsed object OR the raw JSON `string` stored in the
 * `cards.media_ref` cell (a `string` is `JSON.parse`d first; a parse failure → `null`),
 * so the mapper can pass the cell verbatim. A malformed value degrades to "no audio"
 * rather than throwing on read, mirroring the `source_locations.clip`/`region` parse
 * discipline. Integer-millisecond windows only.
 */
export function parseMediaRef(value: unknown): MediaRef | null {
  let parsed: unknown = value;
  if (typeof value === "string") {
    if (value.length === 0) return null;
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (parsed == null || typeof parsed !== "object") return null;
  const v = parsed as Partial<Record<keyof MediaRef, unknown>>;
  const sourceElementId = v.sourceElementId;
  const startMs = v.startMs;
  const endMs = v.endMs;
  const on = v.on;
  if (typeof sourceElementId !== "string" || sourceElementId.length === 0) return null;
  if (typeof startMs !== "number" || !Number.isFinite(startMs) || startMs < 0) return null;
  if (typeof endMs !== "number" || !Number.isFinite(endMs) || endMs <= startMs) return null;
  if (!isMediaRefFace(on)) return null;
  return {
    sourceElementId: sourceElementId as ElementId,
    startMs: Math.round(startMs),
    endMs: Math.round(endMs),
    on,
  };
}
