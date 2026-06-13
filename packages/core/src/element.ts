/**
 * The universal `Element` primitive and its lineage neighbours (T005).
 *
 * `Element` is the single object model for the whole product (sources, topics,
 * extracts, cards, tasks, concepts, media fragments, synthesis notes). Lineage
 * is sacred: an element knows its `parentId` and `sourceId`, and typed edges in
 * {@link ElementRelation} plus positions in {@link ElementLocation} let a card
 * trace back `card → extract → source location → source metadata → original
 * document context`. These shapes are framework-agnostic (no React/Drizzle/
 * better-sqlite3); `packages/db` mirrors them as the SQLite schema (T006) and
 * `packages/local-db` reads/writes them behind the Electron/IPC boundary (T008).
 */

import type {
  DistillationStage,
  ElementStatus,
  ElementType,
  ExtractFate,
  RelationType,
} from "./enums";
import type {
  BlockId,
  ElementId,
  IsoTimestamp,
  RelationId,
  SiblingGroupId,
  SourceLocationId,
} from "./ids";
import type { Priority } from "./priority";

/**
 * The universal element row (`elements` table). Every learnable/processable unit
 * is one of these. `stage` ({@link DistillationStage}) and `status`
 * ({@link ElementStatus}) are deliberately separate axes. `deletedAt` is a soft
 * delete — set, not destroyed — so the trash can restore it.
 *
 * Lineage fields:
 *  - `parentId` — the element this was lifted/derived from (extract→source,
 *    sub-extract→extract, card→extract). `null` for top-level sources.
 *  - `sourceId` — the ultimate owning `source` element, denormalized so any
 *    descendant can reach its origin without walking the whole chain.
 */
export interface Element {
  readonly id: ElementId;
  readonly type: ElementType;
  status: ElementStatus;
  stage: DistillationStage;
  /** Normalized numeric priority `0.0`–`1.0`; surfaced as A/B/C/D in the UI. */
  priority: Priority;
  /** Attention interval scaling factor `0.5`–`4.0` (1.0 = normal cadence). */
  attentionIntervalMultiplier: number;
  /** When this element next wants attention/review; `null` if unscheduled. */
  dueAt: IsoTimestamp | null;
  /** When this element was deliberately parked for later; `null` unless status is `parked`. */
  parkedAt: IsoTimestamp | null;
  /** Until when this topic is deliberately resting; `null` unless the topic is fallowed. */
  fallowUntil: IsoTimestamp | null;
  /** User-entered reason for deliberate topic rest; `null` when absent or not fallowed. */
  fallowReason: string | null;
  /** Latest active fallow operation batch, used to restore schedules on manual unfallow. */
  fallowBatchId: string | null;
  /** Honorable terminal fate for extracts that are done without a card; `null` otherwise. */
  extractFate: ExtractFate | null;
  /**
   * Content-staleness flag (T123): `true` when this derived element's body may no longer
   * match its source after a source block it derives from was edited. A self-healing
   * projection of `element_reverify_provenance`. CONTENT staleness — distinct from T090
   * CALENDAR staleness. Resolution (confirm/rebase/detach) is T124; only ever true for
   * extract/card/media_fragment elements.
   */
  needsReverify: boolean;
  /** When this element first became content-stale (T123); `null` unless `needsReverify`. */
  staleSince: IsoTimestamp | null;
  title: string;
  /** Origin element this was derived from; `null` for top-level sources. */
  parentId: ElementId | null;
  /** The owning `source` element (lineage root); `null` only on a source itself. */
  sourceId: ElementId | null;
  readonly createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  /** Soft-delete marker; non-null means "in the trash", recoverable. */
  deletedAt: IsoTimestamp | null;
}

/**
 * A typed edge between two elements (`element_relations` table). Relationships
 * are explicit rows, NOT implicit nesting — this keeps lineage queryable in both
 * directions and lets sibling cards be grouped (`siblingGroupId`) so they are
 * not shown back-to-back in review.
 */
export interface ElementRelation {
  readonly id: RelationId;
  readonly fromElementId: ElementId;
  readonly toElementId: ElementId;
  readonly relationType: RelationType;
  /** Set when `relationType` is `sibling_group`; groups interfering siblings. */
  readonly siblingGroupId: SiblingGroupId | null;
  readonly createdAt: IsoTimestamp;
}

/**
 * A normalized rectangle over a paginated page (`source_locations.region`, T065).
 * `x0/y0/x1/y1` are FRACTIONS `0–1` of the page's rendered width/height
 * (scale-independent, so the region maps back correctly at any zoom). `x0<x1` and
 * `y0<y1`. Used by a PDF region extract (a `media_fragment`) to anchor a figure/
 * table crop to its page + bounding box.
 */
export interface RegionRect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/**
 * A time window over the original media (`source_locations.clip`, T074) — the
 * `{ startMs, endMs }` span a video/audio clip extract (a `media_fragment`) covers.
 * Integer milliseconds, `0 ≤ startMs < endMs`. A clip is NOT a cut/re-encoded
 * sub-file: the reader + the T075 audio card seek the ORIGINAL media between the two
 * times. The location's `timestampMs` mirrors `startMs` (the clip's start is the
 * anchor); `clip` adds the end so a fixed-length window is recoverable.
 */
export interface ClipWindow {
  readonly startMs: number;
  readonly endMs: number;
}

/**
 * A precise position inside a source (`source_locations` table) — the anchor
 * that makes lineage *actionable* ("jump to the exact paragraph"). An extract or
 * card references one of these; it captures the stable block IDs, character
 * offsets, page, media timestamp, and a `selectedText` snapshot so the origin
 * survives even if the source document is later re-imported.
 */
export interface ElementLocation {
  readonly id: SourceLocationId;
  /** The element this location belongs to (e.g. the extract). */
  readonly elementId: ElementId;
  /** The `source`/parent element this location points INTO. */
  readonly sourceElementId: ElementId;
  /** Stable block IDs spanned by the selection (order preserved). */
  readonly blockIds: readonly BlockId[];
  /** Character offset within the first block, when available. */
  readonly startOffset: number | null;
  /** Character offset within the last block, when available. */
  readonly endOffset: number | null;
  /** 1-based page number for paginated sources (PDF/EPUB), else `null`. */
  readonly page: number | null;
  /** Media timestamp in milliseconds for audio/video sources, else `null`. */
  readonly timestampMs: number | null;
  /**
   * Normalized bounding box `{ x0, y0, x1, y1 }` (fractions 0–1) for a PDF region
   * extract (T065), else `null`. Anchors a figure/table crop to its page region.
   */
  readonly region: RegionRect | null;
  /**
   * Time window `{ startMs, endMs }` for a video/audio clip extract (T074), else
   * `null`. Anchors a `media_fragment` clip to a span of the original media (the
   * `timestampMs` mirrors `startMs`); NO re-encoding — the player seeks the original.
   */
  readonly clip: ClipWindow | null;
  /** Human-readable label, e.g. "Chapter 2 · ¶4". */
  readonly label: string | null;
  /** Verbatim snapshot of the selected text at extraction time. */
  readonly selectedText: string;
}

/**
 * A read-point (`read_points` table): how far the user has processed a
 * source/topic, so reopening resumes near where they left off. Updated as the
 * user reads and auto-advanced when they extract.
 */
export interface ReadPoint {
  readonly elementId: ElementId;
  readonly blockId: BlockId;
  readonly offset: number;
  updatedAt: IsoTimestamp;
}
