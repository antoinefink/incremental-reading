# M8 — Organize: concepts, tags, search & references (T041–T043)

Detailed, buildable specs for the eighth milestone. M8 makes a growing collection
**findable and organized**. Three capabilities land:

- **T041 — Concepts & tags:** hierarchical **concepts** (a `concept`-type element + a
  `concepts` side-table hierarchy row) and flat **tags** (`tags` + `element_tags`) can be
  created and assigned, and elements can be **filtered** by concept and by tag — wiring the
  `concept` filter that the M5 queue already left as a deferred hook.
- **T042 — Search:** **local full-text search** via SQLite **FTS5** — `source_fts` /
  `extract_fts` / `card_fts` virtual tables + sync triggers added in a **Drizzle/SQL
  migration**, a `SearchRepository.query` over source title/body + extract body + card
  prompt/answer + tags with simple ranking, exposed through a new `search.*`
  `window.appApi` surface to the `/search` library screen.
- **T043 — Source/reference display:** every **extract** and **card** shows its source
  title / URL / author / date / location (the `refblock`), **review keeps it hidden until
  answer reveal**, and nothing feels orphaned — reusing the existing lineage +
  `source_locations` data, no new lineage model.

After M8 the knowledge loop built in M1–M7 (**read → extract → distill → card → review →
reschedule**) becomes **navigable**: a user can organize by concept/tag, find any element
across the collection by keyword, and always trace a card or extract back to where it came
from. M9 (trash/undo, analytics, backup) then makes it safe.

The architecture is unchanged and non-negotiable (see [`../../CLAUDE.md`](../../CLAUDE.md)
and the roadmap header): the React **renderer** (`apps/web`) never touches SQLite, Node, or
the filesystem. Every read/mutation flows React UI → typed client wrapper
(`apps/web/src/lib/appApi.ts`) → preload bridge (`apps/desktop/src/preload/index.ts`) →
validated IPC (Zod) on the main side (`apps/desktop/src/main/ipc.ts`) → the `DbService`
(`apps/desktop/src/main/db-service.ts`) → `packages/local-db` repositories → SQLite. Every
meaningful **mutation** runs in **one transaction** and appends an **`operation_log`** row;
deletes are soft (`deleted_at`). **Search/index logic and tag/concept membership resolution
live in the DB/repository layer, never in React.**

> **Operation-log discipline (load-bearing).** `OPERATION_TYPES`
> (`packages/core/src/operation-log.ts`) is a **closed, fixed set of 15** — "a rename is a
> migration." M8 maps onto the existing ops, **no new op types**:
> - creating a concept → `create_element` (a `concept`-type element; the `concepts`
>   side-table row is written in the same transaction, like the seed factory's
>   `createConcept`);
> - assigning/removing concept membership → `add_relation` / `remove_relation` (the
>   `concept_membership` edge in `element_relations`);
> - assigning/removing a tag → `add_tag` / `remove_tag` (already implemented on
>   `ElementRepository.addTag`/`removeTag`).
>
> Do **not** invent `create_concept` / `add_concept` / `tag` ops. T042 (search) is **read-only**
> — building/maintaining the FTS index happens via SQL triggers inside the write transactions
> that already log their op; the index is **not** itself an op-logged mutation. T043 is almost
> entirely **read/derived** display; the only mutations it might add reuse `add_relation`/
> `update_element` (and are mostly out of scope — see its Notes).

### What already exists (inspect before building — do not duplicate)

The M1 substrate built most of M8's persistence seam; M8 is mostly **wiring + one FTS
migration + UI**.

- **Schema (T006):**
  - `concepts` (`packages/db/src/schema/organize.ts`): `id`, `parentConceptId`
    (self-FK, `on delete set null`, `concepts_parent_idx`), `name`. **Hierarchical.**
  - `tags` (`organize.ts`): `id`, `name` (`tags_name_unique`). **Flat.**
  - `element_tags` (`organize.ts`): composite PK `(elementId, tagId)`, cascade delete,
    `element_tags_tag_idx`. The many-to-many join.
  - `element_relations` (`packages/db/src/schema/relations.ts`): `relationType` CHECKed
    against `RELATION_TYPES` (`packages/core/src/enums.ts`) which **already includes
    `concept_membership`**. Concept membership of an element is a `concept_membership`
    edge here (`from = element`, `to = concept` — confirm direction against the seed
    factory before building; the factory records `addRelation({ from: extract, to: childConcept,
    relationType: "concept_membership" })`).
  - **No `source_fts` / `extract_fts` / `card_fts` tables exist** — confirmed: no FTS DDL
    anywhere in `packages/db/src/schema`, `packages/db/drizzle/*.sql`, or `packages/local-db`
    (the only matches are the "FTS arrives with search later" comments). The latest migration
    is `packages/db/drizzle/0001_clever_rictor.sql`. **T042 adds `0002_*` with the FTS5
    virtual tables + triggers.**
- **`@interleave/core` (T005):** `RELATION_TYPES` (incl. `concept_membership`),
  `OPERATION_TYPES` (the closed 15), `ElementType` (incl. `concept`), `Priority`/A-B-C-D.
- **`packages/local-db` (T008):**
  - `ElementRepository` (`packages/local-db/src/element-repository.ts`) **already
    implements tags**: `addTag(elementId, tagName)` / `addTagWithin(tx, …)` (creates the tag
    on demand, idempotent join insert, logs `add_tag`), `removeTag` (logs `remove_tag`),
    `listTags(elementId)`. It also has `addRelation`/`addRelationWithin`/`removeRelation`/
    `listRelationsFrom` (the `concept_membership` edge seam, logs `add_relation`/
    `remove_relation`). **There is no `ConceptRepository` and no concept create/list method
    yet** — T041 adds one (or extends `ElementRepository`).
  - `SearchRepository` (`packages/local-db/src/search-repository.ts`) is the **M1
    placeholder**: a correct-but-unranked `LIKE '%q%'` substring scan over `elements.title`
    + `documents.plainText`, plus `byTitle` for the command palette. Its doc comment states
    it "keeps the same method surface but swaps the implementation" when FTS5 lands —
    **T042 reimplements `query` over FTS5 with ranking; keep the method shape.**
  - `OperationLogRepository.append` (the `tx`-composable seam), `newRowId`/`nowIso`
    (`packages/local-db/src/ids.ts`), the `rowToElement` mapper (`mappers.ts`).
- **`packages/testing` (T009):** `DEMO_FIXTURES` + factories
  (`packages/testing/src/factories.ts`) already seed a **parent→child concept hierarchy**
  ("Cognition" → "Intelligence") as `concept` elements + `concepts` rows, a
  `concept_membership` edge on the extract, and `tags` on the extract — built **through the
  repositories** (`createConcept` writes the element via `createElement` + the `concepts`
  row, membership via `addRelation`, tags via `addTag`). `factories.test.ts` already asserts
  this shape ("creates hierarchical concepts with membership edges and tags"). T041/T042/T043
  build on this seed; extend it only as noted.
- **Contract / `window.appApi` (M1–M7):** the contract
  (`apps/desktop/src/shared/contract.ts` + `channels.ts`), preload
  (`apps/desktop/src/preload/index.ts`), IPC router (`apps/desktop/src/main/ipc.ts`),
  `DbService` (`apps/desktop/src/main/db-service.ts`), and renderer client
  (`apps/web/src/lib/appApi.ts`) currently expose `app`/`db`/`settings`/`inspector`/
  `elements`/`queue`/`lineage`/`sources`/`inbox`/`documents`/`extractions`/`cards`/
  `extracts`/`review`/`readPoint`. **There is no `search`/`tags`/`concepts` group yet.**
  - The **inspector already surfaces tags + source provenance**: `InspectorGetResult`
    (`contract.ts`) carries `tags: readonly string[]`, `provenance: SourceProvenance | null`
    (`url`/`canonicalUrl`/`originalUrl`/`author`/`publishedAt`/`accessedAt`), and `location`,
    rendered in `apps/web/src/components/inspector/Inspector.tsx` (which already imports the
    `Tag` primitive from `primitives.tsx`).
  - The **queue read already has a deferred `concept` filter hook**: `QueueListRequest`
    accepts `concept?: string` and each queue row carries `concept: string | null`
    (`contract.ts` notes "T041 populates this; null until then"). **T041 makes that filter
    real** rather than adding a new one.
  - The **review card view already carries a refblock**: `ReviewCardView`
    (`contract.ts`) has `sourceTitle`, `sourceLocationLabel`, and `ref` (the verbatim
    `source_locations.selectedText`), and `ReviewScreen.tsx`/`ReviewRepairBar.tsx`
    **already hide `answer` + `ref` until reveal** and render the `refblock`. **T043 enriches
    the refblock (URL/author/date) and extends the same pattern to extracts** — it does not
    invent a reveal mechanism.
- **Renderer routes (T003):** `/search` exists but renders a `Placeholder`
  (`apps/web/src/router.tsx` `searchRoute`, `icon="library"`, title "Library & Search").
  T042 replaces it with the real `LibraryScreen`.
- **Migrations run identically in dev + prod:** `packages/db/src/migrator.ts`
  (`migrateDatabase`) uses Drizzle's `better-sqlite3` migrator over
  `packages/db/drizzle/`; the desktop main process runs it on startup
  (`apps/desktop/src/main/db-service.ts` → `migrateDatabase(this.handle.db, …)`) and the dev
  scripts (`pnpm db:migrate` → `packages/db/scripts/migrate.ts`) run the same files.
  **A migration that adds FTS5 DDL applies on both paths automatically** — see T042 Notes for
  the hand-authored-SQL caveat.

### What M8 must add (the gaps)

- **A concept create/list/assign path** (T041): there is no `ConceptRepository`, no
  `concepts.*`/`tags.*` `window.appApi` surface, and no UI to create/assign concepts or tags.
- **The one schema migration of this milestone** (T042): `source_fts` / `extract_fts` /
  `card_fts` FTS5 virtual tables + sync triggers, hand-authored into a new Drizzle migration
  `packages/db/drizzle/0002_*.sql`.
- **A real ranked `SearchRepository.query`** over FTS5 (T042) + a `search.*` `window.appApi`
  surface + the `LibraryScreen` (`/search`) with `filterbar` + `result` list (and the
  read-only `concepts` Map tab).
- **Refblock enrichment + an extract refblock** (T043): the extract view + card review/
  builder + inspector show a consistent source reference (title/URL/author/date/location).

> **Dependency note (resolved).** Per the roadmap, **T041 deps T008**, **T042 deps T008**,
> **T043 deps T022 (source locations) + T032 (card model)** — all `[x]` (M1/M4/M6 complete).
> T041 and T042 are independent of each other and of T043; build order below is the task
> order, but T042 (search) and T043 (references) can proceed in parallel after T041's concept/
> tag write path exists (the library result rows in T042 reuse the per-row meta the same way
> T043 formats the refblock — share the formatter; see T043).

Read first:
- [`../domain-model.md`](../domain-model.md) — **"Relationships & lineage"** (concepts
  hierarchical via `concepts.parentConceptId`; tags flat via `tags`/`element_tags`; membership
  + lineage are explicit `element_relations` rows, **not** implicit nesting); the card lineage
  chain `card → extract → source location → source metadata → original document context`;
  FTS5 tables arrive with search.
- [`../../CLAUDE.md`](../../CLAUDE.md) — **"SQLite rules"** ("Local full-text search uses FTS5
  (`source_fts`, `extract_fts`, `card_fts`) when search lands"); **"Document/editor rules"**
  (extracts inherit source metadata + concept/tags); **"UX rules"** + **"Key screens"**
  (Library / Search / Knowledge Map; nothing orphaned).
- [`../design-system.md`](../design-system.md) — the `screen-library` row (the
  `filterbar`/`result` library + the `concepts` map tab → `/search`, library, concepts → M8);
  `ConceptTag` / `Tag` primitives; `refblock` (source reference); `graph`/`gnode` (concept
  map); `EmptyState`.
- Design kit (immutable reference): `design/kit/app/screen-library.jsx` (the `LibraryScreen`:
  the search `input`, the `Segmented` Results/Map tabs, the `filterbar` with type / concept /
  priority / status groups, the grouped `result` rows with `highlight()` of the query, the
  selection detail with `Prio`/`ConceptTag`/`SchedulerChip`/`refblock`, and the `ConceptGraph`
  `graph`/`gnode` map tab); `design/kit/app/components.jsx` (`ConceptTag`, `Tag`, `Segmented`,
  `EmptyState`, `Prio`, `Status`, `SchedulerChip`); the `refblock`/`refblock__src` pattern in
  `design/kit/app/screen-review.jsx`, `screen-reader.jsx`, and `screen-builder.jsx`; plus the
  screenshots `design/kit/screenshots/lib.png` and `map.png`.

Build order is the task order. T041 → {T042, T043} (the latter two are independent).

---

## T041 — Concepts & tags

- **Status:** `[ ]`  · **Depends on:** T008
- **Roadmap line:** Done when: concepts (hierarchical) and tags (flat) can be
  created/assigned; elements filter by concept and tags.

### Goal

A user can **create** concepts (a hierarchy — a parent concept with child concepts) and
flat **tags**, **assign** them to any element (a source, extract, or card) and unassign them,
and **filter** elements by concept and by tag — both in the queue (the existing deferred
`concept` filter becomes real) and in the library (T042). Concepts and tags are persisted in
SQLite, every assignment is a transactional op-logged mutation, and the inspector shows an
element's concepts + tags with controls to add/remove them. All of this reaches the renderer
**only** through new typed `concepts.*` / `tags.*` `window.appApi` commands — no SQL in React.

### Context to load first

- Reference: `domain-model.md` "Relationships & lineage" (concepts hierarchical, tags flat,
  membership = explicit `element_relations` rows); `CLAUDE.md` "Document/editor rules"
  (inherited concept/tags) + "UX rules".
- Existing code to inspect: `packages/db/src/schema/organize.ts` (`concepts`/`tags`/
  `element_tags`); `packages/db/src/schema/relations.ts` + `packages/core/src/enums.ts`
  (`concept_membership` in `RELATION_TYPES`); `packages/local-db/src/element-repository.ts`
  (`addTag`/`addTagWithin`/`removeTag`/`listTags`, `addRelation`/`addRelationWithin`/
  `removeRelation`/`listRelationsFrom` — **reuse these, don't re-implement**); the seed
  factory `packages/testing/src/factories.ts` (`createConcept` + the membership/tag wiring —
  the canonical creation pattern; mirror it in the repository); `apps/desktop/src/shared/`
  (`channels.ts` + `contract.ts`), `apps/desktop/src/preload/index.ts`,
  `apps/desktop/src/main/ipc.ts`, `apps/desktop/src/main/db-service.ts`,
  `apps/web/src/lib/appApi.ts` (the established surface pattern — follow `extracts.*` exactly);
  `apps/web/src/components/inspector/Inspector.tsx` + `primitives.tsx` (already imports `Tag`;
  add `ConceptTag`); the queue: `QueueListRequest.concept` + `QueueRow.concept`
  (`contract.ts`) and the queue read in `db-service.ts` / `packages/local-db`
  (`queue-query.ts` / `queue-repository.ts`) where `concept` filtering is currently
  `DEFERRED`.
- Invariants in play: concepts are dual-modeled — a **`concept`-type element** (so it has an
  id/status/priority and logs `create_element`) **plus** a `concepts` side-table row
  (`name`, `parentConceptId`) written in the **same transaction**; membership is a
  `concept_membership` `element_relations` edge (logs `add_relation`/`remove_relation`); tags
  reuse the existing `add_tag`/`remove_tag` ops. **No new op types.** Re-tagging /
  re-assigning is idempotent.

### Deliverables

- [ ] **A `ConceptRepository`** in `packages/local-db/src/concept-repository.ts` (export from
      `packages/local-db/src/index.ts`), or — if simpler and consistent — concept methods on
      `ElementRepository`. It must, **all transactional + op-logged**:
      - `createConcept({ name, parentConceptId? }): Concept` — create the `concept`-type
        element (via the existing `ElementRepository.createWithin` / `createElement` path so
        `create_element` is logged) **and** insert the `concepts` row
        (`{ id, name, parentConceptId }`) in **one transaction**. Mirror the seed factory's
        `createConcept`. Validate `parentConceptId` exists (and reject self-parenting /
        obvious cycles — at minimum a one-level parent check; full cycle prevention can be a
        guarded insert).
      - `listConcepts(): ConceptNode[]` — all concepts as a hierarchy (id, name,
        `parentConceptId`, child count, and a cheap `memberCount` from
        `concept_membership` edges) for the filterbar + map.
      - `assignConcept(elementId, conceptId)` / `unassignConcept(elementId, conceptId)` —
        add/remove the `concept_membership` edge via `addRelationWithin`/`removeRelation`
        (logs `add_relation`/`remove_relation`); idempotent.
      - `conceptsForElement(elementId): Concept[]` and
        `elementsForConcept(conceptId): ElementId[]` — membership reads (the latter feeds
        concept filtering and counts).
      - `renameConcept` / `setParent` are **optional/deferred** (note them); MVP needs create
        + assign + list + filter.
- [ ] **A `tags.*` write/read path** — tags already exist on `ElementRepository`
      (`addTag`/`removeTag`/`listTags`); add a `listAllTags(): { name; count }[]` read (for the
      filterbar) on `ElementRepository` or a small `tag-query.ts`. Do **not** duplicate the tag
      mutation logic.
- [ ] **`concepts.*` + `tags.*` `window.appApi` surface** added across the full seam,
      Zod-validated, following the `extracts.*` pattern exactly:
      - channels (`apps/desktop/src/shared/channels.ts`): e.g. `conceptsCreate`
        (`concepts:create`), `conceptsList` (`concepts:list`), `conceptsAssign`
        (`concepts:assign`), `conceptsUnassign` (`concepts:unassign`); `tagsList`
        (`tags:list`), `tagsAdd` (`tags:add`), `tagsRemove` (`tags:remove`).
      - contract (`apps/desktop/src/shared/contract.ts`): request Zod schemas (bounded
        strings: name 1–256; ids) + result types (`ConceptNode`, `ConceptSummary`,
        `TagSummary { name; count }`, the updated element's `{ concepts, tags }`).
      - preload (`apps/desktop/src/preload/index.ts`): `concepts` + `tags` groups mirroring
        the methods.
      - IPC router (`apps/desktop/src/main/ipc.ts`): validated handlers.
      - `DbService` (`apps/desktop/src/main/db-service.ts`): methods composing
        `ConceptRepository` + `ElementRepository`.
      - renderer client (`apps/web/src/lib/appApi.ts`): the mirrored `concepts`/`tags`
        methods + types.
- [ ] **Make the queue `concept` filter real** (it is currently DEFERRED in `contract.ts` /
      the queue read): populate each `QueueRow.concept` from the element's
      `concept_membership` edge and **narrow on `QueueListRequest.concept`** in the queue read
      (`packages/local-db` `queue-query.ts` / `db-service.ts`). Also surface a tag narrowing
      if cheap (a `tag?` filter param), but the roadmap requires concept **and** tag filtering
      — at minimum wire concept here and tag in the library (T042 filterbar). Keep the
      filtering **in the repository/query layer**, not React.
- [ ] **Inspector UI** (`apps/web/src/components/inspector/Inspector.tsx` + `primitives.tsx`):
      render the element's **concepts** (as `ConceptTag` pills — add the primitive matching
      `design/kit/app/components.jsx` `ConceptTag` + the `concept-tag` CSS class) and **tags**
      (the existing `Tag` primitive) with **add/remove** controls (a small concept picker +
      tag input) that call the new `concepts.assign/unassign` + `tags.add/remove` commands.
      Keep it consistent with the inspector's `MetaRow`/`insp-sec` structure.
- [ ] **Seed/fixtures:** the seed already creates the concept hierarchy + membership + tags
      (`packages/testing/src/factories.ts`); confirm the new repository/commands round-trip
      the **same** seeded shape (don't re-seed differently). Add a second tag or a second
      membership only if a test needs it.
- [ ] **Tests (Vitest, `packages/local-db`):** `createConcept` writes both the element
      (`create_element`) and the `concepts` row in one transaction and rejects a bad parent;
      `assignConcept`/`unassignConcept` add/remove the `concept_membership` edge and log
      `add_relation`/`remove_relation` (idempotent); `conceptsForElement`/`elementsForConcept`
      resolve membership; **tag filtering**: an element tagged "x" is returned by a tag filter
      and not by a different tag; `listConcepts` returns the hierarchy with correct parent
      links + member counts. (Tag mutation tests already exist for `addTag`/`removeTag` from
      T008 — extend, don't duplicate.)
- [ ] **Tests (Vitest, `DbService` / contract):** the `concepts.*`/`tags.*` handlers validate
      payloads (reject empty/oversized names) and return the updated `{ concepts, tags }`;
      `concepts.create` with a parent builds the hierarchy.
- [ ] **Playwright E2E** (`tests/electron/concepts-tags.spec.ts`): on a seeded element, **add
      a tag** and **assign a concept** via the inspector → both appear → **filter the queue
      (or library) by that concept** and confirm the element is included and an unrelated one
      is excluded → **restart the Electron app** → the tag + membership persist.

### Done when

- Concepts (hierarchical) and tags (flat) can be **created** and **assigned/unassigned** to
  any element through the typed `concepts.*`/`tags.*` `window.appApi`; each assignment is one
  transaction + the correct **existing** op (`create_element` / `add_relation` /
  `remove_relation` / `add_tag` / `remove_tag`).
- Elements **filter by concept and by tag** (the queue's previously-deferred `concept` filter
  is real; tag filtering works in the queue and/or the library), with the filtering done in
  the repository/query layer.
- The inspector shows an element's concepts (`ConceptTag`) + tags (`Tag`) with add/remove
  controls; everything **survives app restart**.
- `pnpm typecheck`, `pnpm test`, `pnpm lint`, and the concepts/tags Playwright spec pass.

### Notes / risks

- **Concepts are dual-modeled.** A concept is a `concept`-type **element** (id/status/priority,
  `create_element`) **and** a `concepts` side-table row (`name`, `parentConceptId`). Write both
  in one transaction (mirror the seed factory's `createConcept`). The `concepts` table has no
  cascade from `elements` (it's a side table) — if a concept element is ever soft-deleted,
  decide whether the `concepts` row stays; for MVP concepts are not deletable from this task
  (note the deferral).
- **No new op types.** Concepts/tags reuse `create_element`/`add_relation`/`remove_relation`/
  `add_tag`/`remove_tag` — the seed factory already proves this maps cleanly. Do not add
  `create_concept`.
- **Confirm the `concept_membership` edge direction** against the seed factory
  (`from = member element`, `to = concept`) and keep it consistent in both the write
  (`assignConcept`) and the reads (`conceptsForElement` walks `listRelationsFrom`).
- **Inherited concepts/tags on extraction** (the kit's "extracts inherit source concept/tags")
  is partly handled in M4 (the extraction transaction copies source tags); do **not** rework
  extraction here — T041 only adds the create/assign/filter capability + UI.
- Concept **rename / re-parent / delete** and a rich concept-management screen are
  **deferred** (the map tab in T042 is read-only). Desired-retention-by-concept is **M16/T079**.

---

## T042 — Search

- **Status:** `[ ]`  · **Depends on:** T008
- **Roadmap line:** Done when: local full-text search over source title/body, extract body,
  card prompt/answer, and tags returns sources/extracts/cards quickly with simple ranking.

### Goal

`/search` becomes a real **local full-text search** matching
`design/kit/app/screen-library.jsx`: typing a query searches **source titles + bodies**,
**extract bodies**, **card prompts/answers**, and **tag names**, returning matching sources /
extracts / cards **quickly** with **simple ranking** (best matches first), grouped by type in
the `result` list, with the matched term highlighted. Search runs entirely **locally** over
SQLite **FTS5** virtual tables maintained by triggers; the index lives in the DB and the query
logic lives in `SearchRepository` — **never in React**.

### Context to load first

- Reference: `CLAUDE.md` "SQLite rules" ("Local full-text search uses FTS5 (`source_fts`,
  `extract_fts`, `card_fts`) when search lands"); `domain-model.md` (FTS tables arrive with
  search); the closed `OPERATION_TYPES` (search is read-only — no op).
- Existing code to inspect: `packages/local-db/src/search-repository.ts` (the M1 `LIKE`
  placeholder — **same method surface, swap the implementation**); `packages/db/src/schema/`
  (`elements`, `documents` (`plainText` mirror), `sources`, `cards`, `tags`, `element_tags`)
  — what the triggers must mirror into FTS; `packages/db/drizzle/0001_clever_rictor.sql` +
  `meta/_journal.json` (the latest migration — the new one is `0002`); `packages/db/
  src/migrator.ts` + `packages/db/drizzle.config.ts` (`drizzle-kit generate` / migrator
  paths); the seed factory (the demo source/extract/card to search for); the contract/preload/
  ipc/db-service/appApi seam; `apps/web/src/router.tsx` (`searchRoute` Placeholder to replace);
  `design/kit/app/screen-library.jsx` (the search input, `Segmented` tabs, `filterbar`,
  grouped `result` rows + `highlight()`, the selection detail, the `ConceptGraph` map);
  `design/kit/app/components.jsx` (`Segmented`, `EmptyState`, `ConceptTag`, `Prio`,
  `SchedulerChip`); `design/kit/screenshots/lib.png` + `map.png`.
- Invariants in play: FTS5 tables are **derived** (rebuildable) — they are not the source of
  truth; triggers keep them in sync with the base tables inside the same write transaction;
  search is read-only and excludes soft-deleted (`deleted_at IS NULL`) elements; the renderer
  never issues SQL — it calls `search.*`.

### Deliverables

- [ ] **FTS5 migration (the one schema change of this milestone)** — a new
      `packages/db/drizzle/0002_*.sql` (+ its `meta/0002_snapshot.json` + `_journal.json`
      entry). Because Drizzle's schema introspection does **not** model FTS5 virtual tables,
      this migration is **hand-authored SQL** (generate an empty migration via
      `pnpm db:generate` and fill it, or add the SQL file + journal entry manually — see Notes):
      - `CREATE VIRTUAL TABLE source_fts USING fts5(element_id UNINDEXED, title, body, tags, tokenize='unicode61 remove_diacritics 2');`
      - `CREATE VIRTUAL TABLE extract_fts USING fts5(element_id UNINDEXED, body, tags, tokenize='unicode61 remove_diacritics 2');`
      - `CREATE VIRTUAL TABLE card_fts USING fts5(element_id UNINDEXED, prompt, answer, tags, tokenize='unicode61 remove_diacritics 2');`
      - **Sync triggers** that keep each FTS table current as the base rows change:
        on `INSERT`/`UPDATE`/`DELETE` of `documents` (the body mirror) and `elements.title`
        for sources/extracts, `cards` for cards, and `element_tags` (to refresh the `tags`
        column). Use `INSERT INTO …_fts(…_fts) VALUES('delete', …)` then re-insert (the FTS5
        external-content / contentless update pattern) so updates don't duplicate rows. Keep
        the triggers narrow and correct; an alternative acceptable approach is **contentless
        FTS with explicit repository-side index writes** — pick one and document it (triggers
        preferred so the index can't drift from a missed code path).
      - A one-time **backfill** in the same migration: `INSERT INTO source_fts … SELECT … FROM
        elements JOIN documents …` (and equivalently for extracts/cards) so existing rows
        (the seed, any pre-existing DB) are searchable immediately after migrating.
- [ ] **Reimplement `SearchRepository.query`** (`packages/local-db/src/search-repository.ts`)
      over FTS5, **keeping the existing method shape** (`query(query, options)` +
      `byTitle(query, limit)`):
      - parse/sanitize the user query into a safe FTS5 `MATCH` expression (escape FTS
        operators; default to a prefix-AND of the terms, e.g. `intel* mem*`); never interpolate
        raw user input into SQL.
      - `UNION` the three FTS tables, join back to live `elements`
        (`WHERE deleted_at IS NULL`), and **rank** with FTS5 `bm25(…)` (weight title > body;
        weight prompt/answer for cards; tags a light boost) so the best matches sort first.
      - return a typed result list (element id/type/title + a short matched snippet — FTS5
        `snippet()` / `highlight()` is allowed, or return the field + let the renderer
        highlight) ordered by rank, deduped per element, with the `options.type` /
        `options.limit` narrowing the existing surface already supports. Keep `byTitle`
        (palette fast path) — it may stay `LIKE`-based or move to `title` FTS.
- [ ] **`search.*` `window.appApi` surface** (channels + contract + preload + ipc + db-service
      + renderer client), Zod-validated, following the `extracts.*` pattern:
      - `search.query({ q, type?, concept?, tag?, limit? }) → { results: SearchResult[] }`
        where `SearchResult = { id, type, title, snippet, priority, concept, sourceTitle,
        sourceLocationLabel, ref? , dueAt? }` (enough for the `result` row + the selection
        detail). Apply the **concept/tag filters from T041** in the query layer (compose the
        FTS match with the `concept_membership` / `element_tags` joins). `q.trim() === ""`
        returns `[]`.
      - (optional) `search.palette({ q, limit })` if the command palette wants a dedicated
        fast path; otherwise the palette keeps using `byTitle`.
- [ ] **`LibraryScreen`** in `apps/web` (e.g. `apps/web/src/library/LibraryScreen.tsx`)
      replacing the `/search` Placeholder in `apps/web/src/router.tsx`, rebuilt from
      `design/kit/app/screen-library.jsx` pixel-for-pixel (React 19 + Tailwind v4 +
      `lucide-react`):
      - the search `input` + the `Segmented` **Results / Map** tabs;
      - the `filterbar` (left): type groups, the **concept** list (from `concepts.list`,
        T041), priority A/B/C/D, and the "smart" status rows — clicking narrows the query
        (wire **type + concept + tag + priority**; the kit's "Stale facts / low-yield / leech"
        smart filters can be **stubbed/deferred** to M9/M17 — note it);
      - the grouped `result` rows (`result`/`result--on`) with the query **highlighted**
        (`highlight()`), each showing type icon + title + a `result__meta` line (the per-row
        source/meta — **reuse the T043 refblock/ref formatter** so the library row and the
        inspector/review refblock agree);
      - the selection detail panel (`Prio`, `ConceptTag`, `SchedulerChip`, `Status`, and the
        `refblock` quote — `sel.text`/`sel.front` in the kit), with open-in-context;
      - an `EmptyState` ("No matches for …") when empty.
      - the **Map tab** renders the read-only `ConceptGraph` (`graph`/`gnode`) from
        `concepts.list` (T041); clicking a node sets the concept filter and switches to
        Results (matching the kit's `onPick`). The map is **read-only** (no edit/layout
        persistence) for the MVP — note the deferral.
- [ ] **Tests (Vitest, `packages/local-db`):** **search ranking** — given a source whose
      title contains the term and an extract whose body merely mentions it, the title match
      ranks **above** the body-only match; a card whose prompt matches is returned for a card
      query; a tag-only match (term appears only as a tag) is found; soft-deleted elements are
      **excluded**; an empty query returns `[]`; the FTS index **stays in sync** after an
      `update`/`delete` of a document/card (insert a row, search, edit it, search again, delete
      it, confirm it's gone — proving the triggers work). Run against an in-memory
      `better-sqlite3` with the FTS migration applied (`packages/local-db/src/test-db.ts`).
- [ ] **Tests (Vitest, `DbService` / contract):** `search.query` validates the payload,
      composes the concept/tag filters (T041), and returns ranked `SearchResult[]`.
- [ ] **Tests (Vitest, renderer):** `LibraryScreen` calls `appApi.search.query` on input
      (debounced), renders grouped results with highlighting, narrows on a filter click, and
      shows the `EmptyState` for no matches (mock `window.appApi.search`/`concepts`).
- [ ] **Playwright E2E** (`tests/electron/search.spec.ts`): open `/search`, type a term that
      matches the **seeded** source/extract/card → the expected items appear ranked → click a
      result → the detail/refblock shows → **restart the Electron app** → searching the same
      term still finds the seeded items (the FTS index persisted/rebuilt cleanly).

### Done when

- Local FTS5 search over source title/body + extract body + card prompt/answer + tags returns
  sources/extracts/cards **quickly** with **simple ranking**, grouped + highlighted in the
  `/search` library screen; the index is maintained by triggers (or repository writes) and
  stays in sync across insert/update/delete; soft-deleted elements are excluded.
- Search/index logic lives in `packages/local-db` (`SearchRepository`) + the FTS migration —
  the renderer only calls `search.*` over the typed `window.appApi`; no SQL in React.
- The FTS index **survives app restart** (it persists in the SQLite file; a fresh DB backfills
  on migrate).
- `pnpm typecheck`, `pnpm test`, `pnpm lint`, and the search Playwright spec pass.

### Notes / risks

- **The FTS migration is hand-authored.** `drizzle-kit generate` will **not** emit FTS5
  `CREATE VIRTUAL TABLE`/triggers from the TS schema (Drizzle doesn't model virtual tables).
  Author `0002_*.sql` directly and register it in `packages/db/drizzle/meta/_journal.json`
  (+ a snapshot) so both the dev migrator (`pnpm db:migrate`) and the Electron startup
  migrator (`apps/desktop/src/main/db-service.ts`) apply it. **Test that the migrator runs the
  file end-to-end** (the in-memory test DB applying all migrations is the guard). `better-sqlite3`
  ships with FTS5 compiled in — verify (`PRAGMA compile_options` includes `ENABLE_FTS5`) and
  note it in the migration; if unavailable on a target, the `LIKE` path is the fallback.
- **Keep the FTS schema in the TS barrel as a comment/no-op**, or document that
  `source_fts`/`extract_fts`/`card_fts` are migration-only objects not present in
  `packages/db/src/schema/index.ts` — so future `drizzle-kit generate` runs don't try to drop
  them. Prefer marking them `--> statement-breakpoint`-separated raw statements and excluding
  them from introspection (this is the standard Drizzle + FTS5 pattern; confirm the journal
  doesn't regenerate a DROP).
- **Sanitize the MATCH expression.** Never pass raw user text to FTS5 `MATCH` (it has its own
  query syntax that can throw on stray operators); tokenize the user input and build a safe
  prefix-AND expression. A malformed query must degrade to "no results", not an error.
- **Ranking is "simple" (MVP):** `bm25` with title/prompt weighted over body, a small tag
  boost. Recency/priority-weighted ranking, fuzzy/typo tolerance, and **semantic search** are
  explicitly later — semantic search is **M18/T087** (Postgres/pgvector), not this task.
- Reuse the T043 **ref/refblock formatter** for the `result__meta` line and the selection
  detail so the library, inspector, and review agree on how a source reference reads.
- The kit's "smart" filters (Stale facts / Low-yield sources / Leeches / Stagnant extracts) map
  to **M9/M17 analytics** — render the rows if cheap but it's acceptable to **defer/stub** them
  with a note; the milestone scope is keyword search + type/concept/tag/priority filtering.

---

## T043 — Source/reference display

- **Status:** `[ ]`  · **Depends on:** T022, T032
- **Roadmap line:** Done when: every extract and card shows source title/URL/author/date/
  location (review hides it until answer reveal); nothing feels orphaned.

### Goal

Every **extract** and **card** consistently shows where it came from — a **`refblock`** with
the originating **source title, URL, author, published date, and location** ("¶ 4" / "p. 12")
plus the verbatim source snippet — so nothing in the app feels orphaned. In the **reader/
extract view** and the **inspector** the refblock is always visible; in **review** it stays
**hidden until the answer is revealed** (so it can't leak the answer), exactly as the kit's
`screen-review.jsx` does. This **reuses the existing lineage + `source_locations` data** (the
`card → extract → source location → source` chain) — it adds presentation + the missing
provenance fields, not a new lineage model.

### Context to load first

- Reference: `domain-model.md` "Relationships & lineage" (the sacred chain `card → extract →
  source location → source metadata → original document context`); `CLAUDE.md` "Review rules"
  (open source; review reveals after grade) + "Key screens" (nothing orphaned);
  `design-system.md` `refblock`.
- Existing code to inspect: `design/kit/app/screen-review.jsx` (the `refblock serif` +
  `refblock__src` + `jumpToSource`, shown only after reveal); `design/kit/app/screen-reader.jsx`
  + `screen-builder.jsx` (the always-visible `refblock` in reading/extract/builder context);
  `design/kit/app/screen-library.jsx` (the selection detail `refblock`); the **already-built**
  refblock plumbing — `ReviewCardView { sourceTitle, sourceLocationLabel, ref }` in
  `contract.ts`, built in `db-service.ts` (~L1139–1158: `sourceTitle` from the source element,
  `sourceLocationLabel`/`ref` from `source_locations.label`/`selectedText`), and
  `apps/web/src/review/ReviewScreen.tsx` / `ReviewRepairBar.tsx` (which **already hide answer +
  ref until `revealed`**); `SourceProvenance` (`contract.ts`: `url`/`canonicalUrl`/
  `originalUrl`/`author`/`publishedAt`/`accessedAt`) + the inspector's existing provenance
  rendering (`apps/web/src/components/inspector/Inspector.tsx` `provenance` block); the extract
  view `apps/web/src/reader/ExtractView.tsx` (where an extract is processed); the **T022
  jump-to-source** flow (`navigateToLocation` / the reader `jumped` flash) — reuse it;
  `packages/local-db/src/source-repository.ts` (`findLocationById`) +
  `element-repository.ts` (source/parent reads).
- Invariants in play: lineage is **read/derived** — T043 does not mutate it; the refblock is
  built **main-side** from existing `sources` + `source_locations` rows and travels with the
  element payload; in review the answer + refblock are withheld from display until reveal (the
  payload may carry them — the renderer hides them, matching the existing T037 behavior); an
  element with **no** source/location must degrade gracefully (no crash, a quiet "no source"
  affordance), never a broken link.

### Deliverables

- [ ] **A single `SourceRef` shape + a formatter** (one place, reused everywhere): define
      `SourceRef { sourceElementId, sourceTitle, url, author, publishedAt, locationLabel,
      snippet }` in the contract (`apps/desktop/src/shared/contract.ts`) and a
      `formatSourceRef(ref): { citation; locationLabel; href }` helper. **Keep the formatter
      framework-agnostic** — put the citation-assembly logic in `packages/core`
      (e.g. `packages/core/src/source-ref.ts`, with unit tests) so it is not duplicated across
      review/extract/inspector/library and contains no React. The renderer's `RefBlock`
      component renders this; the library `result__meta` (T042) and the inspector reuse it.
- [ ] **Enrich the main-side refblock builders** so the `SourceRef` carries **URL + author +
      published date** (today `ReviewCardView` only has `sourceTitle`/`sourceLocationLabel`/
      `ref`). In `db-service.ts`, when building a card's / extract's reference, read the source
      element's `sources` provenance row (the same fields `SourceProvenance` exposes) and the
      `source_locations` row, and populate the full `SourceRef`. Add `sourceRef: SourceRef | null`
      to `ReviewCardView` (alongside or replacing the loose `sourceTitle`/`ref` fields — keep
      back-compat or migrate the renderer in the same change) and to the extract view payload.
- [ ] **Extract refblock** (`apps/web/src/reader/ExtractView.tsx`): render the always-visible
      `RefBlock` (source title + author/date + `external` link to the URL + the location label +
      the verbatim snippet), with the **T022 "open source / jump to location"** action wired to
      `navigateToLocation` using the extract's `source_locations` id. An extract with a source
      shows its origin; a (rare) source-less extract shows a quiet placeholder.
- [ ] **Card review refblock** (`apps/web/src/review/ReviewScreen.tsx`): upgrade the existing
      post-reveal `refblock` to the enriched `RefBlock` (title/URL/author/date/location +
      snippet + the existing jump-to-source button). **Confirm it remains hidden until
      `revealed`** (this is the load-bearing review constraint — keep the existing gate; do not
      ship the ref in the visible prompt face). The builder (`CardBuilder.tsx`, M6) and the
      library selection detail (T042) reuse the same `RefBlock`.
- [ ] **Inspector** (`apps/web/src/components/inspector/Inspector.tsx`): the inspector already
      renders source provenance for **sources**; ensure an **extract** or **card** selected in
      the inspector also shows its originating `RefBlock` (title/URL/author/date/location) via
      the element's lineage, so "open the inspector on a card" never feels orphaned. Reuse the
      `RefBlock` component + the `formatSourceRef` helper.
- [ ] **Graceful "orphaned" handling:** a card/extract whose source was soft-deleted or whose
      location is missing renders a calm "source unavailable" line (not a broken link / not a
      crash). The existing builders already guard `sourceEl && !sourceEl.deletedAt` — extend
      that to the enriched fields.
- [ ] **Tests (Vitest, `packages/core`):** `formatSourceRef` assembles a citation from
      title/author/date, omits missing fields cleanly, and produces a usable href from
      `url`/`canonicalUrl` (and returns a sane value when everything is null).
- [ ] **Tests (Vitest, `DbService`):** the card/extract reference payload includes
      `sourceTitle`, `url`, `author`, `publishedAt`, and `locationLabel` resolved from the
      `sources` + `source_locations` rows for a seeded card/extract; a card whose source is
      soft-deleted yields a null/placeholder ref (not a throw).
- [ ] **Tests (Vitest, renderer):** the extract view renders the `RefBlock`; in review the
      `RefBlock` is **absent before reveal and present after reveal** (assert the hidden→shown
      transition); the source-less case renders the placeholder.
- [ ] **Playwright E2E** (`tests/electron/reference-display.spec.ts`): open the **seeded
      extract** → its `RefBlock` shows source title + location + snippet, and the URL/author/
      date are present → click "open source" → it jumps to the originating paragraph (reusing
      T022); open `/review` on the seeded card → the prompt is shown **without** the refblock →
      reveal → the `RefBlock` appears → **restart the Electron app** → the refblock still
      resolves from lineage.

### Done when

- Every extract and card shows its source **title / URL / author / date / location** (the
  `refblock`), reusing the existing lineage + `source_locations` data with no new lineage
  model; **review keeps the refblock (and answer) hidden until the user reveals the answer**;
  nothing feels orphaned (a missing source degrades to a calm placeholder, never a crash).
- The citation/ref formatting lives in `packages/core` (`formatSourceRef`) and is reused by the
  extract view, review, builder, inspector, and the library result rows (T042) — one source of
  truth, no React-side citation logic duplication.
- The reference display **survives app restart** (it is derived from persisted lineage).
- `pnpm typecheck`, `pnpm test`, `pnpm lint`, and the reference-display Playwright spec pass.

### Notes / risks

- **Reuse, don't rebuild.** The review refblock + jump-to-source already exist (T037/T038 over
  T022). T043 (a) adds the missing URL/author/date to the `SourceRef`, (b) extracts the
  citation formatter into `packages/core`, (c) extends the refblock to the extract view +
  inspector. Do **not** add a second jump-to-source path or a second lineage query.
- **The reveal gate is load-bearing.** In review, the answer **and** the refblock must not show
  until reveal — the existing `ReviewScreen`/`ReviewRepairBar` already gate on `revealed`; keep
  that. (The payload may carry the ref so review stays local/fast — the renderer hides it; this
  matches the T037 decision.)
- **No remote fetching.** Provenance is whatever was captured at import (T014) — `publishedAt`
  is a loose date string stored as-is; render it as-is, don't parse/reformat aggressively.
- Source **reliability metadata** (primary/secondary/tertiary, confidence) and richer citation
  styles are **M18/T091** — T043 ships title/URL/author/date/location only.
- If `ReviewCardView` changes shape (adding `sourceRef`), update the M7 review tests + the
  contract test in the **same** change; prefer an additive `sourceRef` field over removing the
  existing `sourceTitle`/`ref` to minimize churn, then migrate consumers.

---

## Exit criteria for M8

- All of T041–T043 are `[x]` in [`../roadmap.md`](../roadmap.md).
- **Organize:** concepts (hierarchical — `concept` element + `concepts.parentConceptId`) and
  tags (flat — `tags`/`element_tags`) can be created and assigned/unassigned through typed
  `concepts.*`/`tags.*` `window.appApi` commands; elements **filter by concept and tag**; every
  assignment is one transaction + the correct **existing** op (`create_element` /
  `add_relation` / `remove_relation` / `add_tag` / `remove_tag`) — **no new op types**.
- **Search:** local FTS5 search (`source_fts`/`extract_fts`/`card_fts` + sync triggers, added in
  the hand-authored Drizzle migration `0002_*`) over source title/body + extract body + card
  prompt/answer + tags returns sources/extracts/cards quickly with simple `bm25` ranking, in the
  rebuilt `/search` `LibraryScreen` (filterbar + grouped/highlighted results + the read-only
  concept Map tab); the index stays in sync across insert/update/delete and excludes
  soft-deleted elements. Search/index logic lives in `SearchRepository` + the migration, never
  in React.
- **References:** every extract and card shows its source title/URL/author/date/location (the
  `refblock`), reusing the existing lineage + `source_locations`; **review hides the refblock
  and answer until reveal**; missing-source cases degrade calmly; the citation formatter lives
  in `packages/core` and is shared by review/extract/inspector/library.
- All new capabilities reach the renderer **only** through new typed `window.appApi` commands
  (`concepts.*`, `tags.*`, `search.*`) with Zod-validated IPC; **no raw DB/filesystem access is
  exposed to the renderer**, and no generic `db.query`.
- Everything **survives app restart**.
- `pnpm typecheck`, `pnpm test`, `pnpm lint`, and the M8 Playwright specs (concepts/tags filter;
  search finds + ranks seeded items; reference display shows on an extract/card and hides until
  reveal in review) are green.

When M8 is complete, generate `tasks/M9-safety-analytics-backup.md` from the roadmap before
starting T044.
