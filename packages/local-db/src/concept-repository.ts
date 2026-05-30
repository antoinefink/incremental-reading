/**
 * ConceptRepository (T041) — create / list / assign hierarchical **concepts**.
 *
 * A concept is DUAL-MODELED (the load-bearing invariant): it is a `concept`-type
 * {@link Element} (so it has an id/status/priority and logs `create_element`) PLUS
 * a `concepts` side-table row (`name`, `parentConceptId`) written in the SAME
 * transaction. This mirrors the seed factory's `createConcept`
 * (`packages/testing/src/factories.ts`) exactly — concept-membership edges in
 * `element_relations` reference `elements.id`, so the concept must exist as an
 * element for the FK to hold.
 *
 * Concept MEMBERSHIP of an element is a `concept_membership` edge in
 * `element_relations` (`from = member element`, `to = concept` — the direction the
 * seed records), assigned/removed through {@link ElementRepository.addRelation} /
 * `removeRelation` (which log `add_relation` / `remove_relation`). There are NO new
 * `operation_log` op types — concepts reuse the closed 15-op set
 * (`create_element` / `add_relation` / `remove_relation`).
 *
 * Read-only methods (`listConcepts`, `conceptsForElement`, `elementsForConcept`)
 * append nothing to the operation log. The renderer never instantiates this; the
 * Electron main/DB service composes it behind validated IPC (`concepts.*`).
 */

import type { ElementId, RelationId } from "@interleave/core";
import { PRIORITY_LABEL_VALUE } from "@interleave/core";
import { concepts, elementRelations, elements, type InterleaveDatabase } from "@interleave/db";
import { and, eq, isNull } from "drizzle-orm";
import { ElementRepository } from "./element-repository";

/** Arguments to create a new concept. */
export interface CreateConceptInput {
  /** Display name (1–256 chars; validated at the IPC boundary). */
  readonly name: string;
  /** Optional parent concept for the hierarchy; `null`/absent for a root concept. */
  readonly parentConceptId?: ElementId | null;
}

/** A concept as a flat summary (id + name + parent link). */
export interface ConceptSummary {
  readonly id: ElementId;
  readonly name: string;
  readonly parentConceptId: ElementId | null;
}

/**
 * A concept node for the filterbar + the read-only concept map: the concept plus
 * its cheap derived counts (direct children, and members via `concept_membership`
 * edges).
 */
export interface ConceptNode {
  readonly id: ElementId;
  readonly name: string;
  readonly parentConceptId: ElementId | null;
  /** Number of direct child concepts in the hierarchy. */
  readonly childCount: number;
  /** Number of LIVE (not soft-deleted) elements that are members of this concept. */
  readonly memberCount: number;
}

export class ConceptRepository {
  private readonly elementRepo: ElementRepository;

  constructor(private readonly db: InterleaveDatabase) {
    this.elementRepo = new ElementRepository(db);
  }

  /**
   * Create a concept — the `concept`-type element (via
   * {@link ElementRepository.createWithin}, so `create_element` is logged) AND its
   * `concepts` hierarchy row — in ONE transaction. Mirrors the seed factory's
   * `createConcept`. Validates that `parentConceptId`, when given, refers to an
   * existing live concept (and is not the concept itself — a fresh id can never be
   * its own parent, but the guard documents intent). Returns the flat summary.
   */
  createConcept(input: CreateConceptInput): ConceptSummary {
    const name = input.name.trim();
    if (name.length === 0) {
      throw new Error("ConceptRepository.createConcept: name must be non-empty");
    }
    const parentConceptId = input.parentConceptId ?? null;

    return this.db.transaction((tx) => {
      // Validate the parent exists as a concept element + a concepts row (a
      // one-level parent check; the FK + this guard prevent dangling parents).
      if (parentConceptId) {
        const parentEl = tx.select().from(elements).where(eq(elements.id, parentConceptId)).get();
        const parentRow = tx.select().from(concepts).where(eq(concepts.id, parentConceptId)).get();
        if (parentEl?.type !== "concept" || parentEl.deletedAt || !parentRow) {
          throw new Error(
            `ConceptRepository.createConcept: parent concept ${parentConceptId} not found`,
          );
        }
      }

      // 1) The concept element (logs `create_element` on the same tx).
      const element = this.elementRepo.createWithin(tx, {
        type: "concept",
        status: "active",
        stage: "synthesis",
        priority: PRIORITY_LABEL_VALUE.B,
        title: name,
      });
      // 2) The concepts side-table row (the hierarchy link) — same transaction.
      tx.insert(concepts).values({ id: element.id, name, parentConceptId }).run();

      return { id: element.id, name, parentConceptId };
    });
  }

  /** Fetch one concept summary by id, or `null`. */
  findById(id: ElementId): ConceptSummary | null {
    const row = this.db.select().from(concepts).where(eq(concepts.id, id)).get();
    if (!row) return null;
    return {
      id: row.id as ElementId,
      name: row.name,
      parentConceptId: (row.parentConceptId as ElementId | null) ?? null,
    };
  }

  /**
   * All concepts as a flat list of {@link ConceptNode} (the renderer builds the
   * hierarchy from `parentConceptId`), each with its direct-child count and a
   * member count from the live `concept_membership` edges. Concepts whose element
   * was soft-deleted are excluded.
   */
  listConcepts(): ConceptNode[] {
    // Live concept elements only (a soft-deleted concept element drops out).
    const liveConceptIds = new Set(
      this.db
        .select({ id: elements.id })
        .from(elements)
        .where(and(eq(elements.type, "concept"), isNull(elements.deletedAt)))
        .all()
        .map((r) => r.id as ElementId),
    );

    const conceptRows = this.db.select().from(concepts).all();
    const live = conceptRows.filter((r) => liveConceptIds.has(r.id as ElementId));

    // Direct-child counts (over live concepts only).
    const childCounts = new Map<ElementId, number>();
    for (const row of live) {
      const parent = (row.parentConceptId as ElementId | null) ?? null;
      if (parent && liveConceptIds.has(parent)) {
        childCounts.set(parent, (childCounts.get(parent) ?? 0) + 1);
      }
    }

    // Member counts: distinct LIVE elements with a `concept_membership` edge to the
    // concept. The edge direction is `from = member element`, `to = concept`.
    const memberCounts = new Map<ElementId, Set<ElementId>>();
    const membershipRows = this.db
      .select()
      .from(elementRelations)
      .where(eq(elementRelations.relationType, "concept_membership"))
      .all();
    const liveMemberIds = new Set(
      this.db
        .select({ id: elements.id })
        .from(elements)
        .where(isNull(elements.deletedAt))
        .all()
        .map((r) => r.id as ElementId),
    );
    for (const edge of membershipRows) {
      const conceptId = edge.toElementId as ElementId;
      const memberId = edge.fromElementId as ElementId;
      if (!liveConceptIds.has(conceptId) || !liveMemberIds.has(memberId)) continue;
      let set = memberCounts.get(conceptId);
      if (!set) {
        set = new Set<ElementId>();
        memberCounts.set(conceptId, set);
      }
      set.add(memberId);
    }

    return live.map((row) => {
      const id = row.id as ElementId;
      return {
        id,
        name: row.name,
        parentConceptId: (row.parentConceptId as ElementId | null) ?? null,
        childCount: childCounts.get(id) ?? 0,
        memberCount: memberCounts.get(id)?.size ?? 0,
      };
    });
  }

  /**
   * Assign an element to a concept — add the `concept_membership` edge
   * (`from = element`, `to = concept`) via {@link ElementRepository.addRelation},
   * logging `add_relation`. Idempotent: re-assigning the same pair is a no-op
   * (the existing edge is kept; no duplicate row, no second op).
   */
  assignConcept(elementId: ElementId, conceptId: ElementId): void {
    const concept = this.findById(conceptId);
    if (!concept) {
      throw new Error(`ConceptRepository.assignConcept: concept ${conceptId} not found`);
    }
    // Idempotency: skip when the membership already exists.
    const existing = this.elementRepo
      .listRelationsFrom(elementId)
      .find((r) => r.relationType === "concept_membership" && r.toElementId === conceptId);
    if (existing) return;
    this.elementRepo.addRelation({
      fromElementId: elementId,
      toElementId: conceptId,
      relationType: "concept_membership",
    });
  }

  /**
   * Unassign an element from a concept — remove the `concept_membership` edge via
   * {@link ElementRepository.removeRelation}, logging `remove_relation`. Idempotent:
   * unassigning a pair that isn't a member is a no-op.
   */
  unassignConcept(elementId: ElementId, conceptId: ElementId): void {
    const edge = this.elementRepo
      .listRelationsFrom(elementId)
      .find((r) => r.relationType === "concept_membership" && r.toElementId === conceptId);
    if (!edge) return;
    this.elementRepo.removeRelation(edge.id as RelationId);
  }

  /** The concepts an element is a member of (resolves the `concept_membership` edges). */
  conceptsForElement(elementId: ElementId): ConceptSummary[] {
    const conceptIds = this.elementRepo
      .listRelationsFrom(elementId)
      .filter((r) => r.relationType === "concept_membership")
      .map((r) => r.toElementId as ElementId);
    const out: ConceptSummary[] = [];
    for (const id of conceptIds) {
      const summary = this.findById(id);
      if (summary) out.push(summary);
    }
    return out;
  }

  /**
   * The NAME of the first LIVE concept an element is a member of (for the per-row
   * meta line on the queue / search rows / review face), or `null`. The ONE shared
   * "first membership walk" — skips a membership whose concept element was
   * soft-deleted, so a deleted concept never shows on a row.
   */
  firstConceptName(elementId: ElementId): string | null {
    const membership = this.elementRepo
      .listRelationsFrom(elementId)
      .find((r) => r.relationType === "concept_membership");
    if (!membership) return null;
    const conceptEl = this.elementRepo.findById(membership.toElementId as ElementId);
    return conceptEl && !conceptEl.deletedAt ? conceptEl.title : null;
  }

  /**
   * The LIVE element ids that are members of a concept (feeds concept filtering +
   * counts). Reads the `concept_membership` edges (`to = concept`) and keeps only
   * members whose element is not soft-deleted.
   */
  elementsForConcept(conceptId: ElementId): ElementId[] {
    const edges = this.db
      .select()
      .from(elementRelations)
      .where(
        and(
          eq(elementRelations.relationType, "concept_membership"),
          eq(elementRelations.toElementId, conceptId),
        ),
      )
      .all();
    const out: ElementId[] = [];
    const seen = new Set<ElementId>();
    for (const edge of edges) {
      const memberId = edge.fromElementId as ElementId;
      if (seen.has(memberId)) continue;
      const el = this.elementRepo.findById(memberId);
      if (el && !el.deletedAt) {
        seen.add(memberId);
        out.push(memberId);
      }
    }
    return out;
  }
}
