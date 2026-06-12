/**
 * Descendant inventory (T135 / U3) — the shared live-descendant walk and a typed
 * blast-radius count.
 *
 * The lineage delete flow needs to answer two questions before it can act:
 *  - "does this element still anchor live work?" (show the intent menu or just
 *    quiet-delete), and
 *  - "how big is the blast radius?" (N extracts, M cards, K of them carrying
 *    review history) so the menu can quantify what a branch delete would take.
 *
 * The live-descendant depth-first walk already existed as the PRIVATE
 * `FallowService.descendantsWithin`; this module hoists it into the shared
 * {@link liveDescendantsWithin} helper so the fallow path and this inventory walk
 * the tree the same way (one definition, not two). The walk follows
 * `elements.parentId` and skips soft-deleted rows, matching the live-only
 * lineage tree and the fallow reschedule set.
 *
 * Read-only: it performs no mutations and appends nothing to the operation log.
 */

import type { ElementId } from "@interleave/core";
import { elements, type InterleaveDatabase, reviewLogs } from "@interleave/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { DbClient } from "./types";

/**
 * SQLite's default `SQLITE_MAX_VARIABLE_NUMBER` is 999 on older builds; chunk an
 * `IN (...)` list well under it so a very large card subtree still issues a bounded
 * number of batched queries instead of one per card (the N+1 the batch read replaces).
 */
const IN_CHUNK = 500;

type ElementRow = typeof elements.$inferSelect;

/**
 * Depth-first walk of an element's LIVE descendants over `elements.parentId`,
 * skipping soft-deleted rows (which live in the trash, not the lineage). Returns
 * every live descendant of `rootId` (the root itself is NOT included). Defends
 * against cycles with a visited set.
 *
 * This is the single source of truth for the live-descendant set shared by the
 * fallow reschedule walk and the descendant inventory; both must agree on which
 * rows count as "still live work beneath this node".
 */
export function liveDescendantsWithin(tx: DbClient, rootId: ElementId): ElementRow[] {
  const out: ElementRow[] = [];
  const stack: ElementId[] = [rootId];
  const seen = new Set<ElementId>();
  while (stack.length > 0) {
    const parentId = stack.pop();
    if (!parentId || seen.has(parentId)) continue;
    seen.add(parentId);
    const children = tx
      .select()
      .from(elements)
      .where(and(eq(elements.parentId, parentId), isNull(elements.deletedAt)))
      .all();
    for (const child of children) {
      out.push(child);
      stack.push(child.id as ElementId);
    }
  }
  return out;
}

/**
 * The typed live-descendant breakdown for one element. `total` is the count of
 * ALL live descendants (every kind); `extracts`/`cards` are the per-kind splits
 * the blast-radius copy names; `cardsWithHistory` is the subset of descendant
 * cards that carry at least one `review_logs` row (a reviewed-then-forgotten card
 * still counts — the signal is "review history exists", not `reps > 0`).
 */
export interface DescendantCounts {
  /** Live descendant `extract` rows (includes sub-extracts). */
  readonly extracts: number;
  /** Live descendant `card` rows. */
  readonly cards: number;
  /** Live descendant cards with at least one `review_logs` row. */
  readonly cardsWithHistory: number;
  /** Total live descendants of every kind (drives the show-menu-or-not decision). */
  readonly total: number;
}

/**
 * Read-only descendant inventory layer. Constructed once per open database
 * alongside the other repositories; the main process exposes its count over
 * validated IPC. The renderer never instantiates this.
 */
export class DescendantQuery {
  constructor(private readonly db: InterleaveDatabase) {}

  /**
   * Count an element's LIVE descendants broken down by kind. A leaf (no live
   * descendants) returns all zeros, which the delete flow reads as "quiet delete,
   * no menu". Soft-deleted descendants are excluded; the walk counts transitively
   * through deep chains.
   */
  countDescendants(id: ElementId): DescendantCounts {
    const descendants = liveDescendantsWithin(this.db, id);
    let extracts = 0;
    const cardIds: ElementId[] = [];
    for (const row of descendants) {
      if (row.type === "extract") {
        extracts += 1;
      } else if (row.type === "card") {
        cardIds.push(row.id as ElementId);
      }
    }
    // ONE batched membership read (chunked) instead of a `review_logs` SELECT per card:
    // collect the descendant card ids, then ask which of them carry any review history.
    const withHistory = this.cardsWithReviewHistory(cardIds);
    return {
      extracts,
      cards: cardIds.length,
      cardsWithHistory: withHistory.size,
      total: descendants.length,
    };
  }

  /**
   * The subset of the given card ids that carry at least one immutable `review_logs`
   * row, read as ONE `SELECT DISTINCT elementId ... WHERE elementId IN (...)` (chunked
   * under SQLite's variable limit) rather than one existence query per card.
   */
  private cardsWithReviewHistory(cardIds: readonly ElementId[]): Set<ElementId> {
    const out = new Set<ElementId>();
    for (let i = 0; i < cardIds.length; i += IN_CHUNK) {
      const chunk = cardIds.slice(i, i + IN_CHUNK);
      if (chunk.length === 0) continue;
      const rows = this.db
        .selectDistinct({ elementId: reviewLogs.elementId })
        .from(reviewLogs)
        .where(inArray(reviewLogs.elementId, chunk as ElementId[]))
        .all();
      for (const row of rows) out.add(row.elementId as ElementId);
    }
    return out;
  }
}
