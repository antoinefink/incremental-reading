/**
 * Property-based / fuzzy tests for the Library DRILL-DOWN faceted counts
 * ({@link LibraryQuery.browse}).
 *
 * The reported bug: facet counts were computed over the UNFILTERED universe while
 * the visible list is the INTERSECTION of all active facets, so a chip count never
 * matched the list (Attention=4 but only 3 extracts shown). The fix makes every
 * facet dimension's counts respect ALL OTHER active filters but NOT its own value.
 *
 * The HARD INVARIANT — `counts[dim][V]` equals the number of result rows when V is
 * selected alongside the other already-active filters — is exactly the kind of
 * cross-cutting property that example tests miss in a corner. So we fuzz it: build
 * random worlds (varied type/status/priority/updatedAt, soft-deleted elements +
 * concepts, duplicate + dead-endpoint membership edges), pick random combinations
 * of active filters, and re-derive the count for every facet value by ACTUALLY
 * running the browse with that value added — then assert the reported count equals
 * the re-run's row count. We also assert the soft-delete / dedup / ordering / limit
 * invariants and reproduce the exact screenshot scenario.
 *
 * fast-check pins a fixed seed by default; we pin `seed`/`numRuns` so a failure is
 * reproducible in CI.
 */

import type { ElementId, ElementStatus, ElementType } from "@interleave/core";
import { PRIORITY_LABEL_VALUE, priorityToLabel } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRepositories, type Repositories } from "./index";
import {
  LIBRARY_STATUSES,
  LIBRARY_TYPES,
  type LibraryPriorityLabel,
  LibraryQuery,
} from "./library-query";
import { createInMemoryDb } from "./test-db";

const FC = { seed: 0x11b_2a17, numRuns: 200, verbose: false } as const;

// Hermetic per fast-check RUN: a property predicate runs many times within one
// `it`, so each generated world gets a fresh in-memory DB (a shared beforeEach DB
// would leak the previous world into the next). The open handle is closed before
// the next run.
let handle: DbHandle | null = null;
let repos!: Repositories;
let library!: LibraryQuery;

function freshDb(): void {
  if (handle) handle.sqlite.close();
  handle = createInMemoryDb();
  repos = createRepositories(handle.db);
  library = new LibraryQuery(handle.db, repos);
}

beforeEach(freshDb);
afterEach(() => {
  if (handle) handle.sqlite.close();
  handle = null;
});

// The four priority bands, materialized to a numeric value each maps cleanly to.
const PRIORITY_BY_LABEL: Record<LibraryPriorityLabel, number> = {
  A: PRIORITY_LABEL_VALUE.A,
  B: PRIORITY_LABEL_VALUE.B,
  C: PRIORITY_LABEL_VALUE.C,
  D: PRIORITY_LABEL_VALUE.D,
};
// Live statuses the universe can hold (the facet statuses; never "deleted").
const GEN_STATUSES = LIBRARY_STATUSES;

interface ElementSpec {
  readonly key: number;
  readonly type: ElementType;
  readonly status: ElementStatus;
  readonly priorityLabel: LibraryPriorityLabel;
  readonly bump: number; // extra updates to perturb updatedAt ordering (0..2)
  readonly deleted: boolean;
}
interface ConceptSpec {
  readonly key: number;
  readonly deleted: boolean;
}
interface EdgeSpec {
  readonly memberIdx: number;
  readonly conceptIdx: number;
  readonly dup: number; // extra duplicate edges (0..2)
}
interface FilterSpec {
  readonly useType: boolean;
  readonly typeIdx: number;
  readonly useConcept: boolean;
  readonly conceptIdx: number;
  readonly usePriority: boolean;
  readonly priorityIdx: number;
  readonly useStatus: boolean;
  readonly statusIdx: number;
}
interface WorldSpec {
  readonly elements: readonly ElementSpec[];
  readonly concepts: readonly ConceptSpec[];
  readonly edges: readonly EdgeSpec[];
  readonly filter: FilterSpec;
}

const elementSpecArb: fc.Arbitrary<Omit<ElementSpec, "key">> = fc.record({
  type: fc.constantFrom(...LIBRARY_TYPES),
  status: fc.constantFrom(...GEN_STATUSES),
  priorityLabel: fc.constantFrom<LibraryPriorityLabel>("A", "B", "C", "D"),
  bump: fc.integer({ min: 0, max: 2 }),
  deleted: fc.boolean(),
});

const filterArb: fc.Arbitrary<FilterSpec> = fc.record({
  useType: fc.boolean(),
  typeIdx: fc.integer({ min: 0, max: LIBRARY_TYPES.length - 1 }),
  useConcept: fc.boolean(),
  conceptIdx: fc.nat(),
  usePriority: fc.boolean(),
  priorityIdx: fc.integer({ min: 0, max: 3 }),
  useStatus: fc.boolean(),
  statusIdx: fc.integer({ min: 0, max: GEN_STATUSES.length - 1 }),
});

const worldArb: fc.Arbitrary<WorldSpec> = fc
  .record({
    elements: fc.array(elementSpecArb, { minLength: 1, maxLength: 14 }),
    concepts: fc.array(fc.record({ deleted: fc.boolean() }), { minLength: 1, maxLength: 5 }),
    filter: filterArb,
  })
  .chain(({ elements, concepts, filter }) => {
    const edgeArb: fc.Arbitrary<EdgeSpec> = fc.record({
      memberIdx: fc.integer({ min: 0, max: elements.length - 1 }),
      conceptIdx: fc.integer({ min: 0, max: concepts.length - 1 }),
      dup: fc.integer({ min: 0, max: 2 }),
    });
    return fc.record({
      elements: fc.constant(elements.map((e, key) => ({ ...e, key }))),
      concepts: fc.constant(concepts.map((c, key) => ({ ...c, key }))),
      edges: fc.array(edgeArb, { minLength: 0, maxLength: 30 }),
      filter: fc.constant(filter),
    });
  });

const PRIORITY_LABELS: readonly LibraryPriorityLabel[] = ["A", "B", "C", "D"];

interface BuiltWorld {
  readonly elementIds: readonly ElementId[];
  readonly conceptIds: readonly ElementId[];
  readonly liveConceptIds: readonly ElementId[];
  readonly filters: {
    types?: readonly ElementType[];
    conceptId?: ElementId;
    priorityLabel?: LibraryPriorityLabel;
    statuses?: readonly ElementStatus[];
  };
}

/** Materialize a generated world into a FRESH DB and resolve the active filter set. */
function buildWorld(world: WorldSpec): BuiltWorld {
  freshDb();

  const elementIds: ElementId[] = world.elements.map((spec) => {
    const el = repos.elements.create({
      type: spec.type,
      status: spec.status,
      stage: "raw_extract",
      priority: PRIORITY_BY_LABEL[spec.priorityLabel],
      title: `el-${spec.key}`,
    });
    // Perturb updatedAt so ordering ties are genuinely exercised (each update
    // touches updated_at). A no-op-ish title bump is enough to move the timestamp.
    for (let i = 0; i < spec.bump; i++) {
      repos.elements.update(el.id, { title: `el-${spec.key}-${i}` });
    }
    return el.id;
  });
  const conceptIds: ElementId[] = world.concepts.map(
    (spec) => repos.concepts.createConcept({ name: `concept-${spec.key}` }).id,
  );

  // Membership edges with raw duplicates via addRelation (NOT assignConcept) so the
  // substrate's own dedup is exercised.
  for (const edge of world.edges) {
    const memberId = elementIds[edge.memberIdx];
    const conceptId = conceptIds[edge.conceptIdx];
    if (!memberId || !conceptId) continue;
    for (let i = 0; i < 1 + edge.dup; i++) {
      repos.elements.addRelation({
        fromElementId: memberId,
        toElementId: conceptId,
        relationType: "concept_membership",
      });
    }
  }

  // Soft-delete flagged endpoints AFTER wiring (edges to dead endpoints).
  world.elements.forEach((spec, idx) => {
    const id = elementIds[idx];
    if (spec.deleted && id) repos.elements.softDelete(id);
  });
  world.concepts.forEach((spec, idx) => {
    const id = conceptIds[idx];
    if (spec.deleted && id) repos.elements.softDelete(id);
  });

  const liveConceptIds = conceptIds.filter((_, idx) => !world.concepts[idx]?.deleted);

  // Resolve the generated active-filter set. Concept picks from LIVE concepts only
  // (the filterbar only shows live concepts); skip if none are live.
  const f = world.filter;
  const filters: BuiltWorld["filters"] = {};
  if (f.useType) {
    const t = LIBRARY_TYPES[f.typeIdx];
    if (t) filters.types = [t];
  }
  if (f.usePriority) filters.priorityLabel = PRIORITY_LABELS[f.priorityIdx] ?? "A";
  if (f.useStatus) {
    const s = GEN_STATUSES[f.statusIdx];
    if (s) filters.statuses = [s];
  }
  if (f.useConcept && liveConceptIds.length > 0) {
    const picked = liveConceptIds[f.conceptIdx % liveConceptIds.length];
    if (picked) filters.conceptId = picked;
  }

  return { elementIds, conceptIds, liveConceptIds, filters };
}

describe("LibraryQuery drill-down counts — property invariants", () => {
  it("INVARIANT: every facet count equals the rows when that value is added to the active filters", () => {
    fc.assert(
      fc.property(worldArb, (world) => {
        const { liveConceptIds, filters } = buildWorld(world);
        const { items, counts } = library.browse(filters);

        // (all) equals the RENDERED list (items.length, post-limit). The default
        // limit (200) is never hit at these world sizes, so this also equals the full
        // match count here; the dedicated limit-cap property below exercises the
        // truncating case where the match set exceeds the cap.
        expect(counts.all).toBe(items.length);

        // byType: re-run with each type added (replacing the active type), assert the
        // count equals the resulting row count.
        for (const t of LIBRARY_TYPES) {
          const rerun = library.browse({ ...filters, types: [t] });
          expect(counts.byType[t] ?? 0).toBe(rerun.items.length);
        }
        // byPriority.
        for (const pLabel of PRIORITY_LABELS) {
          const rerun = library.browse({ ...filters, priorityLabel: pLabel });
          expect(counts.byPriority[pLabel] ?? 0).toBe(rerun.items.length);
        }
        // byStatus.
        for (const s of LIBRARY_STATUSES) {
          const rerun = library.browse({ ...filters, statuses: [s] });
          expect(counts.byStatus[s] ?? 0).toBe(rerun.items.length);
        }
        // byConcept (live concepts only — dead concepts are never offered as a facet).
        for (const conceptId of liveConceptIds) {
          const rerun = library.browse({ ...filters, conceptId });
          expect(counts.byConcept[conceptId] ?? 0).toBe(rerun.items.length);
        }
      }),
      FC,
    );
  });

  it("INVARIANT: soft-deleted elements & concepts never appear in items and never inflate a count", () => {
    fc.assert(
      fc.property(worldArb, (world) => {
        const built = buildWorld(world);
        // Index-aligned dead-endpoint id sets, built from the generated spec.
        const deadEls = new Set<ElementId>();
        world.elements.forEach((spec, idx) => {
          const id = built.elementIds[idx];
          if (spec.deleted && id) deadEls.add(id);
        });
        const deadConcepts = new Set<ElementId>();
        world.concepts.forEach((spec, idx) => {
          const id = built.conceptIds[idx];
          if (spec.deleted && id) deadConcepts.add(id);
        });

        const { items, counts } = library.browse(built.filters);
        for (const item of items) expect(deadEls.has(item.id as ElementId)).toBe(false);

        // A soft-deleted concept must contribute NO byConcept entry.
        for (const dead of deadConcepts) expect(counts.byConcept[dead] ?? 0).toBe(0);
      }),
      FC,
    );
  });

  it("INVARIANT: duplicate membership edges never double-count byConcept", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 8 }), (dupCount) => {
        freshDb();
        const ex = repos.elements.create({
          type: "extract",
          status: "active",
          stage: "raw_extract",
          priority: 0.5,
          title: "m",
        });
        const concept = repos.concepts.createConcept({ name: "C" });
        for (let i = 0; i < dupCount; i++) {
          repos.elements.addRelation({
            fromElementId: ex.id,
            toElementId: concept.id,
            relationType: "concept_membership",
          });
        }
        // Despite dupCount edges, the member counts once.
        expect(library.browse().counts.byConcept[concept.id]).toBe(1);
        expect(library.browse({ conceptId: concept.id }).items.length).toBe(1);
      }),
      { ...FC, numRuns: 30 },
    );
  });

  it("INVARIANT: ordering is priority desc then updatedAt desc, and the limit cap holds", () => {
    fc.assert(
      fc.property(worldArb, fc.integer({ min: 1, max: 20 }), (world, limit) => {
        const { filters } = buildWorld(world);
        const { items, counts } = library.browse({ ...filters, limit });
        expect(items.length).toBeLessThanOrEqual(limit);
        // The top-line total always equals the RENDERED rows (post-limit), so the
        // "N elements" label can never exceed the visible list — even with a tiny cap
        // that truncates a larger match set. The per-facet counts stay pre-limit.
        expect(counts.all).toBe(items.length);
        expect(counts.all).toBeLessThanOrEqual(limit);
        for (let i = 1; i < items.length; i++) {
          const prev = items[i - 1];
          const cur = items[i];
          if (!prev || !cur) continue;
          if (prev.priority !== cur.priority) {
            expect(prev.priority).toBeGreaterThan(cur.priority);
          } else {
            const pu = prev.updatedAt ? Date.parse(prev.updatedAt) : 0;
            const cu = cur.updatedAt ? Date.parse(cur.updatedAt) : 0;
            expect(pu).toBeGreaterThanOrEqual(cu);
          }
        }
      }),
      FC,
    );
  });

  it("INVARIANT: sum of byType over the universe (no other filters) equals all", () => {
    fc.assert(
      fc.property(worldArb, (world) => {
        buildWorld(world);
        // With NO active filters, byType partitions the whole universe.
        const { counts } = library.browse();
        const sum = LIBRARY_TYPES.reduce((acc, t) => acc + (counts.byType[t] ?? 0), 0);
        expect(sum).toBe(counts.all);
      }),
      FC,
    );
  });

  it("INVARIANT: byConcept[c] under no other filters equals that concept's full live member count", () => {
    fc.assert(
      fc.property(worldArb, (world) => {
        const { liveConceptIds } = buildWorld(world);
        const counts = library.browse().counts;
        for (const conceptId of liveConceptIds) {
          // The drill-down byConcept (no other filter) must equal the canonical
          // substrate member resolver — the Map-tab volume and the chip agree here.
          expect(counts.byConcept[conceptId] ?? 0).toBe(
            repos.concepts.elementsForConcept(conceptId).length,
          );
        }
      }),
      FC,
    );
  });
});

describe("LibraryQuery drill-down counts — screenshot regression", () => {
  it("Attention concept: 3 extracts + 1 card; TYPE=Extracts => byConcept===3 matches the 3 extract rows", () => {
    const concept = repos.concepts.createConcept({ name: "Attention" });
    const extractIds: ElementId[] = [];
    for (let i = 0; i < 3; i++) {
      const ex = repos.elements.create({
        type: "extract",
        status: "active",
        stage: "raw_extract",
        priority: PRIORITY_LABEL_VALUE.B,
        title: `Attention extract ${i}`,
      });
      extractIds.push(ex.id);
      repos.concepts.assignConcept(ex.id, concept.id);
    }
    const card = repos.elements.create({
      type: "card",
      status: "active",
      stage: "active_card",
      priority: PRIORITY_LABEL_VALUE.B,
      title: "Attention card",
    });
    repos.concepts.assignConcept(card.id, concept.id);

    // No type filter: the chip shows the full 4 members (the Map volume).
    expect(library.browse().counts.byConcept[concept.id]).toBe(4);

    // TYPE=Extracts: the chip must show 3 and the list must show exactly 3 extracts.
    const withType = library.browse({ types: ["extract"] });
    expect(withType.counts.byConcept[concept.id]).toBe(3);
    expect(withType.items.filter((e) => e.type === "extract").length).toBe(3);

    // Selecting the concept WITH the type filter yields exactly those 3 rows.
    const both = library.browse({ types: ["extract"], conceptId: concept.id });
    expect(both.items.length).toBe(3);
    expect(new Set(both.items.map((e) => e.id))).toEqual(new Set(extractIds));
  });

  it("a concept with members but 0 extracts shows byConcept===0 under TYPE=Extracts (no surprise-empty)", () => {
    const concept = repos.concepts.createConcept({ name: "OnlyCards" });
    const card = repos.elements.create({
      type: "card",
      status: "active",
      stage: "active_card",
      priority: PRIORITY_LABEL_VALUE.B,
      title: "card",
    });
    repos.concepts.assignConcept(card.id, concept.id);

    // Map volume is 1, but the extract-scoped chip is 0 and the list is empty.
    expect(library.browse().counts.byConcept[concept.id]).toBe(1);
    const withType = library.browse({ types: ["extract"] });
    expect(withType.counts.byConcept[concept.id] ?? 0).toBe(0);
    expect(library.browse({ types: ["extract"], conceptId: concept.id }).items.length).toBe(0);
  });

  it("priority-band sanity: the materialized bands map back to A/B/C/D", () => {
    expect(PRIORITY_LABELS.map((l) => priorityToLabel(PRIORITY_BY_LABEL[l]))).toEqual([
      "A",
      "B",
      "C",
      "D",
    ]);
  });
});
