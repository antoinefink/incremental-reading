/**
 * DedupReportQuery (T099) — the collection-wide duplicate ROLLUP.
 *
 * The per-candidate {@link SourceDedupQuery} (T061) answers "is THIS page already
 * imported?" for the URL-import path. This is its COLLECTION-WIDE sibling: it groups
 * the WHOLE live library into duplicate CLUSTERS so the Maintenance view can surface
 * "these N copies are redundant" and let the user reclaim the dead weight.
 *
 * It reports duplicate **sources**, **cards**, and **extracts**:
 *  - **Sources** group by **canonical URL** (over `sources_canonical_url_idx`) and,
 *    as a backstop, by the **cleaned-HTML snapshot content hash** (the
 *    `assets.content_hash` of each source's `cleaned.html` `source_html` asset — the
 *    SAME disambiguation `SourceDedupQuery.findSourceBySnapshotHash` uses). A source
 *    matched by BOTH appears ONCE (the canonical-URL key wins).
 *  - **Cards** group by a normalized content key built from the DEDICATED `cards`
 *    columns — `prompt + answer + cloze` (the canonical, FTS-indexed body; a card has
 *    no `documents`/`document_blocks` row, so this MUST come from the columns, never a
 *    `document_blocks` join that would silently degrade to title-only) — plus the
 *    element `title`.
 *  - **Extracts** group by the same normalized key, but the body text comes from the
 *    ProseMirror document — the element's `documents.plain_text` flattened mirror
 *    (the block text in order, the same body FTS indexes).
 *
 * ## The normalized content key (pinned, conservative — false positives FORBIDDEN)
 *
 * `normalizeContentKey(title, body)` = the `title` and `body` each lower-cased,
 * trimmed, and whitespace-collapsed (every run of whitespace → one space), joined with
 * a single ` ` separator. Two cards/extracts cluster ONLY when their FULL normalized
 * keys are byte-identical — an EXACT match after whitespace/case folding, never a
 * fuzzy/semantic one (KNN over `element_vectors` is a deliberate NON-GOAL; see the
 * spec's "content-key" note). This guarantees the conservative contract: a MISSED
 * near-duplicate (false negative) is fine; CLUSTERING two genuinely-different items
 * (false positive) is not. When a card has empty prompt/answer/cloze (or an extract
 * has no resolvable document body), the key degrades to **title-only** — still an
 * exact match, still safe.
 *
 * ## The keeper rule (ONE pure helper, identical for every `matchedBy` path)
 *
 * - **Sources:** the keeper is the source with the **newest `sources.accessed_at`**
 *   (resolved via the `elements → sources` join — `accessed_at` lives on `sources`,
 *   not `elements`), mirroring `findByCanonicalUrl`'s `desc(accessedAt), desc(id)`
 *   "newest live" ordering. Because `accessed_at` is NULLABLE, NULL sorts **LAST** (a
 *   real timestamp always beats NULL), with a stable `elements.id` DESC tiebreak. The
 *   content-hash backstop uses this IDENTICAL rule — {@link pickSourceKeeper}.
 * - **Cards / extracts:** the keeper is the **OLDEST** (lowest `created_at`) so the
 *   original survives and its later re-creations are the dupes; a CARD additionally
 *   prefers the one with **a non-null `source_location_id`** then the **most review
 *   history**, so dedup never sacrifices the better-lineaged / better-learned copy —
 *   {@link pickContentKeeper}.
 *
 * The `duplicates` of a cluster are the NON-keeper members — exactly what the dedup
 * cleanup action soft-deletes (it NEVER trashes the `canonical` keeper, and it
 * re-validates against a fresh report before deleting; see {@link MaintenanceService}).
 *
 * Read-only + framework-free: a typed `packages/local-db` query, never SQL in the
 * renderer, NO mutation, NO `operation_log` row.
 */

import type { ElementId } from "@interleave/core";
import {
  cards as cardsTable,
  documents as documentsTable,
  elements,
  type InterleaveDatabase,
  reviewLogs,
  sources as sourcesTable,
} from "@interleave/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { AssetRepository } from "./asset-repository";

/** The cleaned-HTML snapshot filename — the dedup-relevant `source_html` asset. */
const CLEANED_SNAPSHOT_SUFFIX = "cleaned.html";

/** Default cap on returned clusters per type (a pathological collection is bounded). */
export const DEFAULT_DEDUP_CLUSTER_LIMIT = 500;

/** How a cluster was detected — `canonicalUrl` (sources only) or a content key. */
export type DuplicateMatchKind = "canonicalUrl" | "contentHash";

/** A compact element descriptor embedded in a duplicate cluster. */
export interface DuplicateRef {
  readonly id: ElementId;
  readonly type: string;
  readonly title: string;
  /** Normalized numeric priority `0.0`–`1.0`. */
  readonly priority: number;
  readonly createdAt: string;
}

/**
 * One duplicate CLUSTER (≥2 members). `canonical` is the KEEPER the cleanup action
 * preserves; `duplicates` are the redundant copies it would soft-delete.
 */
export interface DuplicateCluster {
  /** The grouping key (the canonical URL, the snapshot hash, or the content key). */
  readonly key: string;
  readonly matchedBy: DuplicateMatchKind;
  /** The keeper (never trashed by the cleanup action). */
  readonly canonical: DuplicateRef;
  /** The redundant copies (what the cleanup action soft-deletes). */
  readonly duplicates: readonly DuplicateRef[];
}

/** The full duplicate rollup the Maintenance hub reads. */
export interface DuplicateReport {
  readonly sourceClusters: readonly DuplicateCluster[];
  readonly cardClusters: readonly DuplicateCluster[];
  readonly extractClusters: readonly DuplicateCluster[];
  /** Count of REMOVABLE copies (every cluster's `duplicates.length` summed) — the hub badge. */
  readonly totalDuplicates: number;
}

/** Options for the dedup rollup reads. */
export interface DedupReportOptions {
  /** Cap on clusters per type (default {@link DEFAULT_DEDUP_CLUSTER_LIMIT}). */
  readonly limit?: number;
}

/** A live source row, with the side-table fields the keeper rule needs. */
interface LiveSourceRow {
  readonly id: ElementId;
  readonly type: string;
  readonly title: string;
  readonly priority: number;
  readonly createdAt: string;
  readonly canonicalUrl: string | null;
  readonly accessedAt: string | null;
}

/** A live card/extract row, with the per-type body fields. */
interface LiveContentRow {
  readonly id: ElementId;
  readonly type: string;
  readonly title: string;
  readonly priority: number;
  readonly createdAt: string;
  /** Non-null `source_location_id` (cards only) — a better-lineaged keeper signal. */
  readonly hasSourceLocation: boolean;
  /** Review-log row count (cards only) — a better-learned keeper signal. */
  readonly reviewCount: number;
  /** The normalized content key this row groups under. */
  readonly contentKey: string;
}

/**
 * Normalize a `title` + `body` into the exact-match content key. Lower-cased,
 * trimmed, whitespace-collapsed, joined with a ` ` separator. Pure + exported
 * so the cards/extracts paths share ONE key and it is unit-testable.
 */
export function normalizeContentKey(title: string, body: string): string {
  return `${foldText(title)} ${foldText(body)}`;
}

/** Lower-case, trim, and collapse every run of whitespace to a single space. */
function foldText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Pick the SOURCE keeper from a cluster: newest `accessed_at` (NULL sorts LAST), with
 * a deterministic `id` DESC tiebreak. Pure + exported so the canonical-URL and
 * content-hash paths share ONE rule and it is unit-testable.
 */
export function pickSourceKeeper<T extends { id: string; accessedAt: string | null }>(
  members: readonly T[],
): T {
  return [...members].sort((a, b) => {
    // A real timestamp always beats NULL (NULL sorts last), regardless of raw NULL
    // ordering. Then newest-first by timestamp, then id DESC for a stable tiebreak.
    if (a.accessedAt === null && b.accessedAt === null) return a.id < b.id ? 1 : -1;
    if (a.accessedAt === null) return 1;
    if (b.accessedAt === null) return -1;
    if (a.accessedAt !== b.accessedAt) return a.accessedAt > b.accessedAt ? -1 : 1;
    return a.id < b.id ? 1 : -1;
  })[0] as T;
}

/**
 * Pick the CARD/EXTRACT keeper from a cluster: the OLDEST (lowest `created_at`) so the
 * original survives; a card additionally prefers a non-null `source_location_id`, then
 * more review history. Pure + exported so both paths share ONE rule.
 */
export function pickContentKeeper(members: readonly LiveContentRow[]): LiveContentRow {
  return [...members].sort((a, b) => {
    // Better lineage wins first (a sourced card is never sacrificed for an older
    // sourceless re-creation), then more review history, then the oldest original.
    if (a.hasSourceLocation !== b.hasSourceLocation) return a.hasSourceLocation ? -1 : 1;
    if (a.reviewCount !== b.reviewCount) return b.reviewCount - a.reviewCount;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  })[0] as LiveContentRow;
}

export class DedupReportQuery {
  constructor(
    private readonly db: InterleaveDatabase,
    private readonly assets: AssetRepository,
  ) {}

  /**
   * The full duplicate rollup (sources + cards + extracts). Read-only; never merges,
   * never mutates. Each cluster's `canonical` is the keeper; `duplicates` are the
   * removable copies. `totalDuplicates` counts only the removable copies.
   */
  report(options: DedupReportOptions = {}): DuplicateReport {
    const limit = options.limit ?? DEFAULT_DEDUP_CLUSTER_LIMIT;
    const sourceClusters = this.duplicateSources(limit);
    const cardClusters = this.duplicateCards(limit);
    const extractClusters = this.duplicateExtracts(limit);
    const totalDuplicates = [...sourceClusters, ...cardClusters, ...extractClusters].reduce(
      (sum, c) => sum + c.duplicates.length,
      0,
    );
    return { sourceClusters, cardClusters, extractClusters, totalDuplicates };
  }

  /**
   * Live `source` clusters grouped by canonical URL, then (backstop) by cleaned-HTML
   * snapshot hash. A source matched by BOTH appears once — the canonical-URL key wins.
   * The keeper is the newest `accessed_at` (NULL last) for EVERY `matchedBy` path.
   */
  duplicateSources(limit: number = DEFAULT_DEDUP_CLUSTER_LIMIT): DuplicateCluster[] {
    const rows = this.db
      .select({
        id: elements.id,
        type: elements.type,
        title: elements.title,
        priority: elements.priority,
        createdAt: elements.createdAt,
        canonicalUrl: sourcesTable.canonicalUrl,
        accessedAt: sourcesTable.accessedAt,
      })
      .from(elements)
      .innerJoin(sourcesTable, eq(sourcesTable.elementId, elements.id))
      .where(and(eq(elements.type, "source"), isNull(elements.deletedAt)))
      .all() as LiveSourceRow[];

    // 1) Group by canonical URL (the primary signal).
    const byUrl = new Map<string, LiveSourceRow[]>();
    const claimed = new Set<ElementId>();
    for (const row of rows) {
      if (!row.canonicalUrl) continue;
      const bucket = byUrl.get(row.canonicalUrl) ?? [];
      bucket.push(row);
      byUrl.set(row.canonicalUrl, bucket);
    }
    const clusters: DuplicateCluster[] = [];
    for (const [key, members] of byUrl) {
      if (members.length < 2) continue;
      for (const m of members) claimed.add(m.id);
      clusters.push(buildSourceCluster(key, "canonicalUrl", members));
    }

    // 2) Backstop: group by cleaned-HTML snapshot hash, EXCLUDING sources already
    //    claimed by a canonical-URL cluster (so a source appears once).
    const hashOf = this.cleanedSnapshotHashes(rows.map((r) => r.id));
    const byHash = new Map<string, LiveSourceRow[]>();
    for (const row of rows) {
      if (claimed.has(row.id)) continue;
      const hash = hashOf.get(row.id);
      if (!hash) continue;
      const bucket = byHash.get(hash) ?? [];
      bucket.push(row);
      byHash.set(hash, bucket);
    }
    for (const [key, members] of byHash) {
      if (members.length < 2) continue;
      clusters.push(buildSourceCluster(key, "contentHash", members));
    }

    return capClusters(clusters, limit);
  }

  /** Live `card` clusters grouped by the normalized `title + prompt/answer/cloze` key. */
  duplicateCards(limit: number = DEFAULT_DEDUP_CLUSTER_LIMIT): DuplicateCluster[] {
    const rows = this.db
      .select({
        id: elements.id,
        type: elements.type,
        title: elements.title,
        priority: elements.priority,
        createdAt: elements.createdAt,
        prompt: cardsTable.prompt,
        answer: cardsTable.answer,
        cloze: cardsTable.cloze,
        sourceLocationId: cardsTable.sourceLocationId,
      })
      .from(elements)
      .innerJoin(cardsTable, eq(cardsTable.elementId, elements.id))
      .where(and(eq(elements.type, "card"), isNull(elements.deletedAt)))
      .all();

    const reviewCounts = this.reviewCounts(rows.map((r) => r.id as ElementId));
    const content: LiveContentRow[] = rows.map((r) => {
      // The card body is its DEDICATED columns (NOT a document_blocks join — a card
      // has none, so that join would silently degrade to title-only).
      const body = `${r.prompt ?? ""} ${r.answer ?? ""} ${r.cloze ?? ""}`;
      return {
        id: r.id as ElementId,
        type: r.type,
        title: r.title,
        priority: r.priority,
        createdAt: r.createdAt,
        hasSourceLocation: r.sourceLocationId != null,
        reviewCount: reviewCounts.get(r.id as ElementId) ?? 0,
        contentKey: normalizeContentKey(r.title, body),
      };
    });
    return clusterContent(content, limit);
  }

  /** Live `extract` clusters grouped by the normalized `title + document body` key. */
  duplicateExtracts(limit: number = DEFAULT_DEDUP_CLUSTER_LIMIT): DuplicateCluster[] {
    const rows = this.db
      .select({
        id: elements.id,
        type: elements.type,
        title: elements.title,
        priority: elements.priority,
        createdAt: elements.createdAt,
      })
      .from(elements)
      .where(and(eq(elements.type, "extract"), isNull(elements.deletedAt)))
      .all();

    const bodyById = this.extractBodies(rows.map((r) => r.id as ElementId));
    const content: LiveContentRow[] = rows.map((r) => ({
      id: r.id as ElementId,
      type: r.type,
      title: r.title,
      priority: r.priority,
      createdAt: r.createdAt,
      // Extracts have no card row, so these keeper signals don't apply — oldest wins.
      hasSourceLocation: false,
      reviewCount: 0,
      contentKey: normalizeContentKey(r.title, bodyById.get(r.id as ElementId) ?? ""),
    }));
    return clusterContent(content, limit);
  }

  // --- internals -----------------------------------------------------------

  /**
   * The cleaned-HTML snapshot content hash for each source id (when it has a
   * `cleaned.html` `source_html` asset). Reads each source's `source_html` assets.
   */
  private cleanedSnapshotHashes(sourceIds: readonly ElementId[]): Map<ElementId, string> {
    const out = new Map<ElementId, string>();
    for (const id of sourceIds) {
      const assets = this.assets.listForElementByKind(id, "source_html");
      const cleaned = assets.find((a) =>
        a.location.vaultPath.relativePath.endsWith(CLEANED_SNAPSHOT_SUFFIX),
      );
      if (cleaned) out.set(id, cleaned.contentHash);
    }
    return out;
  }

  /**
   * Each extract's flattened body text from `documents.plain_text` (1:1 by element
   * id — `documents.element_id`). One batched read; an extract with no document row
   * simply has no entry (its key degrades to title-only).
   */
  private extractBodies(elementIds: readonly ElementId[]): Map<ElementId, string> {
    const out = new Map<ElementId, string>();
    if (elementIds.length === 0) return out;
    const rows = this.db
      .select({ elementId: documentsTable.elementId, plainText: documentsTable.plainText })
      .from(documentsTable)
      .where(inArray(documentsTable.elementId, elementIds as ElementId[]))
      .all();
    for (const r of rows) out.set(r.elementId as ElementId, r.plainText ?? "");
    return out;
  }

  /** Review-log row count per card element id (one batched grouped read). */
  private reviewCounts(cardIds: readonly ElementId[]): Map<ElementId, number> {
    const out = new Map<ElementId, number>();
    if (cardIds.length === 0) return out;
    const rows = this.db
      .select({ elementId: reviewLogs.elementId, n: sql<number>`COUNT(*)` })
      .from(reviewLogs)
      // Exclude T125 re-stabilization marker rows — they are not reviews and must not
      // inflate a card's review count.
      .where(
        and(inArray(reviewLogs.elementId, cardIds as ElementId[]), isNull(reviewLogs.editMarkerAt)),
      )
      .groupBy(reviewLogs.elementId)
      .all();
    for (const r of rows) out.set(r.elementId as ElementId, Number(r.n));
    return out;
  }
}

/** Build a source cluster from ≥2 members, picking the newest-accessed keeper. */
function buildSourceCluster(
  key: string,
  matchedBy: DuplicateMatchKind,
  members: readonly LiveSourceRow[],
): DuplicateCluster {
  const keeper = pickSourceKeeper(members);
  const duplicates = members.filter((m) => m.id !== keeper.id).map(toRef);
  return { key, matchedBy, canonical: toRef(keeper), duplicates };
}

/** Group content rows by their normalized key; emit a cluster per ≥2-member group. */
function clusterContent(rows: readonly LiveContentRow[], limit: number): DuplicateCluster[] {
  const byKey = new Map<string, LiveContentRow[]>();
  for (const row of rows) {
    const bucket = byKey.get(row.contentKey) ?? [];
    bucket.push(row);
    byKey.set(row.contentKey, bucket);
  }
  const clusters: DuplicateCluster[] = [];
  for (const [key, members] of byKey) {
    if (members.length < 2) continue;
    const keeper = pickContentKeeper(members);
    const duplicates = members.filter((m) => m.id !== keeper.id).map(toRef);
    clusters.push({ key, matchedBy: "contentHash", canonical: toRef(keeper), duplicates });
  }
  return capClusters(clusters, limit);
}

/** Cap a cluster list to `limit`, largest-first (most removable copies wins). */
function capClusters(clusters: DuplicateCluster[], limit: number): DuplicateCluster[] {
  return [...clusters]
    .sort((a, b) => b.duplicates.length - a.duplicates.length)
    .slice(0, Math.max(0, limit));
}

/** Map a live row to the compact cluster ref. */
function toRef(row: {
  id: ElementId;
  type: string;
  title: string;
  priority: number;
  createdAt: string;
}): DuplicateRef {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    priority: row.priority,
    createdAt: row.createdAt,
  };
}
