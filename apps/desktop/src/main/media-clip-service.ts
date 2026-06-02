/**
 * MediaClipService (T074) — the local-first video/audio clip-extract orchestrator (main).
 *
 * In the media reader the user selects a start/end timestamp (a scrubber range, or a
 * run of transcript cues whose `timestamp_ms` bound the range); the RENDERER ships only
 * the `{ startMs, endMs }` + the source id + the (optional) transcript segment + the
 * anchor block id. This service composes the `ExtractionService` to mint a scheduled
 * **`media_fragment`** whose `source_locations` row carries the **start `timestamp_ms`
 * + a `clip { startMs, endMs }` window** and whose body holds the transcript segment —
 * its own attention-scheduled topic with full lineage back to the media source. It runs
 * ENTIRELY in the Electron main process; the renderer never resolves a vault path, never
 * touches SQLite.
 *
 * ## Asset-free by design (the load-bearing scope decision)
 *
 * A clip is a **TIME WINDOW onto the ORIGINAL media**, NOT a cut/re-encoded sub-file.
 * The reader (and the T075 audio card) seek the original between `startMs`/`endMs`. So,
 * unlike `PdfRegionService` (which streams a cropped PNG into the vault), this service
 * imports NO asset — the whole clip extract is ONE atomic transaction
 * (`createClipExtract`), with no out-of-tx asset step and therefore no asset rollback.
 * This keeps the milestone `ffmpeg`-free (a ~70 MB native binary, explicitly out of
 * scope): the original media file is the single source of bytes; every clip + audio
 * card references it by time.
 *
 * ## Validation
 *
 * The window is validated `0 ≤ startMs < endMs ≤ durationMs` so a clip can never exceed
 * the media — `durationMs` is read off the original media asset (`video`/`audio` kind).
 * When the duration is UNKNOWN (an unprobeable local file, or a referenced YouTube
 * source with no vault asset) the upper bound is skipped (the window must still be a
 * non-empty, in-order, non-negative span). The source must exist + be a non-deleted
 * media source.
 */

import {
  type AssetKind,
  type BlockId,
  type ElementId,
  type PriorityLabel,
  priorityFromLabel,
} from "@interleave/core";
import type { InterleaveDatabase } from "@interleave/db";
import type { ExtractionService, Repositories } from "@interleave/local-db";

/** Constructor dependencies (injected once; mirroring `PdfRegionService`). */
export interface MediaClipServiceDeps {
  /** The open Drizzle database (accepted for symmetry; the service owns its tx). */
  readonly db: InterleaveDatabase;
  /** The repository bag bound to the same DB (the source + duration lookup). */
  readonly repositories: Repositories;
  /** The extraction service (the `media_fragment` clip-extract path). */
  readonly extraction: ExtractionService;
}

/** Arguments to {@link MediaClipService.extractClip}. */
export interface ExtractClipInput {
  /** The media source element the clip was selected over (the lineage root). */
  readonly sourceElementId: ElementId;
  /** The clip start in integer milliseconds. */
  readonly startMs: number;
  /** The clip end in integer milliseconds (`endMs > startMs`). */
  readonly endMs: number;
  /** The stable block id the clip anchors to (the first cue in range, or placeholder). */
  readonly anchorBlockId: string;
  /** The transcript segment under the range (when a transcript exists), else null. */
  readonly transcriptSegment?: string | null;
  /** Optional caption override; else the generated "Clip M:SS–M:SS" label. */
  readonly caption?: string | null;
  /** Optional A/B/C/D priority override; else INHERITS the source's priority. */
  readonly priority?: PriorityLabel;
}

/** The created clip extract + its clip source-location (the IPC result builds from this). */
export interface ExtractClipResult {
  /** The new `media_fragment` element id. */
  readonly id: string;
  /** A flat summary of the freshly created `media_fragment`. */
  readonly element: {
    readonly id: string;
    readonly type: string;
    readonly status: string;
    readonly stage: string;
    readonly priority: number;
    readonly title: string;
    readonly dueAt: string | null;
    readonly sourceId: string | null;
    readonly parentId: string | null;
  };
  /** The stored clip source-location anchor. */
  readonly location: {
    readonly id: string;
    readonly sourceElementId: string;
    readonly timestampMs: number | null;
    readonly clip: { startMs: number; endMs: number } | null;
    readonly label: string | null;
  };
}

export class MediaClipService {
  private readonly repositories: Repositories;
  private readonly extraction: ExtractionService;

  constructor(deps: MediaClipServiceDeps) {
    this.repositories = deps.repositories;
    this.extraction = deps.extraction;
  }

  /**
   * Clip a media span into a `media_fragment` extract. See the file header for the
   * asset-free contract + the window validation. Throws if the source is missing/
   * deleted or the window is invalid/out-of-range; the single transaction is atomic
   * (no asset, no partial-write to roll back).
   */
  extractClip(input: ExtractClipInput): ExtractClipResult {
    const sourceElementId = input.sourceElementId;
    const source = this.repositories.elements.findById(sourceElementId);
    if (!source || source.deletedAt) {
      throw new Error(`MediaClipService.extractClip: source ${sourceElementId} not found`);
    }

    const startMs = Math.floor(input.startMs);
    const endMs = Math.floor(input.endMs);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs <= startMs) {
      throw new Error(
        `MediaClipService.extractClip: invalid clip window [${input.startMs}, ${input.endMs})`,
      );
    }

    // The media duration lives on the original media asset (video/audio kind). When
    // known, the window must not exceed it; an unprobeable/YouTube source (no asset
    // duration) skips the upper bound (the player simply cannot seek past the end).
    const durationMs = this.mediaDurationMs(sourceElementId);
    if (durationMs != null && endMs > durationMs) {
      throw new Error(
        `MediaClipService.extractClip: clip end ${endMs}ms exceeds media duration ${durationMs}ms`,
      );
    }

    // Inherit the source's numeric priority unless the renderer overrode it.
    const priority = input.priority ? priorityFromLabel(input.priority) : source.priority;

    const { element, location } = this.extraction.createClipExtract({
      sourceElementId,
      startMs,
      endMs,
      anchorBlockId: input.anchorBlockId as BlockId,
      transcriptSegment: input.transcriptSegment ?? null,
      caption: input.caption ?? null,
      priority,
    });

    return {
      id: element.id,
      element: {
        id: element.id,
        type: element.type,
        status: element.status,
        stage: element.stage,
        priority: element.priority,
        title: element.title,
        dueAt: element.dueAt,
        sourceId: element.sourceId,
        parentId: element.parentId,
      },
      location: {
        id: location.id,
        sourceElementId: location.sourceElementId,
        timestampMs: location.timestampMs,
        clip: location.clip,
        label: location.label,
      },
    };
  }

  /** Read the original media asset's `durationMs` (video then audio), or `null`. */
  private mediaDurationMs(sourceElementId: ElementId): number | null {
    for (const kind of ["video", "audio"] satisfies AssetKind[]) {
      const asset = this.repositories.assets.listForElementByKind(sourceElementId, kind)[0] ?? null;
      if (asset?.durationMs != null) return asset.durationMs;
    }
    return null;
  }
}
