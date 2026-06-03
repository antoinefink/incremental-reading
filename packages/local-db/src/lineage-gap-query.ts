/**
 * LineageGapQuery (T099) — the read-only lineage / value scans behind the Maintenance
 * view's "cards without sources", "broken sources", and "low-value candidates" reports.
 *
 * All THREE are read-only domain queries (no mutation, no `operation_log`). They
 * SURFACE problems for the user to act on; they NEVER auto-delete (lineage is sacred —
 * a sourceless card may be a deliberately hand-authored card, so the report exists so
 * the user can DECIDE to fix the lineage or trash it).
 *
 * - **`cardsWithoutSources`** — live `card` elements whose `cards.source_location_id IS
 *   NULL` AND which have NO `derived_from` ancestor resolving to a live `source`. The
 *   denormalized `elements.source_id` is the cheap first check (a card pointing at a
 *   live source is NOT a gap); the `derived_from` edge is the authoritative one (a card
 *   may be derived from an extract derived from a source — walk the lineage root). A
 *   "card without a source" is a LINEAGE GAP, not a thing to silently delete.
 * - **`brokenSources`** — the SQL CANDIDATE set for the main-side disk join: live
 *   `source` elements + each one's snapshot `assets` rows (id + relative path). A
 *   source that should have a snapshot but has NONE is reported directly (`noSnapshot`);
 *   the on-disk "file missing" check needs the filesystem (main-only), so the main
 *   `MaintenanceService` joins this candidate set against
 *   `AssetVaultService.verifyIntegrity().missing` to produce the final rows. (Same
 *   split as the vault reports: SQL here, the disk check in the main vault service.)
 * - **`lowValueCandidates`** — live, LOW-priority (C/D band via the `@interleave/core`
 *   `priorityToLabel` helper), STALE (no recent `updated_at` activity) elements, ranked
 *   lowest-value first, that the bulk postpone / archive action targets. The
 *   FSRS-vs-attention split is irrelevant here (the report just lists candidate ids —
 *   the ACTION respects the split: cards defer on FSRS, attention items reschedule).
 *
 * Cites `cards.source_location_id` (`cards_source_location_idx`), `elements.source_id`
 * (`elements_source_idx`), `element_relations` / `element_relations_from_idx` on
 * `from_element_id` (both in `schema/relations.ts`) filtered on `relation_type =
 * 'derived_from'`, and the `assets` reference set. Read-only on both sides.
 */

import {
  type ElementId,
  type IsoTimestamp,
  type PriorityLabel,
  priorityToLabel,
} from "@interleave/core";
import {
  assets as assetsTable,
  cards as cardsTable,
  elementRelations,
  elements,
  type InterleaveDatabase,
  sources as sourcesTable,
} from "@interleave/db";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { nowIso } from "./ids";

/** Asset kinds that constitute a source's openable SNAPSHOT (the bytes you re-open). */
const SNAPSHOT_ASSET_KINDS = ["source_html", "source_pdf", "source_epub", "snapshot"] as const;

/** Default `updated_at`-age threshold (days) past which an item counts as STALE. */
export const DEFAULT_LOW_VALUE_STALE_DAYS = 30;

/** Default cap on the rows each scan returns. */
export const DEFAULT_LINEAGE_GAP_LIMIT = 500;

/** A compact element descriptor embedded in a lineage-gap / low-value row. */
export interface GapElementRef {
  readonly id: ElementId;
  readonly type: string;
  readonly title: string;
  /** Normalized numeric priority `0.0`–`1.0`. */
  readonly priority: number;
  readonly priorityLabel: PriorityLabel;
  readonly createdAt: string;
}

/** One card with NO resolvable source lineage (a gap the user fixes or trashes). */
export interface LineageGapRow {
  readonly card: GapElementRef;
  /** Always `false` here (the card has no `source_location_id`). */
  readonly hasSourceLocation: false;
  /** Always `false` here (no `derived_from` ancestor resolves to a live source). */
  readonly hasSourceAncestor: false;
  readonly createdAt: string;
}

/** One snapshot asset row of a source (id + relative path) — for the main-side disk join. */
export interface SourceSnapshotAsset {
  readonly assetId: string;
  readonly relativePath: string;
}

/**
 * A broken-source CANDIDATE: a live source + its snapshot asset rows. `hasSnapshotRow`
 * is `false` when the source has NO snapshot asset at all. `expectsSnapshot` is `true`
 * only when the source's OWN metadata recorded a snapshot (`sources.snapshot_key IS NOT
 * NULL`) — so the main side reports `noSnapshot` (a recorded snapshot whose asset row
 * vanished) ONLY for those, and NEVER for a hand-authored/manual source that legitimately
 * never captured a snapshot (its content lives in `documents` and is perfectly openable).
 */
export interface BrokenSourceCandidate {
  readonly source: GapElementRef;
  readonly snapshotAssets: readonly SourceSnapshotAsset[];
  readonly hasSnapshotRow: boolean;
  /** `true` when `sources.snapshot_key IS NOT NULL` — the source SHOULD have a snapshot. */
  readonly expectsSnapshot: boolean;
}

/** One low-value, stale candidate for the bulk postpone / archive action. */
export interface LowValueRow {
  readonly element: GapElementRef;
  /** Most recent `updated_at` activity (ISO-8601). */
  readonly lastActivityAt: IsoTimestamp;
  /** Whole days since `lastActivityAt` (relative to `asOf`). */
  readonly daysSinceActivity: number;
}

/** Options for {@link LineageGapQuery.lowValueCandidates}. */
export interface LowValueOptions {
  /** The instant the staleness is measured against (defaults to "now"). */
  readonly asOf?: IsoTimestamp;
  /** Cap the row count (defaults to {@link DEFAULT_LINEAGE_GAP_LIMIT}). */
  readonly limit?: number;
  /** Staleness threshold in days (defaults to {@link DEFAULT_LOW_VALUE_STALE_DAYS}). */
  readonly staleDays?: number;
}

const DAY_MS = 86_400_000;

export class LineageGapQuery {
  constructor(private readonly db: InterleaveDatabase) {}

  /**
   * Live `card` elements with NO resolvable source: `cards.source_location_id IS NULL`
   * AND no `derived_from` ancestor resolving to a live `source` (and no live
   * `elements.source_id`). SURFACES the gap — never deletes. Bounded by `limit`.
   */
  cardsWithoutSources(limit: number = DEFAULT_LINEAGE_GAP_LIMIT): LineageGapRow[] {
    // Live cards lacking a `source_location_id` — the only candidates for a gap.
    const candidates = this.db
      .select({
        id: elements.id,
        type: elements.type,
        title: elements.title,
        priority: elements.priority,
        createdAt: elements.createdAt,
        sourceId: elements.sourceId,
      })
      .from(elements)
      .innerJoin(cardsTable, eq(cardsTable.elementId, elements.id))
      .where(
        and(
          eq(elements.type, "card"),
          isNull(elements.deletedAt),
          isNull(cardsTable.sourceLocationId),
        ),
      )
      .orderBy(asc(elements.createdAt))
      .all();
    if (candidates.length === 0) return [];

    const rows: LineageGapRow[] = [];
    for (const c of candidates) {
      // Cheap first check: a live `source_id` means the card already traces to a source.
      if (c.sourceId && this.isLiveSource(c.sourceId as ElementId)) continue;
      // Authoritative check: walk `derived_from` to a live source ancestor.
      if (this.hasLiveSourceAncestor(c.id as ElementId)) continue;
      rows.push({
        card: toRef(c),
        hasSourceLocation: false,
        hasSourceAncestor: false,
        createdAt: c.createdAt,
      });
      if (rows.length >= limit) break;
    }
    return rows;
  }

  /**
   * The broken-source CANDIDATE set for the main-side disk join: every live `source`
   * with its snapshot asset rows (id + relative path) and whether it SHOULD have a
   * snapshot (`expectsSnapshot` = `sources.snapshot_key IS NOT NULL`). A source with no
   * snapshot row is still returned (`hasSnapshotRow: false`); the main side reports
   * `noSnapshot` ONLY when it ALSO `expectsSnapshot` (a recorded snapshot whose asset row
   * vanished), so a hand-authored/manual source that never captured a snapshot is NOT a
   * false positive. The "file missing on disk" check happens main-side via `verifyIntegrity`.
   */
  brokenSourceCandidates(): BrokenSourceCandidate[] {
    const sources = this.db
      .select({
        id: elements.id,
        type: elements.type,
        title: elements.title,
        priority: elements.priority,
        createdAt: elements.createdAt,
        snapshotKey: sourcesTable.snapshotKey,
      })
      .from(elements)
      .leftJoin(sourcesTable, eq(sourcesTable.elementId, elements.id))
      .where(and(eq(elements.type, "source"), isNull(elements.deletedAt)))
      .all();
    if (sources.length === 0) return [];

    // One batched read of every snapshot asset owned by a live source.
    const sourceIds = sources.map((s) => s.id as ElementId);
    const snapRows = this.db
      .select({
        owningElementId: assetsTable.owningElementId,
        assetId: assetsTable.id,
        relativePath: assetsTable.relativePath,
      })
      .from(assetsTable)
      .where(
        and(
          inArray(assetsTable.owningElementId, sourceIds as ElementId[]),
          inArray(assetsTable.kind, SNAPSHOT_ASSET_KINDS as unknown as string[]),
        ),
      )
      .all();
    const byOwner = new Map<string, SourceSnapshotAsset[]>();
    for (const r of snapRows) {
      const bucket = byOwner.get(r.owningElementId) ?? [];
      bucket.push({ assetId: r.assetId, relativePath: r.relativePath });
      byOwner.set(r.owningElementId, bucket);
    }

    return sources.map((s) => {
      const snapshotAssets = byOwner.get(s.id) ?? [];
      return {
        source: toRef(s),
        snapshotAssets,
        hasSnapshotRow: snapshotAssets.length > 0,
        expectsSnapshot: s.snapshotKey != null,
      };
    });
  }

  /**
   * Live, low-priority (C/D band), stale (no recent `updated_at` activity) elements,
   * ranked LOWEST-value first (lowest priority, then most stale, then oldest). The
   * bulk postpone / archive action's candidate set. Read-only. Bounded by `limit`.
   */
  lowValueCandidates(options: LowValueOptions = {}): LowValueRow[] {
    const asOf = (options.asOf ?? nowIso()) as IsoTimestamp;
    const limit = options.limit ?? DEFAULT_LINEAGE_GAP_LIMIT;
    const staleDays = options.staleDays ?? DEFAULT_LOW_VALUE_STALE_DAYS;
    const asOfMs = Date.parse(asOf);
    const cutoffMs = (Number.isNaN(asOfMs) ? Date.now() : asOfMs) - staleDays * DAY_MS;

    const rows = this.db
      .select({
        id: elements.id,
        type: elements.type,
        title: elements.title,
        priority: elements.priority,
        createdAt: elements.createdAt,
        updatedAt: elements.updatedAt,
      })
      .from(elements)
      .where(isNull(elements.deletedAt))
      .all();

    const candidates: LowValueRow[] = [];
    for (const r of rows) {
      const label = priorityToLabel(r.priority);
      // Low-priority band only — C/D are sacrificed first under overload.
      if (label !== "C" && label !== "D") continue;
      const updatedMs = Date.parse(r.updatedAt);
      const activityMs = Number.isNaN(updatedMs) ? 0 : updatedMs;
      // Stale: no activity since the cutoff.
      if (activityMs > cutoffMs) continue;
      const refAsOf = Number.isNaN(asOfMs) ? Date.now() : asOfMs;
      const daysSinceActivity = Math.max(0, Math.floor((refAsOf - activityMs) / DAY_MS));
      candidates.push({
        element: toRef(r),
        lastActivityAt: r.updatedAt as IsoTimestamp,
        daysSinceActivity,
      });
    }

    // Lowest-value first: lowest priority, then most stale, then oldest, then id.
    candidates.sort((a, b) => {
      if (a.element.priority !== b.element.priority) return a.element.priority - b.element.priority;
      if (a.daysSinceActivity !== b.daysSinceActivity)
        return b.daysSinceActivity - a.daysSinceActivity;
      if (a.element.createdAt !== b.element.createdAt)
        return a.element.createdAt < b.element.createdAt ? -1 : 1;
      return a.element.id < b.element.id ? -1 : 1;
    });
    return candidates.slice(0, Math.max(0, limit));
  }

  // --- internals -----------------------------------------------------------

  /** Whether `id` is a LIVE `source` element. */
  private isLiveSource(id: ElementId): boolean {
    const row = this.db
      .select({ type: elements.type, deletedAt: elements.deletedAt })
      .from(elements)
      .where(eq(elements.id, id))
      .get();
    return row != null && row.type === "source" && row.deletedAt == null;
  }

  /**
   * Walk `derived_from` edges from `start` toward its lineage root; return `true` if any
   * reachable ancestor is a LIVE source. Bounded by a visited-set so a cyclic/odd graph
   * can never loop forever (lineage is a DAG by construction, but the guard is cheap).
   */
  private hasLiveSourceAncestor(start: ElementId): boolean {
    const visited = new Set<ElementId>();
    let frontier: ElementId[] = [start];
    // Cap the walk depth defensively (lineage chains are short: source→extract→card).
    for (let depth = 0; depth < 32 && frontier.length > 0; depth += 1) {
      const next: ElementId[] = [];
      for (const id of frontier) {
        if (visited.has(id)) continue;
        visited.add(id);
        const edges = this.db
          .select({ toElementId: elementRelations.toElementId })
          .from(elementRelations)
          .where(
            and(
              eq(elementRelations.fromElementId, id),
              eq(elementRelations.relationType, "derived_from"),
            ),
          )
          .all();
        for (const e of edges) {
          const to = e.toElementId as ElementId;
          if (this.isLiveSource(to)) return true;
          next.push(to);
        }
      }
      frontier = next;
    }
    return false;
  }
}

/** Map a live row to the compact ref (with its A/B/C/D label). */
function toRef(row: {
  id: string;
  type: string;
  title: string;
  priority: number;
  createdAt: string;
}): GapElementRef {
  return {
    id: row.id as ElementId,
    type: row.type,
    title: row.title,
    priority: row.priority,
    priorityLabel: priorityToLabel(row.priority),
    createdAt: row.createdAt,
  };
}
