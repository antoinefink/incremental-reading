/**
 * LibraryQuery (Library route) — the facet-driven "browse everything" read.
 *
 * The Library surface is DISTINCT from search (`SearchRepository`): search is
 * keyword-driven over the FTS5 index and returns `[]` for an empty query (and
 * only covers source/extract/card). Library DEFAULTS to listing ALL live
 * elements and narrows by FACETS (type / concept / priority / status) — no
 * keyword required — and covers the element types that have no FTS index
 * (topic / synthesis_note / task) which keyword search can never return.
 *
 * This is a READ-ONLY query layer (it appends nothing to the operation log),
 * constructed once per open database alongside {@link Repositories} (the same
 * pattern as {@link QueueQuery} / {@link InspectorQuery}). It composes the
 * existing repositories — the live `elements` read narrowed by
 * type/status/priority + the `concept_membership` join via
 * {@link ConceptRepository.elementsForConcept} — and returns plain element ids
 * (ordered priority desc, then `updated_at` desc, capped by `limit`) plus the
 * unfiltered per-facet counts. The DB service enriches each id with the SAME
 * scheduler/due/concept/refblock fields the search/queue rows carry (no
 * duplicated scheduling math). The renderer never issues SQL.
 */

import {
  type Element,
  type ElementId,
  type ElementStatus,
  type ElementType,
  priorityToLabel,
} from "@interleave/core";
import { elements, type InterleaveDatabase } from "@interleave/db";
import { and, inArray, isNull } from "drizzle-orm";
import type { Repositories } from "./index";
import { rowToElement } from "./mappers";

/** The four coarse priority labels the facet column exposes. */
export type LibraryPriorityLabel = "A" | "B" | "C" | "D";

/**
 * The six BROWSABLE element types — every distillation type EXCEPT `concept`
 * (concepts are a FACET column, not a browsed row) and `media_fragment` (not yet
 * a first-class browse row in the MVP; it has no reader target). Kept in display
 * order so the grouped result sections render deterministically.
 */
export const LIBRARY_TYPES: readonly ElementType[] = [
  "source",
  "extract",
  "card",
  "topic",
  "synthesis_note",
  "task",
] as const;
const LIBRARY_TYPE_SET = new Set<ElementType>(LIBRARY_TYPES);

/** The statuses the facet column exposes (live, non-deleted lifecycle states). */
export const LIBRARY_STATUSES: readonly ElementStatus[] = [
  "active",
  "scheduled",
  "inbox",
  "pending",
  "done",
  "suspended",
] as const;

/** Default cap so a broad browse can't return an unbounded list. */
const DEFAULT_LIMIT = 200;

/** The facet filters a browse accepts. All optional; absent = no narrowing. */
export interface LibraryBrowseFilters {
  /** Keep only these element types (from {@link LIBRARY_TYPES}). */
  readonly types?: readonly ElementType[];
  /** Keep only members of this concept (`concept_membership` edge). */
  readonly conceptId?: ElementId;
  /** Keep only elements whose priority maps to this A/B/C/D band. */
  readonly priorityLabel?: LibraryPriorityLabel;
  /** Keep only these lifecycle statuses. */
  readonly statuses?: readonly ElementStatus[];
  /** Cap the result count (defaults to {@link DEFAULT_LIMIT}). */
  readonly limit?: number;
}

/** Per-facet counts over the UNFILTERED live browse universe (for the facet labels). */
export interface LibraryBrowseCounts {
  readonly all: number;
  /** Per browsable type. */
  readonly byType: Readonly<Record<ElementType, number>>;
  /** Per priority band A/B/C/D. */
  readonly byPriority: Readonly<Record<LibraryPriorityLabel, number>>;
  /** Per lifecycle status. */
  readonly byStatus: Readonly<Record<string, number>>;
}

/** The browse read: the ordered live element rows + the per-facet counts. */
export interface LibraryBrowseData {
  /** The narrowed, ordered (priority desc, updated_at desc), capped rows. */
  readonly items: readonly Element[];
  readonly counts: LibraryBrowseCounts;
}

/**
 * Read-only library browse query layer. Constructed once per open database
 * (alongside {@link Repositories}); the main process exposes it over validated IPC.
 */
export class LibraryQuery {
  constructor(
    private readonly db: InterleaveDatabase,
    private readonly repos: Repositories,
  ) {}

  /**
   * The facet-driven browse-all read. Reads the live browsable universe (every
   * non-deleted element of a {@link LIBRARY_TYPES} type), computes the per-facet
   * counts over that UNFILTERED universe, then narrows by the
   * type/status/priority/concept facets, orders by **priority desc then
   * `updated_at` desc**, and caps by `limit`. With NO filters it returns
   * everything (newest/priority-ranked) — the browse-first default that
   * distinguishes Library from keyword search.
   */
  browse(filters: LibraryBrowseFilters = {}): LibraryBrowseData {
    // The live browsable universe — every non-deleted element of a browsable type
    // (concepts/media_fragments excluded). One indexed read; the row count is the
    // user's whole collection, well within an in-memory pass.
    const universe = this.db
      .select()
      .from(elements)
      .where(
        and(inArray(elements.type, LIBRARY_TYPES as ElementType[]), isNull(elements.deletedAt)),
      )
      .all()
      .map(rowToElement);

    // Per-facet counts over the UNFILTERED universe (so facet labels show real totals).
    const counts = this.countFacets(universe);

    // Concept membership is resolved once (the live member ids for the picked
    // concept) and matched as a set — reusing the canonical `elementsForConcept`
    // walk so a member matches the SAME way it does in queue/search filtering.
    const conceptMembers = filters.conceptId
      ? new Set<ElementId>(this.repos.concepts.elementsForConcept(filters.conceptId))
      : null;

    const typeFilter =
      filters.types && filters.types.length > 0
        ? new Set<ElementType>(filters.types.filter((t) => LIBRARY_TYPE_SET.has(t)))
        : null;
    const statusFilter =
      filters.statuses && filters.statuses.length > 0
        ? new Set<ElementStatus>(filters.statuses)
        : null;

    const matched = universe.filter((el) => {
      if (typeFilter && !typeFilter.has(el.type)) return false;
      if (statusFilter && !statusFilter.has(el.status)) return false;
      if (filters.priorityLabel && priorityToLabel(el.priority) !== filters.priorityLabel) {
        return false;
      }
      if (conceptMembers && !conceptMembers.has(el.id)) return false;
      return true;
    });

    const ordered = this.order(matched);
    const limit = filters.limit ?? DEFAULT_LIMIT;
    const items = ordered.slice(0, limit);

    return { items, counts };
  }

  /** Order by priority DESCending, then `updated_at` DESCending (newest first). Stable. */
  private order(rows: readonly Element[]): Element[] {
    return [...rows].sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      const au = a.updatedAt ? Date.parse(a.updatedAt) : 0;
      const bu = b.updatedAt ? Date.parse(b.updatedAt) : 0;
      return bu - au;
    });
  }

  /** Build the per-type / per-priority / per-status counts over the universe. */
  private countFacets(universe: readonly Element[]): LibraryBrowseCounts {
    const byType = Object.fromEntries(LIBRARY_TYPES.map((t) => [t, 0])) as Record<
      ElementType,
      number
    >;
    const byPriority: Record<LibraryPriorityLabel, number> = { A: 0, B: 0, C: 0, D: 0 };
    const byStatus: Record<string, number> = {};
    for (const status of LIBRARY_STATUSES) byStatus[status] = 0;

    for (const el of universe) {
      byType[el.type] = (byType[el.type] ?? 0) + 1;
      byPriority[priorityToLabel(el.priority)] += 1;
      byStatus[el.status] = (byStatus[el.status] ?? 0) + 1;
    }
    return { all: universe.length, byType, byPriority, byStatus };
  }
}
