/**
 * Property-based / fuzzy tests for the concept-membership SUBSTRATE
 * (`ConceptRepository` + `ElementRepository` relations/soft-delete).
 *
 * The Library "drill-down faceted counts" fix (and queue/search concept filtering)
 * all stand on ONE shared substrate: who is a LIVE member of a concept, counted
 * the SAME way everywhere, with duplicate edges deduped and soft-deleted endpoints
 * (member OR concept) excluded. A single wrong edge here silently corrupts every
 * count downstream — so this file fuzzes the substrate hard rather than relying on
 * a handful of example worlds.
 *
 * Strategy: generate a random WORLD (varied elements + concepts, some soft-deleted;
 * random membership edges including DUPLICATES and edges to/from soft-deleted
 * endpoints), build an independent ORACLE of the expected live membership directly
 * from the generated edges, and assert the repository agrees with the oracle as a
 * property over many cases. fast-check pins a fixed seed by default, so the runs
 * are deterministic/reproducible in CI; we also pin `seed`/`numRuns` explicitly.
 */

import type { ElementId } from "@interleave/core";
import { ELEMENT_STATUSES, ELEMENT_TYPES, priorityToLabel } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConceptRepository } from "./concept-repository";
import { ElementRepository } from "./element-repository";
import { createInMemoryDb } from "./test-db";

// Deterministic fast-check config — fixed seed so a failure is reproducible in CI.
const FC = { seed: 0x5eed_1234, numRuns: 200, verbose: false } as const;

// Each fast-check RUN must get an isolated database: a property's predicate runs
// many times within one `it`, so a shared `beforeEach` DB would leak state from
// the previous run into the next (and the per-run oracle only knows the current
// world). `buildWorld` opens a fresh in-memory DB per run and the open handle is
// closed before the next run, so every run is hermetic.
let handle: DbHandle | null = null;
let concepts!: ConceptRepository;
let elementsRepo!: ElementRepository;

function freshDb(): void {
  if (handle) handle.sqlite.close();
  handle = createInMemoryDb();
  concepts = new ConceptRepository(handle.db);
  elementsRepo = new ElementRepository(handle.db);
}

beforeEach(freshDb);

afterEach(() => {
  if (handle) handle.sqlite.close();
  handle = null;
});

/** The browsable (non-concept) element types we attach memberships to. */
const MEMBER_TYPES = ELEMENT_TYPES.filter((t) => t !== "concept");
const LIVE_STATUSES = ELEMENT_STATUSES.filter((s) => s !== "deleted");

/** A generated non-concept element spec. */
interface ElementSpec {
  readonly key: number; // stable handle within a single generated world
  readonly type: (typeof MEMBER_TYPES)[number];
  readonly status: (typeof LIVE_STATUSES)[number];
  readonly priorityBucket: number; // 0..3 -> A/B/C/D-ish bands
  readonly deleted: boolean;
}

/** A generated concept spec. */
interface ConceptSpec {
  readonly key: number;
  readonly deleted: boolean;
}

/** A generated membership edge, referencing element/concept by generated index. */
interface EdgeSpec {
  readonly memberIdx: number; // index into elements[]
  readonly conceptIdx: number; // index into concepts[]
  readonly dup: number; // how many extra duplicate edges to also create (0..2)
}

interface WorldSpec {
  readonly elements: readonly ElementSpec[];
  readonly concepts: readonly ConceptSpec[];
  readonly edges: readonly EdgeSpec[];
}

const PRIORITY_BUCKETS = [0.85, 0.55, 0.3, 0.1]; // A, B, C, D bands

const elementSpecArb: fc.Arbitrary<Omit<ElementSpec, "key">> = fc.record({
  type: fc.constantFrom(...MEMBER_TYPES),
  status: fc.constantFrom(...LIVE_STATUSES),
  priorityBucket: fc.integer({ min: 0, max: 3 }),
  deleted: fc.boolean(),
});

const conceptSpecArb: fc.Arbitrary<Omit<ConceptSpec, "key">> = fc.record({
  deleted: fc.boolean(),
});

/** Build a world arbitrary with at least one element + one concept. */
const worldArb: fc.Arbitrary<WorldSpec> = fc
  .record({
    elements: fc.array(elementSpecArb, { minLength: 1, maxLength: 12 }),
    concepts: fc.array(conceptSpecArb, { minLength: 1, maxLength: 6 }),
  })
  .chain(({ elements, concepts }) => {
    const edgeArb: fc.Arbitrary<EdgeSpec> = fc.record({
      memberIdx: fc.integer({ min: 0, max: elements.length - 1 }),
      conceptIdx: fc.integer({ min: 0, max: concepts.length - 1 }),
      dup: fc.integer({ min: 0, max: 2 }),
    });
    return fc.record({
      elements: fc.constant(elements.map((e, key) => ({ ...e, key }))),
      concepts: fc.constant(concepts.map((c, key) => ({ ...c, key }))),
      edges: fc.array(edgeArb, { minLength: 0, maxLength: 24 }),
    });
  });

/** An element/concept spec paired with the DB id it was materialized as. */
interface MaterializedElement {
  readonly spec: ElementSpec;
  readonly id: ElementId;
}
interface MaterializedConcept {
  readonly spec: ConceptSpec;
  readonly id: ElementId;
}

/** Materialize a generated world into a FRESH DB. Returns id maps + the live oracle. */
function buildWorld(world: WorldSpec) {
  freshDb(); // hermetic per fast-check run

  // Pair each spec with the id it was created as, so downstream code never does raw
  // index access (the repo enables `noUncheckedIndexedAccess`).
  const els: MaterializedElement[] = world.elements.map((spec) => ({
    spec,
    id: elementsRepo.create({
      type: spec.type,
      status: spec.status,
      stage: "raw_extract",
      priority: PRIORITY_BUCKETS[spec.priorityBucket] ?? 0.5,
      title: `el-${spec.key}`,
    }).id,
  }));
  const cons: MaterializedConcept[] = world.concepts.map((spec) => ({
    spec,
    id: concepts.createConcept({ name: `concept-${spec.key}` }).id,
  }));

  const pickEl = (idx: number): MaterializedElement | undefined => els[idx];
  const pickCon = (idx: number): MaterializedConcept | undefined => cons[idx];

  // Membership edges, with duplicates created DIRECTLY via addRelation (NOT
  // assignConcept, whose idempotency would dedup) so we genuinely exercise the
  // substrate's own dedup. assignConcept is exercised separately below.
  for (const edge of world.edges) {
    const member = pickEl(edge.memberIdx);
    const concept = pickCon(edge.conceptIdx);
    if (!member || !concept) continue;
    const copies = 1 + edge.dup;
    for (let i = 0; i < copies; i++) {
      elementsRepo.addRelation({
        fromElementId: member.id,
        toElementId: concept.id,
        relationType: "concept_membership",
      });
    }
  }

  // Soft-delete the flagged endpoints AFTER wiring edges (edges to dead endpoints).
  for (const e of els) if (e.spec.deleted) elementsRepo.softDelete(e.id);
  for (const c of cons) if (c.spec.deleted) elementsRepo.softDelete(c.id);

  // ORACLE: expected live members per concept id, built independently from the
  // generated spec — a member counts iff BOTH it and the concept are live, and
  // each (member, concept) pair counts exactly once regardless of duplicates.
  const expectedMembersByConcept = new Map<ElementId, Set<ElementId>>();
  const expectedConceptsByMember = new Map<ElementId, Set<ElementId>>();
  for (const edge of world.edges) {
    const member = pickEl(edge.memberIdx);
    const concept = pickCon(edge.conceptIdx);
    if (!member || !concept || member.spec.deleted || concept.spec.deleted) continue;
    if (!expectedMembersByConcept.has(concept.id)) {
      expectedMembersByConcept.set(concept.id, new Set());
    }
    expectedMembersByConcept.get(concept.id)?.add(member.id);
    if (!expectedConceptsByMember.has(member.id)) {
      expectedConceptsByMember.set(member.id, new Set());
    }
    expectedConceptsByMember.get(member.id)?.add(concept.id);
  }

  return {
    els,
    cons,
    elementIds: els.map((e) => e.id),
    conceptIds: cons.map((c) => c.id),
    expectedMembersByConcept,
    expectedConceptsByMember,
    liveConceptIds: cons.filter((c) => !c.spec.deleted).map((c) => c.id),
    deletedConceptIds: cons.filter((c) => c.spec.deleted).map((c) => c.id),
    deletedElementIds: new Set(els.filter((e) => e.spec.deleted).map((e) => e.id)),
    deletedConceptIdSet: new Set(cons.filter((c) => c.spec.deleted).map((c) => c.id)),
  };
}

describe("concept membership substrate — property invariants", () => {
  it("liveMembershipMap matches the independent oracle (dedup + both-endpoint liveness)", () => {
    fc.assert(
      fc.property(worldArb, (world) => {
        const { elementIds, expectedConceptsByMember } = buildWorld(world);
        const map = concepts.liveMembershipMap();

        // (1) The map keys are EXACTLY the live members that have >=1 live edge.
        const expectedMemberKeys = new Set(
          [...expectedConceptsByMember.entries()].filter(([, set]) => set.size > 0).map(([m]) => m),
        );
        expect(new Set(map.keys())).toEqual(expectedMemberKeys);

        // (2) For each live member, the concept set matches the oracle exactly.
        for (const memberId of elementIds) {
          const got = map.get(memberId) ?? new Set<ElementId>();
          const want = expectedConceptsByMember.get(memberId) ?? new Set<ElementId>();
          expect(got).toEqual(want);
        }
      }),
      FC,
    );
  });

  it("elementsForConcept === oracle members (live, deduped) for live concepts; [] for soft-deleted concepts", () => {
    fc.assert(
      fc.property(worldArb, (world) => {
        const { conceptIds, expectedMembersByConcept, deletedConceptIds } = buildWorld(world);

        for (const conceptId of conceptIds) {
          const got = concepts.elementsForConcept(conceptId);
          // No duplicates ever.
          expect(new Set(got).size).toBe(got.length);

          if (deletedConceptIds.includes(conceptId)) {
            // A soft-deleted concept is not a live endpoint -> no members.
            expect(got).toEqual([]);
          } else {
            const want = expectedMembersByConcept.get(conceptId) ?? new Set<ElementId>();
            expect(new Set(got)).toEqual(want);
          }
        }
      }),
      FC,
    );
  });

  it("listConcepts().memberCount equals elementsForConcept length AND the map inversion (one source of truth)", () => {
    fc.assert(
      fc.property(worldArb, (world) => {
        const { liveConceptIds, deletedConceptIds } = buildWorld(world);
        const nodes = concepts.listConcepts();
        const byId = new Map(nodes.map((n) => [n.id, n]));

        // Soft-deleted concepts never appear in listConcepts.
        for (const dead of deletedConceptIds) expect(byId.has(dead)).toBe(false);

        // memberCount agrees with the canonical member resolver for every live concept.
        for (const conceptId of liveConceptIds) {
          const node = byId.get(conceptId);
          expect(node).toBeDefined();
          expect(node?.memberCount).toBe(concepts.elementsForConcept(conceptId).length);
        }

        // And the inversion of liveMembershipMap reproduces the same per-concept counts.
        const fromMap = new Map<ElementId, number>();
        for (const set of concepts.liveMembershipMap().values()) {
          for (const cid of set) fromMap.set(cid, (fromMap.get(cid) ?? 0) + 1);
        }
        for (const node of nodes) {
          expect(node.memberCount).toBe(fromMap.get(node.id) ?? 0);
        }
      }),
      FC,
    );
  });

  it("soft-deleted members and concepts NEVER appear in any membership read", () => {
    fc.assert(
      fc.property(worldArb, (world) => {
        const { els, conceptIds, deletedElementIds, deletedConceptIdSet } = buildWorld(world);

        // No soft-deleted member ever surfaces as a member of any concept.
        for (const conceptId of conceptIds) {
          for (const memberId of concepts.elementsForConcept(conceptId)) {
            expect(deletedElementIds.has(memberId)).toBe(false);
          }
        }

        // The map never references a soft-deleted member key or a soft-deleted concept value.
        for (const [memberId, set] of concepts.liveMembershipMap()) {
          expect(deletedElementIds.has(memberId)).toBe(false);
          for (const conceptId of set) expect(deletedConceptIdSet.has(conceptId)).toBe(false);
        }

        // firstConceptName (the shared per-row membership walk) NEVER names a
        // soft-deleted concept: if it returns a name, that name belongs to a LIVE
        // concept. Concept `key` is materialized with name `concept-${key}`.
        const liveConceptNames = new Set(
          world.concepts.filter((c) => !c.deleted).map((c) => `concept-${c.key}`),
        );
        for (const e of els) {
          if (e.spec.deleted) continue;
          const name = concepts.firstConceptName(e.id);
          if (name !== null) expect(liveConceptNames.has(name)).toBe(true);
        }
      }),
      FC,
    );
  });

  it("duplicate edges never inflate a count (addRelation duplicates collapse to one)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 8 }), // number of duplicate edges for one pair
        (dupCount) => {
          freshDb(); // hermetic per run (predicate runs many times within one `it`)
          const member = elementsRepo.create({
            type: "extract",
            status: "active",
            stage: "raw_extract",
            priority: 0.5,
            title: "m",
          });
          const concept = concepts.createConcept({ name: "C" });
          for (let i = 0; i < dupCount; i++) {
            elementsRepo.addRelation({
              fromElementId: member.id,
              toElementId: concept.id,
              relationType: "concept_membership",
            });
          }
          expect(concepts.elementsForConcept(concept.id)).toEqual([member.id]);
          expect(concepts.listConcepts().find((c) => c.id === concept.id)?.memberCount).toBe(1);
          expect(concepts.liveMembershipMap().get(member.id)?.size).toBe(1);
        },
      ),
      { ...FC, numRuns: 30 },
    );
  });

  it("conceptsForElement equals the oracle's live concept set per member (dedup + live concept endpoint)", () => {
    fc.assert(
      fc.property(worldArb, (world) => {
        const { els, expectedConceptsByMember } = buildWorld(world);

        for (const e of els) {
          const got = concepts.conceptsForElement(e.id);
          // Never duplicates (one summary per concept, even with duplicate edges).
          expect(new Set(got.map((c) => c.id)).size).toBe(got.length);

          if (e.spec.deleted) {
            // A soft-deleted member's outgoing edges still exist; conceptsForElement
            // reads from the member, so it may still resolve its (live) concepts — the
            // member-liveness is the caller's concern. What MUST hold: it never names a
            // soft-deleted concept.
            for (const c of got) {
              const el = elementsRepo.findById(c.id);
              expect(el?.deletedAt ?? null).toBeNull();
            }
            continue;
          }

          // For a LIVE member, the resolved concept ids must equal the oracle's live
          // concept set exactly — soft-deleted concepts dropped, duplicates collapsed.
          const want = expectedConceptsByMember.get(e.id) ?? new Set<ElementId>();
          expect(new Set(got.map((c) => c.id))).toEqual(want);
        }
      }),
      FC,
    );
  });

  it("a member's drill-down membership equals the union over concepts (bidirectional consistency)", () => {
    fc.assert(
      fc.property(worldArb, (world) => {
        const { elementIds, conceptIds } = buildWorld(world);
        const map = concepts.liveMembershipMap();

        // For each concept, every listed member must list that concept back in the map,
        // and vice versa — the from/to directions must agree.
        for (const conceptId of conceptIds) {
          const members = concepts.elementsForConcept(conceptId);
          for (const memberId of members) {
            expect(map.get(memberId)?.has(conceptId)).toBe(true);
          }
        }
        for (const memberId of elementIds) {
          const cids = map.get(memberId) ?? new Set<ElementId>();
          for (const conceptId of cids) {
            expect(concepts.elementsForConcept(conceptId)).toContain(memberId);
          }
        }
      }),
      FC,
    );
  });
});

describe("concept membership substrate — targeted regression (screenshot scenario)", () => {
  /**
   * The exact reported world: a concept with 4 members = 3 extracts + 1 card.
   * The Library drill-down (component 2) layers the TYPE=Extracts facet on top of
   * the substrate; the substrate's contract is that the concept resolves to its 4
   * LIVE members, of which 3 are extracts — so a TYPE=Extracts intersection is 3.
   */
  it("concept with 3 extracts + 1 card resolves to all 4 live members; type intersection yields the 3 extracts", () => {
    const concept = concepts.createConcept({ name: "Attention" });
    const extractIds: ElementId[] = [];
    for (let i = 0; i < 3; i++) {
      const ex = elementsRepo.create({
        type: "extract",
        status: "active",
        stage: "raw_extract",
        priority: 0.5,
        title: `extract-${i}`,
      });
      extractIds.push(ex.id);
      concepts.assignConcept(ex.id, concept.id);
    }
    const card = elementsRepo.create({
      type: "card",
      status: "active",
      stage: "active_card",
      priority: 0.5,
      title: "card",
    });
    concepts.assignConcept(card.id, concept.id);

    const members = concepts.elementsForConcept(concept.id);
    expect(new Set(members)).toEqual(new Set([...extractIds, card.id]));
    expect(members.length).toBe(4);
    expect(concepts.listConcepts().find((c) => c.id === concept.id)?.memberCount).toBe(4);

    // The substrate's job: members + their types so a type facet can intersect.
    const extractsOfConcept = members.filter((id) => elementsRepo.findById(id)?.type === "extract");
    expect(extractsOfConcept.length).toBe(3);
    expect(new Set(extractsOfConcept)).toEqual(new Set(extractIds));
  });

  it("a concept whose only members are non-extracts resolves to 0 extracts (no surprise-empty list)", () => {
    const concept = concepts.createConcept({ name: "OnlyCards" });
    const card = elementsRepo.create({
      type: "card",
      status: "active",
      stage: "active_card",
      priority: 0.5,
      title: "card",
    });
    concepts.assignConcept(card.id, concept.id);

    const members = concepts.elementsForConcept(concept.id);
    expect(members).toEqual([card.id]);
    const extractsOfConcept = members.filter((id) => elementsRepo.findById(id)?.type === "extract");
    expect(extractsOfConcept.length).toBe(0);
    // The global member count is still 1 (Map tab volume), but the extract-scoped
    // intersection is 0 — which is exactly what the drill-down byConcept count must
    // surface so selecting it is never a surprise-empty list.
    expect(concepts.listConcepts().find((c) => c.id === concept.id)?.memberCount).toBe(1);
  });

  it("a deleted member drops the count from 4 to 3 (live-endpoint rule)", () => {
    const concept = concepts.createConcept({ name: "Attention" });
    let firstId: ElementId | null = null;
    for (let i = 0; i < 4; i++) {
      const ex = elementsRepo.create({
        type: "extract",
        status: "active",
        stage: "raw_extract",
        priority: 0.5,
        title: `e${i}`,
      });
      if (i === 0) firstId = ex.id;
      concepts.assignConcept(ex.id, concept.id);
    }
    if (!firstId) throw new Error("expected a first extract id");
    expect(concepts.elementsForConcept(concept.id).length).toBe(4);
    elementsRepo.softDelete(firstId);
    expect(concepts.elementsForConcept(concept.id).length).toBe(3);
    expect(concepts.listConcepts().find((c) => c.id === concept.id)?.memberCount).toBe(3);
    expect(concepts.liveMembershipMap().get(firstId)).toBeUndefined();
  });

  it("firstConceptName skips a soft-deleted concept earlier in the edge list and returns the live one", () => {
    const dead = concepts.createConcept({ name: "Dead" });
    const live = concepts.createConcept({ name: "Live" });
    const ex = elementsRepo.create({
      type: "extract",
      status: "active",
      stage: "raw_extract",
      priority: 0.5,
      title: "e",
    });
    // First-added edge points to the concept we will soft-delete; second to a live one.
    concepts.assignConcept(ex.id, dead.id);
    concepts.assignConcept(ex.id, live.id);
    elementsRepo.softDelete(dead.id);

    // The dead concept must NOT mask the live one (consistent with the membership map).
    expect(concepts.firstConceptName(ex.id)).toBe("Live");
    expect(concepts.liveMembershipMap().get(ex.id)).toEqual(new Set([live.id]));
  });

  it("firstConceptName returns null when every membership concept is soft-deleted", () => {
    const dead = concepts.createConcept({ name: "Dead" });
    const ex = elementsRepo.create({
      type: "extract",
      status: "active",
      stage: "raw_extract",
      priority: 0.5,
      title: "e",
    });
    concepts.assignConcept(ex.id, dead.id);
    elementsRepo.softDelete(dead.id);
    expect(concepts.firstConceptName(ex.id)).toBeNull();
  });

  it("priorityToLabel banding used by the world generator stays a sanity check on the buckets", () => {
    // Guards against the buckets silently collapsing into one band (which would
    // make priority-facet fuzzing vacuous downstream).
    expect(PRIORITY_BUCKETS.map(priorityToLabel)).toEqual(["A", "B", "C", "D"]);
  });
});
