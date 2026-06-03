# M20 — Scale & hardening (T099–T100)

Detailed, buildable specs for the final milestone. M20 is the **"hold years of personal
knowledge without slowing down or breaking"** milestone. Two tasks: **large-collection
maintenance tools** (T099 — dedup, orphan-media cleanup, broken-source / cards-without-sources
reports, bulk low-priority postpone/archive, DB integrity check), and the **gold-standard QA &
performance hardening** pass (T100 — load-test the LOCAL-FIRST app at 100k cards / 100k extracts /
thousands of sources / long histories, measure the hot paths against budgets, add any missing
indexes via a migration, check rendering/virtualization, and run a final QA checklist).

After M20 the local-first promise holds **at scale**: a 100k-element collection stays fast
(queue, search, semantic KNN, review next-pick, analytics, backup), maintainable (the T099
read-only reports + transactional cleanup), and provably durable (backup/restore at scale +
`PRAGMA integrity_check` + the MVP flow still green after an app restart).

The architecture is unchanged and non-negotiable (see [`../../CLAUDE.md`](../../CLAUDE.md) and the
roadmap header): the React **renderer** (`apps/web`) never touches SQLite, Node, or the
filesystem — every capability flows React UI → typed client wrapper
(`apps/web/src/lib/appApi.ts`) → preload bridge (`apps/desktop/src/preload/index.ts`) → validated
IPC (Zod) on the main side (`apps/desktop/src/main/ipc.ts`) → the `DbService`
(`apps/desktop/src/main/db-service.ts`) → `packages/local-db` repositories +
`packages/scheduler` services → SQLite + the filesystem asset vault. **Maintenance, integrity,
dedup, and performance work are READ-ONLY reports + transactional cleanup actions in
`packages/local-db` / the Electron main process — NEVER React SQL.** Every destructive cleanup is
**soft-delete / confirmable / undoable** — the app **NEVER** silently destroys user data; the
**only** hard delete in the whole app stays `TrashRepository.purge`/`emptyTrash` (T044). Every
meaningful mutation runs in **one transaction** and appends an **`operation_log`** row; deletes
are **soft** (`deleted_at`); `foreign_keys = ON`. Lineage (`card → extract → source_location →
source`) is sacred. A feature is not done until it survives an **app restart**, verified with
native `pnpm`.

> **Re-scope (read this — the roadmap's T100 deps are stale).** T100's roadmap line lists
> `deps: T099, T096, T097, T098`. **T097 (Tauri shell) and T098 (backup-encryption hardening) are
> OUT OF SCOPE for the local-first program** (see the M19 header + the 2026-06-01 progress-log
> entry: there is no live sync, no second shell). T100 therefore load-tests **the local-first
> Electron app only** — **no Tauri**, **no end-to-end-encryption**, **no multi-device sync** in
> the load matrix. The real deps are **T099** (the maintenance tools this hardens) and **T096**
> (review modes, whose `MAX_REVIEW_MODE_DECK = 500` cap — exported from `@interleave/core`
> (`packages/core/src/review-mode.ts`), consumed by `review-mode-service.ts` — T100 load-tests).
> "Large PDFs" stays a
> vault/runner concern (the bytes never enter SQLite — T059/T064); T100's DB load matrix is
> **rows, not blobs**.

Read first:
- [`../../CLAUDE.md`](../../CLAUDE.md) — **"SQLite rules"** (WAL, `foreign_keys`, `busy_timeout`,
  FTS5, indexes; the DB + `assets/` + `backups/` siblings; no large blobs in SQLite),
  **"Asset vault"** (orphan-file GC surface), **"Data rules"** (soft delete / trash / undoable;
  `operation_log` from day one; backup = SQLite file + vault, not a JSON dump), **"Testing
  expectations"** (unit tests for scheduling/repository behavior; Playwright for the MVP flow +
  restart), **"Definition of done"** (survives app restart; migrations included if schema
  changed; no raw DB/fs to the renderer).
- [`../architecture.md`](../architecture.md) — the layering + the local-db/main boundary; the
  hot-path repositories.
- [`../scheduling-and-priority.md`](../scheduling-and-priority.md) — the FSRS-vs-attention split
  (T100 must not collapse it under load); overload protection (T099 bulk postpone/archive).
- [`./M9-safety-analytics-backup.md`](./M9-safety-analytics-backup.md) — the precedents T099
  composes (T044 trash/undo, T047 backup) and T100 re-verifies at scale (the backup format, the
  manifest hashes, restore-from-day-one).

### What already exists (inspect before building — do not duplicate)

The whole app is built; T100 **measures and hardens** it, it does not add product surface. The
load-bearing pieces:

- **The DB open path + the mandatory PRAGMAs** (`packages/db/src/client.ts`): `openDatabase` +
  `applyPragmas` set `foreign_keys = ON`, `journal_mode = WAL`, `busy_timeout = 5000` on every
  open (in-memory included). The Electron main loads an Electron-ABI native binding via
  `nativeBinding` (`apps/desktop/src/main/db-service.ts` + the native-binding path); Vitest/dev
  use the default Node-ABI binary. `PRAGMA integrity_check` is the one read T100 adds to the QA
  surface (no schema change for it).
- **The schema + its EXISTING indexes** (`packages/db/src/schema/*.ts`) — the audit baseline.
  Today's indexes (the T100 audit confirms / extends these):
  - `elements`: `elements_parent_idx`, `elements_source_idx`, `elements_type_status_idx`
    `(type, status)`, `elements_due_idx` `(due_at)`.
  - `cards`: `cards_source_location_idx`, `cards_is_leech_idx`, `cards_is_retired_idx`,
    `cards_review_by_idx`.
  - `review_states`: `review_states_due_idx` `(due_at)`. `review_logs`:
    `review_logs_element_idx`, `review_logs_reviewed_idx` `(reviewed_at)`.
  - `sources`: `sources_canonical_url_idx` `(canonical_url)` (T061 dedup — already present).
  - `source_locations`: `source_locations_element_idx`, `source_locations_source_idx`.
  - `element_relations`: `_from_idx`, `_to_idx`, `_sibling_idx` (concept membership / lineage /
    sibling-group edges all live here).
  - `element_tags`: `element_tags_tag_idx` + the `(element_id, tag_id)` PK.
  - `concepts`: `concepts_parent_idx`. `tasks`: `tasks_due_idx`, `tasks_linked_element_idx`, the
    partial `tasks_open_link_type_uq`.
  - `documents`/`document_blocks`/`document_marks`: `document_blocks_stable_idx`
    `(document_id, stable_block_id)` unique, `_document_idx`, `document_marks_*`.
  - `embeddings`: `embeddings_vec_rowid_idx` (unique), `_type_idx`, `_model_idx`. The `vec0` KNN
    runs in the `element_vectors` virtual table (`0022_semantic_vec0.sql`).
  - `operation_log`: `operation_log_element_idx`, `operation_log_created_idx`. `assets`:
    `assets_owning_element_idx`, `assets_content_hash_idx`.
  - FTS5: `source_fts` / `extract_fts` / `card_fts` (`0002_search_fts5.sql`, trigger-synced).
  - **The latest applied migration tag is `0026_reflective_magma`** (`packages/db/drizzle/meta/_journal.json`),
    so T100's index migration is **`0027`**.
- **The hot query paths** T100 benchmarks (all read-only, behind the IPC boundary):
  - `QueueQuery.list` (`packages/local-db/src/queue-query.ts`) — the daily-queue read: merges
    `QueueRepository.dueCards` (the FSRS `review_states → elements → cards`
    inner-join + `is_retired = false`) and `dueAttentionItems` (the attention `elements.due_at`
    read), decorates each row, then orders by the T076 `scoreQueueItems`.
    **N+1 RISK to measure:** `toCardSummary`/`toAttentionSummary` call per-row
    `sourceContext` (`sources.findById` + `elements.findById`), `conceptFor`
    (`concepts.firstConceptName`), `findReviewState`, `findCardById`, `countPostpones`. Some
    seams are pre-batched (`liveSiblingGroupMap`, `buildConceptMatcher`); others are not. T100
    measures whether the per-row reads dominate at 100k.
  - `SearchRepository.search` (`packages/local-db/src/search-repository.ts`) — FTS5 `MATCH` over
    `source_fts`/`extract_fts`/`card_fts` with `bm25` ranking.
  - `SemanticSearchRepository.search` (`packages/local-db/src/semantic-search-repository.ts`) →
    `EmbeddingRepository.knn` (`packages/local-db/src/embedding-repository.ts`, `vec0` KNN, with
    the `vecAvailable` flag) fused with FTS via RRF.
  - `ReviewSessionService.next` (`packages/local-db/src/review-session-service.ts`) — the
    FSRS next-pick over `QueueRepository.dueCards` with sibling burying.
  - `AnalyticsService.computeAnalytics` (`packages/local-db/src/analytics-query.ts`) — the
    windowed aggregation over `review_logs` + `elements` + `review_states` (T045/T046/T083).
  - `BackupService.createBackup` (`apps/desktop/src/main/backup-service.ts`) — the snapshot is
    `db-service.ts`'s `backupDatabaseTo` (a `wal_checkpoint(PASSIVE)` + `VACUUM INTO ?`; there is
    **no** better-sqlite3 `.backup()` call in the repo) + recursive vault copy + per-file SHA-256
    manifest + zip (T047). Restore is still the documented-but-deferred contract.
- **The shared factories** (`packages/testing/src/factories.ts`, `seedDemoCollection`,
  `DEMO_FIXTURES`) — built THROUGH the `packages/local-db` repositories (never raw inserts), so
  they exercise the real transactions + `operation_log` appends + lineage. `createInMemoryDb`
  (`packages/testing/src/db.ts`) opens a fully-migrated `:memory:` DB. The seed CLI
  (`scripts/seed-dev.ts`, `pnpm seed`) resets + rebuilds the dev DB through the same factory.
  **T100's large-collection seed reuses these factory primitives** — but at 100k it bypasses the
  per-element `operation_log`/transaction overhead with a documented bulk path (see T100).
- **The Playwright/Electron e2e harness** (`tests/electron/`, `launch.ts`,
  `mvp-flow.spec.ts` — import → activate → read-point → extract → card → review → reschedule →
  search → open source → backup, with the restart-and-verify-persistence step). T100 adds a
  scale-smoke spec and re-runs the MVP flow against a larger seed.
- **The T099 maintenance precedents** T100 re-verifies at scale: `TrashRepository.purge`/
  `emptyTrash` (T044, the only hard delete), `AssetVaultService.findOrphans`/`collectOrphans`/
  `verifyIntegrity` (T059), `EmbeddingRepository.pruneOrphanVectors` (T087),
  `SourceDedupQuery` + `SourceRepository.findByCanonicalUrl` (T061), `SourceYieldQuery` (T083),
  the auto-postpone / queue-action defer helpers (T077) + `CardRetirementService` (T082).

Build order is the task order: **T099 first** (the maintenance tools), **then T100** (which
load-tests them + everything else). T099's spec is in **the same file** (its `## T099` section
below). **This is the LAST milestone** — when T100 is `[x]`, the roadmap (T001–T100) is complete;
no further milestone spec is generated.

---

## T099 — Large-collection maintenance tools

- **Status:** `[ ]`  · **Depends on:** T044, T083
- **Roadmap line:** Done when: dedup, orphan-media cleanup, broken-source reports,
  cards-without-sources, bulk low-priority postpone/archive, and DB integrity checks keep a
  100k-element collection maintainable.

### Goal

A **Maintenance** surface gives the user a small set of **read-only diagnostic reports** over a
large collection and a small set of **safe, transactional cleanup actions** to act on them:
**duplicate sources**, **orphan media**, **broken sources** (a source whose snapshot/asset is
missing), **cards without sources** (lineage gaps), **DB integrity** (`PRAGMA integrity_check` +
foreign-key check), and a **bulk low-priority postpone / archive** to shed overload. Every report
is a domain read in `packages/local-db` / the Electron main; every cleanup is soft-delete /
confirmable / undoable (the only hard delete stays `TrashRepository.purge`). The screen is the
`Open maintenance` link the Analytics view (T045) already points at.

> **This task is specified at roadmap-line altitude here so T100 can depend on a concrete shape.**
> The builder for T099 should expand the deliverables below into the full `window.appApi`
> `maintenance.*` seam following the M9 pattern (channels → contract+test → preload → ipc →
> db-service+test → renderer client) and a `/maintenance` route + screen. If a fuller standalone
> T099 spec is wanted, generate it before starting — but the deliverables below are buildable as
> written.

### Context to load first

- Reference: `CLAUDE.md` "Data rules" / "Asset vault" / "SQLite rules"; `scheduling-and-priority.md`
  (overload → bulk postpone/archive); `design-system.md` (`screen-analytics` "Open maintenance",
  `Banner`, `Status`, the confirm dialog pattern).
- Existing code to inspect (compose, don't reinvent):
  - **Dedup:** `SourceRepository.findByCanonicalUrl` + `SourceDedupQuery`
    (`packages/local-db/src/source-dedup-query.ts`, T061) — group sources by `canonical_url`
    (`sources_canonical_url_idx`).
  - **Orphan media:** `AssetVaultService.findOrphans` / `collectOrphans` / `verifyIntegrity`
    (`apps/desktop/src/main/asset-vault-service.ts`, T059) — file-centric vault GC + re-hash
    integrity. `EmbeddingRepository.pruneOrphanVectors` (`packages/local-db/src/embedding-repository.ts`,
    T087) — the `element_vectors` rowid sweep.
  - **Broken source / cards-without-sources:** NEW read-only queries (the gaps — see below).
  - **Bulk postpone/archive:** the auto-postpone / queue-action defer helpers
    (`packages/local-db/src/queue-action-service.ts` / `auto-postpone-service.ts`, T077) +
    `CardRetirementService` (`packages/local-db/src/card-retirement-service.ts`, T082) +
    `SchedulerService.scheduleAt`. `TrashRepository` (T044) for the soft-delete/restore path +
    `UndoService` for command-level undo.
  - **Integrity:** the open DB handle (`apps/desktop/src/main/db-service.ts`) — run
    `PRAGMA integrity_check` + `PRAGMA foreign_key_check` (read-only).
- Invariants in play: reports are read-only (no mutation, no `operation_log`); every cleanup is
  one transaction + an `operation_log` row, soft-delete/undoable; the only hard delete is the
  existing `TrashRepository.purge`; lineage is preserved (a dedup "merge" re-parents children, it
  does not orphan them); bulk actions are individually undoable (the T044 `batchId` grouping).

### Deliverables

- [ ] **A `MaintenanceQuery` (read-only reports) in `packages/local-db`**
      (`packages/local-db/src/maintenance-query.ts`, exported from the index + `Repositories`):
      - `duplicateSources(): DuplicateSourceGroup[]` — sources grouped by `canonical_url`
        (≥2 per group), each carrying the group's element summaries + which is the keeper
        (oldest / most children). Composes `SourceDedupQuery`.
      - `brokenSources(): BrokenSource[]` — `source`-type elements whose `sources.snapshot_key`
        / owning asset is missing on disk (cross-checks `AssetRepository` metadata vs the
        vault). The disk check is a **main-process** read (`AssetVaultService`), so the DB-side
        query returns the candidates + the main side confirms the missing bytes.
      - `cardsWithoutSources(): ElementSummary[]` — `card`-type live elements with NO
        `sourceLocationId` AND no `sourceUri` AND no live `sourceId` (a lineage gap — a card
        that can't point back). Read-only; the fix is a user affordance ("attach source"), not
        an auto-mutation.
      - `lowPriorityBacklog(asOf, { band }): ElementSummary[]` — live, due/overdue, low-priority
        (C/D band) attention items + cards eligible for bulk postpone/archive (the overload
        shed list).
  - All four are pure reads; none appends `operation_log`.
- [ ] **A `MaintenanceService` (the transactional cleanup ACTIONS) in `packages/local-db`**
      (`packages/local-db/src/maintenance-service.ts`):
      - `mergeDuplicateSource({ keepId, dropId }): MergeResult` — re-parent `dropId`'s children
        (extracts/cards/locations) onto `keepId`, then **soft-delete** `dropId` (never hard).
        One transaction; appends `update_element` (re-parent) + `soft_delete_element`; lineage
        preserved; undoable.
      - `bulkPostpone({ ids, until }): { count }` / `bulkArchive({ ids })` — defer / retire the
        low-priority backlog via `SchedulerService.scheduleAt` / `CardRetirementService` /
        soft-delete, grouped under a shared `batchId` (T044) so `undoLast` reverses the whole
        batch. One transaction; appends `reschedule_element`/`update_element` per item.
      - `cleanupOrphanMedia()` delegates to the main-side `AssetVaultService.collectOrphans` +
        `EmbeddingRepository.pruneOrphanVectors` (the vault GC is a main-process file op; this
        service exposes the count + the confirm gate).
  - Every action: one transaction, an `operation_log` row, soft-delete (never hard except the
    existing `TrashRepository.purge`), undoable.
- [ ] **A `maintenance.*` + `integrity.*` `window.appApi` surface** (M9 pattern): channels +
      Zod contract+test + preload + ipc + `DbService` (+ test) + renderer client.
      `maintenance.report()` (all four read-only reports), `maintenance.merge`, `maintenance.bulkPostpone`,
      `maintenance.bulkArchive`, `maintenance.cleanupOrphans`, `integrity.check()`
      (`PRAGMA integrity_check` + `PRAGMA foreign_key_check`, read-only). No generic `db.query`.
- [ ] **A `/maintenance` route + `MaintenanceScreen`** (`apps/web/src/maintenance/…`) — the
      report cards (duplicates / orphans / broken / cards-without-sources / integrity), each with
      a confirm-gated cleanup action; the bulk postpone/archive panel; reached from the Analytics
      "Open maintenance" link + `SECONDARY_NAV`.
- [ ] **Tests (Vitest, `packages/local-db`):** each report returns the right rows on a seeded
      fixture (duplicate canonical_url group; a card with no lineage; a low-priority backlog);
      `mergeDuplicateSource` re-parents children + soft-deletes the dup + preserves lineage +
      appends the ops + is undoable; `bulkPostpone`/`bulkArchive` group under one `batchId` and
      `undoLast` reverses the batch; `integrity.check` returns `ok` on a healthy DB.
- [ ] **Playwright E2E** (`tests/electron/maintenance.spec.ts`): seed duplicate sources + an
      orphan asset + a low-priority backlog → open `/maintenance` → the reports list them → merge
      a dup / postpone the backlog / clean orphans → the reports update → `⌘Z`/Undo reverses a
      bulk action → **restart the app** → the cleanups persist and the integrity check is `ok`.

### Done when

- Dedup, orphan-media cleanup, broken-source reports, cards-without-sources, bulk low-priority
  postpone/archive, and a DB integrity check all exist and keep a large collection maintainable;
  reports are read-only, cleanups are transactional + soft-delete/undoable, and the only hard
  delete stays `TrashRepository.purge`; lineage survives a merge; everything survives **app
  restart**.
- The reports + actions live in `packages/local-db` / the Electron main, **never** React; all
  reach the renderer only through the typed `maintenance.*` / `integrity.*` `window.appApi`
  surface (no generic `db.query`).
- `pnpm typecheck`, `pnpm test`, `pnpm lint`, and the maintenance Playwright spec pass.

### Notes / risks

- **A "merge" must re-parent, never orphan.** The duplicate-source merge re-points the dropped
  source's children onto the keeper before soft-deleting it; a child must never be left pointing
  at a deleted source. Test the lineage chain after a merge.
- **No new hard delete.** Cleanup is soft-delete + trash; the vault orphan GC removes *files with
  no DB row* (already `AssetVaultService`'s contract), not user content.
- The 100k-scale PERFORMANCE of these reports is **T100's** concern (it benchmarks
  `maintenance.report` at scale + indexes any slow scan). T099 builds correct behavior; T100
  proves it stays fast.

---

## T100 — Gold-standard QA & performance hardening

- **Status:** `[ ]`  · **Depends on:** T099, T096 (T097 + T098 are **out of scope** — see the
  re-scope note in the milestone header)
- **Roadmap line:** Done when: load-tested at 100k cards / 100k extracts / thousands of sources /
  large PDFs / long histories, with indexes, rendering, search, queue calc, and backup/restore
  optimized so the app stays fast, safe, backed up, and searchable after years of use.

### Goal

Prove — and where needed, fix — that the **local-first** app stays fast, safe, backed up, and
searchable at the scale of years of use: **~100k cards, ~100k extracts, thousands of sources, and
long review histories**. T100 adds (1) a **large-collection seed harness** that builds a ~100k-
element collection into a temp DB; (2) a **benchmark** that MEASURES the hot read paths (queue
calc, FTS search, semantic KNN, review next-pick, analytics, maintenance reports, backup) against
**explicit, measurable budgets**; (3) an **index audit** of `packages/db/src/schema/*.ts` that
adds any missing indexes via migration **`0027`**; (4) **rendering/virtualization checks** for the
long lists; and (5) a **final QA checklist** (backup/restore at scale, `PRAGMA integrity_check`,
the MVP flow still green after an app restart). The bench runs in CI as a **bounded smoke** (a
smaller N) with the **full 100k as an opt-in / documented local run** so it never bloats the
normal test run.

This task adds **no product surface** and **no new `window.appApi` command** (it measures the
existing ones). The only shipped artifacts are: the seed harness, the bench + budgets, the index
migration, the rendering checks, and the QA checklist + scale-smoke e2e.

### Context to load first

- Reference: `CLAUDE.md` "SQLite rules" (indexes, FTS5, WAL, `integrity_check`), "Testing
  expectations" (Playwright MVP flow + restart), "Definition of done" (migration if schema
  changed; survives app restart; no raw DB/fs to the renderer); `architecture.md` (the hot-path
  repositories + the IPC boundary).
- Existing code to inspect (all listed in the milestone header's "What already exists"): the
  schema + its indexes (`packages/db/src/schema/*.ts`); the hot paths (`queue-query.ts` /
  `queue-repository.ts`, `search-repository.ts`, `semantic-search-repository.ts` /
  `embedding-repository.ts`, `review-session-service.ts`, `analytics-query.ts`,
  `maintenance-query.ts` from T099, `backup-service.ts`); the factories
  (`packages/testing/src/factories.ts` + `db.ts`); the e2e harness (`tests/electron/launch.ts`,
  `mvp-flow.spec.ts`); the DB open path + PRAGMAs (`packages/db/src/client.ts`); the migration
  journal (`packages/db/drizzle/meta/_journal.json`, latest tag `0026_reflective_magma`).
- Invariants in play: the seed builds REAL rows that satisfy every CHECK/FK (so the bench measures
  realistic plans); the bench is read-only (no `operation_log`); the index migration is additive
  (CREATE INDEX only — no data change, no table rewrite, fully backward-compatible); the
  FSRS-vs-attention split must still hold at scale (the queue measures both reads); the renderer
  still never touches SQLite (the rendering check uses the real `window.appApi`).

### Deliverables

- [ ] **A large-collection seed harness** (`packages/testing/src/large-seed.ts`, exported from
      `packages/testing/src/index.ts`): `seedLargeCollection(repos, db, opts): LargeSeedStats`
      that builds a configurable collection into an already-open, migrated DB.
      - `opts = { sources, extractsPerSource, cardsPerExtract, reviewsPerCard, conceptCount,
        embeddings?, seed? }` with a documented **default profile** that reaches the scale matrix
        — **~thousands of sources**, **~100k extracts**, **~100k cards**, and **long review
        histories** (e.g. 10–30 `review_logs` per card → ~1M+ log rows). Deterministic from
        `seed` — reuse the **`mulberry32` algorithm** (with the `xmur3` string-hash seeding it for a
        string `seed`) from `packages/local-db/src/review-mode-service.ts` (T096 — the only seeded
        RNG in the repo). **Caveat:** `mulberry32`/`xmur3`/`seededShuffle` there are **private module
        functions** (only `ReviewModeService` + its types are exported), so they are **not importable
        today**. Either (a) export `mulberry32` (+ `xmur3` for string seeds) from
        `review-mode-service.ts` and re-export it, or (b) re-implement the dependency-free ~6-line
        PRNG (and the tiny `xmur3` hash for string seeds) locally in `large-seed.ts` — prefer (b) to
        avoid `packages/testing` reaching into `packages/local-db` internals. There is **no separate
        published `xmur3`/RNG utility module** to import; it lives inline in `review-mode-service.ts`.
      - **Builds real, valid rows** with full lineage (`source → source_location → extract → card`)
        so the bench measures realistic query plans, distributing `priority` across A/B/C/D,
        spreading `review_states.due_at` (so a realistic fraction is due), `elements.created_at`
        across a window (so analytics scans hit real data), and seeding concept membership +
        tags so the concept/tag filters and dedup have rows to chew on.
      - **Honest about the op-log/transaction tradeoff (the one real correctness/feasibility
        knob):** the per-element factory path appends an `operation_log` row + runs a transaction
        per mutation, which is **too slow for 1M+ rows**. The harness therefore offers a
        **documented bulk-insert fast path** (batched `INSERT` inside a single transaction,
        `PRAGMA synchronous = OFF` / `journal_mode = MEMORY` **on the throwaway bench DB only**)
        that writes the SAME row shapes the repositories produce, with a **smoke-sized control
        run through the real repository path** to prove the bulk rows are schema-identical. The
        bulk DB is a **temp file** (`os.tmpdir()` or `INTERLEAVE_DATA_DIR` override), never the
        user/dev DB; document that the bench DB skips per-row `operation_log` ON PURPOSE (the
        op-log throughput itself is exercised by the existing per-task transaction tests, not
        here).
      - Returns `LargeSeedStats` (the actual row counts per table + the wall-clock build time +
        the on-disk DB size) so the bench can print a one-line provenance header.
- [ ] **A benchmark with measurable budgets** (`packages/local-db/bench/scale.bench.ts`, run via a
      new `"bench": "vitest bench"` script in the root `package.json` — Vitest has native `bench`,
      which runs a single pass and exits (it is not a watcher by default), so no `--run` flag is
      needed; **NOT** wired into `pnpm test`). For each hot path it seeds (or reuses) a
      large-collection DB, runs the read N times, and asserts a **p95 wall-clock budget** (a hard
      `expect` so a regression FAILS, not just prints). The paths + **starting budgets** (tune to
      the CI machine in the first run; document the machine + numbers in the bench header):
      - `QueueQuery.list` (the default-mode daily queue at 100k) — **budget: p95 < 250 ms** (the
        first page; the screen is virtualized, so the read need not return all rows). Measure with
        and without a concept/tag filter (the N+1 seams). If over budget, the fix is the index
        audit below + batching the remaining per-row reads.
      - `SearchRepository.search` (a representative multi-term query) — **budget: p95 < 100 ms**
        (FTS5 is already indexed; this proves it).
      - `SemanticSearchRepository.search` → `EmbeddingRepository.knn` over ~100k vectors (when
        `embeddings` were seeded + `vec0` is available) — **budget: p95 < 300 ms**; degrades to
        FTS-only when `vec0` is unavailable (no failure — same contract as T096).
      - `ReviewSessionService.next` (the FSRS next-pick + sibling bury) — **budget: p95 < 100 ms**.
      - `AnalyticsService.computeAnalytics` (the 30-day window over ~1M `review_logs`) —
        **budget: p95 < 300 ms**.
      - `MaintenanceQuery.report` (the T099 reports at scale) — **budget: p95 < 500 ms**.
      - **The DB-snapshot primitive** (`db-service.ts`'s `backupDatabaseTo` — the `wal_checkpoint` +
        `VACUUM INTO` of a ~multi-hundred-MB DB) — **budget: a soft ceiling (e.g. < 30 s) printed,
        not a hard fail** (it is I/O-bound + machine-dependent; the correctness check is the QA
        checklist's restore round-trip, not a wall-clock gate). **Measure the snapshot primitive,
        not the full `apps/desktop` `BackupService.createBackup`** (vault copy + manifest + zip):
        `BackupService` lives in `apps/desktop` and would pull an `apps/desktop` dependency into the
        `packages/local-db/bench/` bench, whereas `wal_checkpoint` + `VACUUM INTO` is a plain
        better-sqlite3 op the bench can run directly against its temp bench DB (assets excluded or a
        small fixed vault). The full `BackupService` zip/manifest path stays covered by its own
        `apps/desktop` tests + the QA restore round-trip.
      - The bench **prints a table** (path, p50/p95, budget, pass/fail) + the `LargeSeedStats`
        header. Budgets live in **one exported constants object** so they are tunable in one place.
- [ ] **An index audit + the `0027` migration** (`packages/db/src/schema/*.ts` + `pnpm db:generate`
      → `packages/db/drizzle/0027_*.sql` + the journal entry). Audit every hot WHERE/ORDER/JOIN at
      100k and add the **missing** indexes the bench shows are needed. **Confirmed gaps from the
      current schema** (add the ones the bench proves slow — do not add speculative indexes):
      - `elements(created_at)` — `AnalyticsService` counts `newCards`/`newExtracts`/`sourcesImported`
        + `deletions` by `created_at`/`deleted_at` window; there is **no `created_at` index** today
        (only `parent`/`source`/`(type,status)`/`due_at`). A composite **`elements(type, created_at)`**
        serves the "new X in window" scans directly.
      - `elements(type, due_at)` — `QueueRepository.dueAttentionItems` filters
        `type IN (...) AND due_at <= asOf ORDER BY due_at`; today only `elements_due_idx (due_at)`
        and `elements_type_status_idx (type, status)` exist, so the attention due read can't use a
        single composite. A **`elements(type, due_at)`** composite (or extending `due_idx`) covers
        it. **This is the least-certain of the three** — the real read also filters on
        status/live-ness, so depending on selectivity the planner may already do fine with
        `elements_due_idx`; it partly overlaps the existing indexes. **Honor the "prove it slow
        first" rule strictly here:** add it only if the bench + `EXPLAIN QUERY PLAN` show
        `dueAttentionItems` is actually slow / not using a good index — do **not** add it reflexively.
      - `elements(deleted_at)` — the trash list + the analytics `deletions` count + the
        "live rows only" filters scan `deleted_at IS [NOT] NULL`; a partial/plain index helps the
        trash + maintenance reads at scale.
      - Re-confirm the already-present **`sources_canonical_url_idx`** (dedup), **`cards_review_by_idx`**
        (stale/expiry scan), **`review_states_due_idx`** + **`review_logs_reviewed_idx`** (queue +
        analytics) are doing their job under the bench (no change expected — document the
        confirmation).
      - The migration is **additive `CREATE INDEX` only** — no column/table change, no backfill,
        fully backward-compatible; a backup from before `0027` restores cleanly (migrations run
        forward, per the T047 restore contract). Add a migration-level test (the M-precedent
        pattern) asserting `0027` creates exactly the new indexes and `PRAGMA integrity_check`
        stays `ok` after it applies.
- [ ] **Add row virtualization to the long lists** (`apps/web`): **this is net-new work, not a
      "confirm"** — there is **no** virtualization primitive in `apps/web/src` today (no
      `react-virtual` / `useVirtualizer` / `VirtualList` / windowing) and `@tanstack/react-virtual`
      is **not** a dependency, so all four screens need windowing added. Window the screens that can
      show thousands of rows — the **queue** (`apps/web/src/pages/queue/QueueScreen.tsx`),
      **library/search** (`LibraryScreen`/search results), **trash** (`TrashScreen`), and the
      **maintenance reports** (T099) — so a 10k-row payload renders without freezing. Add windowing
      via `@tanstack/react-virtual` (confirm the dep add before committing it; size this as real
      work across all four screens, not a confirmation). The load-bearing mitigation already holds:
      the IPC reads stay **paginated/limited** (`QueueQuery.list`'s `limit`, `SearchRepository.search`'s
      `limit`, the review-mode `MAX_REVIEW_MODE_DECK = 500` cap from T096) so the renderer never
      receives an unbounded
      list. A component test asserts a large mocked payload renders a bounded number of DOM rows.
- [ ] **A final QA checklist** (a `## Scale QA checklist` section in this spec + an executable
      `tests/electron/scale-smoke.spec.ts`) covering, at a **CI-bounded N** (a few thousand
      elements — NOT 100k in CI):
      - **Backup/restore at scale** — `backups.create` on the large seed produces a valid zip; the
        manifest hashes verify; opening the backed-up `app.sqlite` shows the same row counts
        (the WAL-checkpoint consistency check); a restore-mechanics check follows the T047
        documented contract (verify format/schema version, verify hashes, copy, migrate forward).
      - **`PRAGMA integrity_check` + `PRAGMA foreign_key_check`** return `ok` on the large seed and
        after the `0027` migration (the T099 `integrity.check` surface).
      - **The MVP flow still green after restart** — re-run (or reuse) `mvp-flow.spec.ts`'s
        import → activate → read-point → extract → card → review → reschedule → search → open
        source → backup against a larger-than-demo seed, including the **restart-and-verify-
        persistence** step.
      - **The two-scheduler split holds at scale** — the queue still returns FSRS cards (by
        `review_states.due_at`) AND attention items (by `elements.due_at`) correctly when both
        pools are large (no collapse, no starvation).
      - **The FTS + `vec0` search still returns relevant hits** at 100k (the search bench's
        correctness side: a known seeded term/phrase is found).
- [ ] **Honest CI-vs-local documentation** (the bench header + this spec's notes): the **full 100k
      bench is opt-in / local** (run `pnpm bench` after `seedLargeCollection` with the default
      profile; it takes minutes + needs ~hundreds of MB of temp disk). **CI runs the bounded
      smoke** (`scale-smoke.spec.ts` at a few-thousand-N + the bench at a small N) so every PR
      stays fast. Document the exact commands + the expected wall-clock on the reference machine.

### Scale QA checklist

Run before declaring T100 done (the executable subset is `scale-smoke.spec.ts` at CI-N; the full
100k subset is the documented local run):

1. **Seed** a large collection (`seedLargeCollection`, default profile) into a temp DB; record
   `LargeSeedStats` (row counts + build time + DB size).
2. **Bench** every hot path (`pnpm bench`); every hard-budget path passes p95; the backup soft
   ceiling is printed. No path regressed vs the recorded baseline.
3. **Index migration** `0027` applied; `PRAGMA integrity_check` + `PRAGMA foreign_key_check` = `ok`.
4. **Backup** the large seed → valid zip → manifest hashes verify → backed-up DB row counts match
   the source. **Restore-mechanics** check follows the T047 contract (format/schema/hash gates).
5. **MVP flow** green against the larger seed, including **app restart → persistence verified**.
6. **Rendering** — the queue / library / trash / maintenance lists render a 10k-row payload
   without freezing (virtualized; bounded DOM rows).
7. **Two-scheduler split** intact — FSRS cards + attention items both surface correctly under load.
8. **Search** — FTS + semantic KNN return the known seeded hits at 100k.
9. **No raw DB/fs to the renderer**; no new `db.query`; the bench/seed run behind the
   local-db/main boundary; the renderer reads only the existing typed `window.appApi` commands.

### Done when

- The app is **load-tested at ~100k cards / ~100k extracts / thousands of sources / long review
  histories** via the `seedLargeCollection` harness; the `scale.bench.ts` benchmark MEASURES every
  hot path (queue calc, FTS search, semantic KNN, review next-pick, analytics, maintenance,
  backup) against **explicit p95 budgets** and passes them (the backup soft ceiling is printed);
  any missing index is added in migration **`0027`** (additive `CREATE INDEX` only); the long-list
  screens are **virtualized**; and the **Scale QA checklist** passes — backup/restore at scale,
  `PRAGMA integrity_check` `ok`, and the **MVP flow green after app restart**.
- The bench runs in CI as a **bounded smoke** (small N) with the **full 100k opt-in / documented
  as a local run**, so the normal `pnpm test` is not bloated; the CI-vs-local split is documented.
- All measurement + seeding stays in `packages/testing` / `packages/local-db` / the Electron main,
  **behind the IPC boundary**; **no raw DB/filesystem access is exposed to the renderer** and no
  generic `db.query`; the FSRS-vs-attention split and lineage are preserved under load.
- `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm bench` (at the documented N), and the
  `scale-smoke` Playwright spec pass. The migration is included; the feature survives **app
  restart**.

### Notes / risks

- **The 1M-row seed feasibility is the one real risk.** Building ~100k cards + ~100k extracts +
  ~1M `review_logs` THROUGH the per-element repository path (a transaction + an `operation_log`
  row each) is too slow to be practical. The harness MUST offer a documented **bulk-insert fast
  path** (batched inserts in one transaction, relaxed pragmas **on the throwaway bench DB only**)
  that writes schema-identical rows, validated against a smoke-sized real-repository control run.
  Be explicit that the bench DB intentionally skips per-row `operation_log` — op-log throughput is
  covered elsewhere. Never run the fast path against the user/dev DB.
- **CI must stay fast.** The full 100k bench takes minutes + hundreds of MB of temp disk —
  **opt-in / local only** (`pnpm bench`). CI runs the bounded `scale-smoke.spec.ts` (a few-thousand
  N) + the bench at a small N. Document the exact commands + reference-machine wall-clock so the
  budgets are reproducible. Budgets are **machine-relative** — pin them to the reference machine in
  the bench header and tune on the first real run rather than guessing.
- **Add only indexes the bench proves slow.** Speculative indexes cost write throughput + DB size.
  The confirmed gaps (`elements(type, created_at)`, `elements(type, due_at)`, `elements(deleted_at)`)
  are the likely additions; let the bench confirm each before committing it. The migration stays
  additive `CREATE INDEX` only — no table rewrite, backward-compatible, restore-safe.
- **Out of scope (the re-scope):** no Tauri shell (T097), no end-to-end-encryption hardening
  (T098), no multi-device sync. "Large PDFs" is a vault/runner concern (bytes never enter SQLite);
  T100's DB matrix is **rows, not blobs**.
- **This is the LAST task (T100).** When it lands, T001–T100 are complete — no further milestone
  spec is generated. The Definition of Done's "survives app restart" + "no raw DB/fs to the
  renderer" + "migration included" apply in full.

---

## Exit criteria for M20

- Both T099 and T100 are `[x]` in [`../roadmap.md`](../roadmap.md) (the FINAL two tasks — the
  roadmap T001–T100 is then complete).
- **Maintainability (T099):** dedup, orphan-media cleanup, broken-source reports,
  cards-without-sources, bulk low-priority postpone/archive, and a DB integrity check keep a 100k
  collection maintainable; reports are read-only, cleanups are transactional + soft-delete /
  undoable, the only hard delete stays `TrashRepository.purge`, and a duplicate-source merge
  re-parents children (never orphans). All reach the renderer only through `maintenance.*` /
  `integrity.*` typed `window.appApi` commands.
- **Performance (T100):** the app is load-tested at ~100k cards / ~100k extracts / thousands of
  sources / long histories via `seedLargeCollection`; the `scale.bench.ts` benchmark measures the
  hot paths against explicit p95 budgets and passes them; any missing index is added in migration
  `0027` (additive); the long-list screens are virtualized; the Scale QA checklist passes
  (backup/restore at scale, `PRAGMA integrity_check` `ok`, MVP flow green after **app restart**).
- The full 100k bench is **opt-in / local** (`pnpm bench`); CI runs a **bounded smoke**
  (`scale-smoke.spec.ts` + a small-N bench), documented; the normal `pnpm test` is not bloated.
- All measurement, seeding, maintenance, and integrity logic lives in `packages/local-db` /
  `packages/testing` / the Electron main — **never** React; **no raw DB/filesystem access is
  exposed to the renderer** and no generic `db.query`; the FSRS-vs-attention split and the
  `card → extract → source_location → source` lineage are preserved under load.
- Every feature **survives an app restart**: the T099 cleanups persist, the `0027` indexes apply,
  and the backups persist on disk.
- `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm bench` (at the documented N), and the M20
  Playwright specs (maintenance; scale-smoke → MVP flow → restart) are green.

**M20 is the final milestone.** When T100 is complete, the roadmap (T001–T100) is done — no
further milestone spec file is generated.
