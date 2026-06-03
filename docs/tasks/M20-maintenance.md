# M20 — Scale & hardening (T099–T100)

Detailed, buildable specs for the **final** milestone. M20 is the **"survives years of real
use"** milestone: it makes a 100k-element collection stay maintainable (T099) and proves the
whole local-first app stays fast, safe, backed up, and searchable at that scale (T100).

This file specs **T099 — Large-collection maintenance tools** in full. T100 (the gold-standard
QA + performance hardening pass) is generated separately; this file only states T099's contract
plus the seam T100 builds on. Per the roadmap re-scope, T100's listed deps **T097 (Tauri) and
T098 (E2E-encryption) are OUT OF SCOPE** for the local-first program — T100 load-tests the
**single-device, on-device** app (native SQLite + filesystem vault + the existing plaintext
backup), with **no Tauri shell and no end-to-end-encryption** in the matrix.

T099 is the **janitor**: a single **Maintenance** view that surfaces a fixed set of **read-only
reports** about a large collection — duplicates, orphan media, broken sources, cards without
sources, DB/vault integrity — each paired with a **confirmable cleanup action**. Every report is
a real query over real tables; every action is a **transactional, op-logged** mutation that is
**soft-delete / undoable** — except the one hard delete that already exists (`TrashRepository.purge`
/ `emptyTrash`) and the one file GC that already exists (`AssetVaultService.collectOrphans`). T099
**composes** the maintenance primitives already built across the roadmap; it invents almost no new
write paths.

The architecture is unchanged and non-negotiable (see [`../../CLAUDE.md`](../../CLAUDE.md) and the
roadmap header): the React **renderer** (`apps/web`) never touches SQLite, Node, or the filesystem.
Every capability flows React UI → typed client wrapper (`apps/web/src/lib/appApi.ts`) → preload
bridge (`apps/desktop/src/preload/index.ts`) → validated IPC (Zod) on the main side
(`apps/desktop/src/main/ipc.ts`) → the `DbService` (`apps/desktop/src/main/db-service.ts`) →
`packages/local-db` repositories/services + `apps/desktop` main services → SQLite + the filesystem
asset vault. **All dedup detection, integrity scanning, and cleanup logic are domain / main-process
functions — never React component code.** Read-only reports append **no** `operation_log` row;
cleanup mutations run in **one transaction**, append an **`operation_log`** row, are **soft-delete
by default** (`deleted_at`), and the only hard deletes stay `TrashRepository.purge`/`emptyTrash`
(elements) and `AssetVaultService.collectOrphans` (vault files). A feature is not done until it
survives an **app restart**.

> **T099 is a COMPOSITION task. The maintenance primitives already exist — this task wires them
> into one report+action surface, adds the two genuinely-new READ-ONLY reports
> (cards-without-sources, broken-source), and a DB integrity report.** Do **not** rebuild dedup,
> orphan GC, vector pruning, retirement, or postpone — call the existing services. The only new
> mutation T099 may introduce is a **bulk wrapper** over the existing per-item soft-delete /
> postpone / retire paths, sharing a single `batchId` so the whole sweep undoes as one (T044).

> **No new element status, no new op type, no new distillation stage.** The closed
> `OPERATION_TYPES` set (15) is unchanged. Bulk low-priority "archive" means **soft-delete**
> (`soft_delete_element`) or **dismiss** (`update_element` → status `dismissed`) or **retire**
> (`update_element` → `cards.is_retired`, T082) — the user picks; T099 mints no `archived` status.
> Bulk postpone reuses `QueueActionService.bulkPostpone` (`reschedule_element`, T044/T030). The
> two-scheduler split holds: a card defers on FSRS (`cardDeferBy`), an attention item reschedules
> on the attention scheduler.

> **The two index-or-schema concerns belong to T100, not T099.** T099 adds **no migration** — every
> report below is covered by an existing index (`elements_source_idx`, `elements_type_status_idx`,
> `cards_source_location_idx`, `sources_canonical_url_idx`, the asset/vault reference set). The
> 100k-scale **index audit + any new partial/covering indexes** (and the load-test harness) are
> **T100**. If a T099 report proves slow at scale, *record it as a T100 finding* — do not add an
> ad-hoc index here. (This keeps the only migration in M20 in T100, where it is load-test-justified.)

Read first:
- [`../../CLAUDE.md`](../../CLAUDE.md) — **"Data rules"** (soft delete / trash / undoable actions;
  `operation_log` from day one; no silent data destruction; the only hard delete is the two-stage
  purge), **"Asset vault"** (the `assets/` layout the orphan/broken-source reports read; the
  renderer never touches files), **"SQLite rules"** (WAL, `foreign_keys`, `integrity_check`),
  **"Scheduling rules"** (the FSRS-vs-attention split the bulk actions must respect),
  **"Priority rules"** (low-priority sacrificed first — the bulk-archive target set).
- [`../domain-model.md`](../domain-model.md) — soft-delete (`deleted_at`), the closed op set,
  lineage (`card → source_location → source`; a "card without a source" is a **lineage gap**, not
  a thing to silently delete — it is surfaced for the user to fix or trash), `derived_from`
  relations.
- [`../scheduling-and-priority.md`](../scheduling-and-priority.md) — overload protection ("don't
  let new material dominate older high-value material") behind the bulk low-priority postpone/archive.
- [`../architecture.md`](../architecture.md) — the layering the maintenance reads/actions must obey
  (no SQL/fs in the renderer; main owns the vault; `packages/local-db` owns the queries).
- [`../design-system.md`](../design-system.md) — the maintenance surface lives in the
  `screen-analytics` "Open maintenance" affordance + the existing maintenance views; reuse
  `Metric`, `Banner`, `EmptyState`, `Status`, `TypeIcon`, the confirm dialog, and the `Snackbar`
  (T044 undo toast) for every cleanup action.

### What already exists (inspect before building — do NOT duplicate)

T099 stands on a deep stack of maintenance primitives built across Parts I and II:

- **Two-stage delete + the only hard delete (T044):** `TrashRepository`
  (`packages/local-db/src/trash-query.ts`): `listTrash()`, `purge(id): boolean`, `emptyTrash():
  { purged }` — the **only** hard `DELETE` in the app (FK cascades + the FTS5 trigger clean up
  dependents; it also drops the element's `vec0` rowid first since the virtual table has no FK).
  Soft-delete is `ElementRepository.softDelete` (`soft_delete_element`, recoverable); restore is
  `ElementRepository.restore`. **Command-level undo** is `UndoService.undoLast` (T044) — it reverses
  the last op (or a whole `batchId` batch). **Every T099 cleanup must route through these — it adds
  no third delete path.**
- **Vault scaling + integrity + orphan GC (T059):** `AssetVaultService`
  (`apps/desktop/src/main/asset-vault-service.ts`):
  - `verifyIntegrity(): VaultIntegrityReport` = `{ ok: number /* COUNT of intact assets, not a boolean */, mismatched: AssetId[], missing: AssetId[],
    extraFiles: string[] }` — re-hashes every live asset's bytes (streamed) vs `assets.content_hash`
    and lists unreferenced on-disk files. **READ-ONLY.**
  - `findOrphans(): OrphanReport` = `{ orphans: OrphanFile[], totalBytes }` — vault files no live
    `assets` row references. **READ-ONLY.**
  - `collectOrphans({ confirm: true, relativePaths? }): { removed, freedBytes }` — removes ONLY
    confirmed-still-unreferenced files. The vault-side hard delete (guarded by `confirm: true`).
  - **Already exposed** over `vault:verify` / `vault:findOrphans` / `vault:collectOrphans`
    (`channels.ts`, `contract.ts`, `ipc.ts`). T099 surfaces these in the Maintenance view; it does
    not re-implement them.
  - `apps/desktop/src/main/backup-service.ts` exports `listFilesRelative(dir)` — the canonical
    on-disk walk (POSIX, leading-slash-free) the vault scans reuse.
- **Vector pruning (T087):** `EmbeddingRepository.pruneOrphanVectors(): number`
  (`packages/local-db/src/embedding-repository.ts`) — drops `element_vectors` rowids with no
  surviving `embeddings` sidecar row (a backstop the explicit `delete` should already prevent; no
  `operation_log`, derived-index only). Degrades to `0` when `vec0` is unavailable. T099's
  orphan-media action runs this AFTER a vault sweep so the semantic index can't drift.
- **Source dedup detection (T061):** `SourceDedupQuery`
  (`packages/local-db/src/source-dedup-query.ts`): `findSourcesByCanonicalUrl(url):
  SourceDuplicateMatch[]` (backed by `sources_canonical_url_idx`) + `findSourceBySnapshotHash(hash):
  SourceDuplicateMatch | null` (cleaned-HTML content hash via `AssetRepository.findByContentHash`).
  **Per-candidate detection** (the URL-import path asks "is THIS page already imported?"). T099
  adds the **collection-wide rollup**: group ALL live sources by canonical URL / snapshot hash and
  list the duplicate clusters. `SourceRepository.findByCanonicalUrl` (T069) is the single-newest
  lookup behind the same index.
- **Per-source yield + read-% (T083):** `SourceYieldQuery`
  (`packages/local-db/src/source-yield-query.ts`) — `listSourceYield(asOf)` ranks low-yield sources;
  reused to *prioritize* which low-value sources the bulk-archive action targets, and its grouped
  descendant tally is the pattern the cards-without-sources scan mirrors.
- **Bulk postpone + per-scheduler defer (T030/T077):** `QueueActionService`
  (`packages/local-db/src/queue-action-service.ts`): `bulkPostpone(ids, now): { elements, batchId }`
  — N rows, ONE shared `batchId`, so the whole sweep undoes as one (T044). `cardDeferBy` /
  `cardDeferTo` (FSRS due only, memory untouched, no review log); `act(id, kind)` for
  delete/dismiss/markDone/raise/lower. `AutoPostponeService` (T077,
  `packages/local-db/src/auto-postpone-service.ts`) is the overload valve (`preview`/`apply`,
  shared `batchId`) — T099's bulk-postpone is the *manual, report-driven* sibling.
- **Mature-card retirement (T082):** `CardRetirementService`
  (`packages/local-db/src/card-retirement-service.ts`): `retire(id)`/`unretire(id)` flip the durable
  `cards.is_retired` flag (`update_element`, reversible, non-destructive, NO `review_states`/
  `review_logs` write). The third "archive" verb for the bulk action (besides soft-delete + dismiss).
- **System analytics (T045):** `AnalyticsService` (`packages/local-db/src/analytics-query.ts`,
  surfaced over `analytics:get`) — the read-only aggregation pattern + the `Metric`/`Banner` screen
  every maintenance report mirrors.
- **The schema + indexes (`packages/db/src/schema/`):** `elements`
  (`elements_source_idx` on `source_id`, `elements_type_status_idx`, `elements_due_idx`,
  `elements_parent_idx`); `cards` (`cards_source_location_idx` on `source_location_id`,
  `cards_is_leech_idx`, `cards_is_retired_idx`, `cards_review_by_idx`); `sources`
  (`sources_canonical_url_idx`); `source_locations`; `element_relations` +
  `element_relations_from_idx` (both in `schema/relations.ts`, **not** an `element-relations.ts`
  file); `assets`; `review_states`
  (`review_states_due_idx`); `review_logs` (`review_logs_reviewed_idx`); `embeddings` + the `vec0`
  `element_vectors`; `operation_log`. **The latest applied migration tag is `0026_reflective_magma`**
  (`packages/db/drizzle/meta/_journal.json`) — T099 adds **no** migration.
- **The `window.appApi` seam (every prior task):** channels (`apps/desktop/src/shared/channels.ts`,
  groups incl. `vault*`, `trash*`, `analytics*`, `sourceYield*`, `cards*`, `queue*`), Zod
  request/result schemas (`apps/desktop/src/shared/contract.ts` + `contract.test.ts`), preload
  (`apps/desktop/src/preload/index.ts`), validated IPC (`apps/desktop/src/main/ipc.ts`), `DbService`
  (`apps/desktop/src/main/db-service.ts` + `db-service.test.ts`), renderer client
  (`apps/web/src/lib/appApi.ts`). **`backupDatabaseTo` already runs `wal_checkpoint(PASSIVE)` +
  `VACUUM INTO`**, and `getStatus` already reads the live pragmas — the DB-integrity report reuses
  the same `sqlite.pragma(...)` access.
- **The maintenance renderer surface:** `apps/web/src/maintenance/` (`LeechRemediation`,
  `RetiredCards`, `StagnantExtracts`) + `apps/web/src/analytics/` (`AnalyticsScreen`, `SourceYield`)
  + `apps/web/src/trash/TrashScreen`, with routes `/maintenance/leeches`, `/maintenance/retired`,
  `/maintenance/stagnant`, `/trash`, `/analytics`, `/analytics/sources` (`apps/web/src/router.tsx`)
  and the "Organize" nav group (`apps/web/src/shell/nav.ts`). T099 adds a `/maintenance` hub that
  links these and hosts the new reports.
- **The testing seam:** `packages/testing/src/factories.ts` (`DEMO_FIXTURES`,
  `seedDemoCollection(repos, db)`) for deterministic fixtures; `packages/local-db/src/test-db.ts`
  (in-memory DB); the Playwright/Electron harness (`tests/electron/`, `launch.ts`,
  `mvp-flow.spec.ts`, `INTERLEAVE_DATA_DIR` override).

### What T099 must add (the gaps)

- **No collection-wide dedup rollup.** `SourceDedupQuery` answers per-candidate; nothing lists
  "these N source clusters are duplicates of each other" across the whole library, and nothing
  reports duplicate **cards** / **extracts**. T099 adds a read-only `DedupReportQuery`.
- **No cards-without-sources report.** Lineage is sacred, but there is no scan that surfaces cards
  whose `source_location_id IS NULL` **and** which have no `derived_from` source ancestor — the
  lineage gaps the user should fix or trash. T099 adds it.
- **No broken-source report.** Nothing lists sources whose snapshot asset row points at a file that
  is **missing on disk** (or whose snapshot asset row is gone entirely) — a source you can no longer
  open. `verifyIntegrity` finds missing *assets*; T099 maps that to the *owning sources*.
- **No DB-integrity report.** `verifyIntegrity` checks the vault; nothing runs SQLite's
  `PRAGMA integrity_check` / `foreign_key_check` and reports it. T099 adds a read-only DB-health
  report (composed with the vault report into one "Integrity" card).
- **No unified Maintenance view + `maintenance.*` surface.** The reports live in scattered services;
  there is no single read that returns all the report *counts* for a hub, and no `maintenance.*`
  IPC group tying the report+action pairs together. T099 adds the hub + the surface.
- **No bulk low-priority archive/postpone over a report.** `bulkPostpone` exists but nothing drives
  it from a "low-priority, stale" candidate list, and there is no bulk soft-delete/dismiss/retire
  wrapper sharing one `batchId`. T099 adds the thin bulk wrappers.

T099 is the sole task in this file. After it lands, generate `tasks/M20-qa-hardening.md` (T100)
from the roadmap before starting T100.

---

## T099 — Large-collection maintenance tools

- **Status:** `[ ]`  · **Depends on:** T044, T083
- **Roadmap line:** Done when: dedup, orphan-media cleanup, broken-source reports,
  cards-without-sources, bulk low-priority postpone/archive, and DB integrity checks keep a
  100k-element collection maintainable.

### Goal

A single **Maintenance** view (reached from the Analytics screen's "Open maintenance" affordance
and the Organize nav) gives the user a janitor's dashboard for a large collection. It surfaces a
fixed set of **read-only reports** — **duplicate sources/cards/extracts**, **orphan media**,
**broken sources**, **cards without sources**, and **DB + vault integrity** — each as a count plus
a drill-down list, and each paired with a **confirmable cleanup action**: dedup → soft-delete the
redundant copies (keeping the canonical one); orphan media → the existing confirmed file GC + vector
prune; broken sources / cards-without-sources → review and soft-delete (or fix lineage); plus a
**bulk low-priority postpone / archive** that recedes or soft-deletes/dismisses/retires the
lowest-value stale material in one undoable batch. Every report is a real domain query (no SQL in
React); every action is one transaction that appends an `operation_log` row, is **soft-delete /
undoable** by default, and routes through the existing `TrashRepository.purge` /
`AssetVaultService.collectOrphans` for the only two hard deletes. A 100k-element collection stays
maintainable: you can find and reclaim the dead weight without ever silently destroying data, and
everything survives an app restart.

### Context to load first

- Reference: `CLAUDE.md` "Data rules" (soft delete / the only hard delete is the two-stage purge;
  `operation_log`; no silent destruction), "Asset vault" (the orphan/broken-source file reads),
  "SQLite rules" (`integrity_check`, `foreign_keys`), "Scheduling rules" + "Priority rules" (the
  bulk-archive target set + the FSRS/attention split); `scheduling-and-priority.md` (overload).
- Existing code to inspect: `trash-query.ts` (`purge`/`emptyTrash`/`listTrash`), `undo-service.ts`
  (`undoLast` over a `batchId`), `asset-vault-service.ts` (`verifyIntegrity`/`findOrphans`/
  `collectOrphans`), `embedding-repository.ts` (`pruneOrphanVectors`), `source-dedup-query.ts`
  (`findSourcesByCanonicalUrl`/`findSourceBySnapshotHash`), `source-repository.ts`
  (`findByCanonicalUrl`), `source-yield-query.ts` (the grouped-rollup pattern + low-yield ranking),
  `queue-action-service.ts` (`bulkPostpone`/`act`/`cardDeferBy`), `card-retirement-service.ts`
  (`retire`), `analytics-query.ts` (the read-only aggregation + screen pattern); the schema
  (`packages/db/src/schema/{elements,cards,sources,embeddings}.ts` + the `assets` table in
  `packages/db/src/schema/system.ts`); `db-service.ts`
  (`backupDatabaseTo`, `getStatus` pragma access — the `integrity_check` read mirrors it); the
  channels/contract/ipc/preload/appApi seam; `apps/web/src/maintenance/*` + `apps/web/src/analytics/
  AnalyticsScreen.tsx` + `apps/web/src/router.tsx` + `apps/web/src/shell/nav.ts`.
- Invariants in play: reports are **read-only** (no mutation, no `operation_log`); cleanup is
  **soft-delete / undoable** with the only hard deletes being `TrashRepository.purge` and
  `AssetVaultService.collectOrphans`; bulk actions share ONE `batchId` so `undoLast` reverses the
  whole sweep; the FSRS-vs-attention split holds in bulk postpone; lineage is sacred — a
  cards-without-sources report **surfaces** a gap, it never auto-deletes the card; **no migration,
  no new op type, no new status/stage**.

### Deliverables

#### Reports (read-only domain queries — each cites real tables)

- [ ] **A `DedupReportQuery` in `packages/local-db`** (`packages/local-db/src/dedup-report-query.ts`,
      exported from `packages/local-db/src/index.ts` + added to `Repositories`/`createRepositories`).
      Read-only, no `operation_log`. Composes `SourceDedupQuery` + `AssetRepository`; returns
      **clusters**, never auto-merges:
      - `duplicateSources(): DuplicateCluster[]` — group **all live `source` elements** (`elements`
        join `sources`, `type='source'`, `deleted_at IS NULL`) by **canonical URL** (over
        `sources_canonical_url_idx`) and, as a backstop, by **cleaned-HTML snapshot content hash**
        (the `assets.content_hash` of each source's `cleaned.html` `source_html` asset, the same
        disambiguation `SourceDedupQuery.findSourceBySnapshotHash` uses). Each cluster with ≥2
        members is one `DuplicateCluster = { key, matchedBy: "canonicalUrl" | "contentHash",
        canonical: SourceRef, duplicates: SourceRef[] }`, where **`canonical` is the keeper** and
        `duplicates` are the redundant copies the action would soft-delete. A source matched by BOTH
        signals appears once (canonical-URL key wins).
        - **Keeper rule (the SAME for both `matchedBy` paths — document + unit-test it as one pure
          helper):** the keeper is the **newest `sources.accessed_at`** — resolved via the
          `elements → sources` join (`accessed_at` lives on `sources` (`schema/sources.ts`), **NOT**
          on `elements`, which has only `created_at`), mirroring `findByCanonicalUrl`'s
          `desc(sources.accessedAt), desc(elements.id)` "newest live" ordering. Because
          `sources.accessed_at` is **nullable**, pin NULL handling deterministically: a
          NULL-`accessed_at` source sorts **last** (a real timestamp always wins over NULL,
          regardless of SQLite's raw NULL ordering under `desc()`), with a stable `desc(elements.id)`
          tiebreak so the keeper is deterministic. The `contentHash` backstop cluster uses this
          identical rule — do not leave it implicit.
      - `duplicateCards(): DuplicateCluster[]` and `duplicateExtracts(): DuplicateCluster[]` —
        group live `card` / `extract` elements by a **normalized content key** (trimmed,
        case-folded, whitespace-collapsed `title` + the prompt/answer / extract body text **where
        available**; document the exact key in the file header — keep it a pure helper so it is
        unit-testable and identical between the two).
        - **Source the body text from the RIGHT substrate per type — they differ:**
          - **Cards:** the body text lives in DEDICATED columns on `cards` — `cards.prompt`,
            `cards.answer`, and `cards.cloze` (`packages/db/src/schema/cards.ts:32-36`) — which are the
            canonical, FTS-indexed source of truth (`search-repository.ts` builds `card_fts` from
            `prompt`/`cloze` folded + `answer`). A card has **no** backing `documents`/`document_blocks`
            row, so the dedup key for a card MUST be built from `cards.prompt + cards.answer +
            cards.cloze` (NOT a `document_blocks` join — that join would find nothing and silently
            degrade to title-only).
          - **Extracts:** the body lives in the ProseMirror document — join the element's `documents`
            → `document_blocks` and concatenate the block text in order.
          - `elements` holds only `title` (no body column). Pin these exact columns in the file header
            so the "title + body" key never silently degrades to **title-only**. If an extract has no
            resolvable document body (or a card has empty prompt/answer/cloze), fall back to the
            `title`-only key (and document that fallback). The conservative **"false-positives
            forbidden"** rule below still governs: when in doubt, do not cluster.
        ≥2 identical-key members → a cluster; keeper = the **oldest**
        (lowest `created_at`, so the original survives and its later re-creations are the dupes — and
        a card keeper additionally prefers the one with the most review history / a non-null
        `source_location_id`, so dedup never sacrifices the better-lineaged/better-learned copy;
        document the tie-break). Cards/extracts have no URL — `matchedBy` is `"contentHash"`
        (content key). Bounded by a `limit` (default 500 clusters) so a pathological collection
        can't return an unbounded payload.
      - `DuplicateReport = { sourceClusters, cardClusters, extractClusters, totalDuplicates }` where
        `totalDuplicates` is the count of *removable* copies (every cluster's `duplicates.length`
        summed) — the hub badge.
- [ ] **A `cardsWithoutSources` report** — add to a new `LineageGapQuery`
      (`packages/local-db/src/lineage-gap-query.ts`, exported + in `Repositories`). Read-only.
      `cardsWithoutSources(limit = 500): LineageGapRow[]` — live `card` elements
      (`type='card'`, `deleted_at IS NULL`) whose `cards.source_location_id IS NULL`
      **AND** which have **no `derived_from` ancestor that resolves to a live `source`** (walk one
      `element_relations` `derived_from` hop from the card; a card may be derived from an extract
      which is derived from a source — so resolve the lineage root, reusing the denormalized
      `elements.source_id` as the cheap first check and the `derived_from` edge as the authoritative
      one). A row that has `source_id` pointing at a live source is NOT a gap. Each
      `LineageGapRow = { card: ElementRef, hasSourceLocation: false, hasSourceAncestor: false,
      createdAt }`. **This report SURFACES a lineage gap for the user to fix or trash — it never
      auto-deletes** (lineage is sacred; a sourceless card may be a hand-authored card the user
      wants). Cites `cards.source_location_id` (`cards_source_location_idx`), `elements.source_id`
      (`elements_source_idx`), and `element_relations` / `element_relations_from_idx` on
      `from_element_id` (both in `schema/relations.ts` — **not** `element-relations.ts`), filtered on
      the column `relationType` (`text('relation_type')`, constrained to `RELATION_TYPES`) `= 'derived_from'`.
- [ ] **A `brokenSources` report** — add to `LineageGapQuery` (same file, same read-only contract).
      `brokenSources(): BrokenSourceRow[]` — live `source` elements whose **snapshot asset is
      missing**: either (a) the source has a `source_html`/PDF snapshot `assets` row whose on-disk
      file is gone, or (b) a source that should have a snapshot has **no snapshot asset row at all**.
      Because the on-disk check needs the filesystem (main-only), this query returns the *candidate*
      set + each source's snapshot `assets` rows (id + relative path), and the **main-side
      composition** (`DbService`/a small `MaintenanceService` in `apps/desktop/src/main/`) joins it
      against `AssetVaultService.verifyIntegrity().missing` (the asset ids whose bytes are absent) to
      produce the final `BrokenSourceRow = { source: SourceRef, reason: "missingFile" |
      "noSnapshot", missingAssetIds: AssetId[] }`. Read-only on both sides. (Keep the SQL in
      `packages/local-db`; the disk check stays in the main `AssetVaultService` — same split as the
      vault reports.)
- [ ] **A DB + vault integrity report (main-side).** Extend the main `DbService` (or a small
      `apps/desktop/src/main/maintenance-service.ts` that composes `DbService` + `AssetVaultService`,
      mirroring how `BackupService` composes them): `checkIntegrity(): IntegrityReport` =
      `{ db: { ok: boolean; integrityCheck: string[]; foreignKeyViolations: number },
      vault: VaultIntegrityReport }`.
      - `db` runs **`PRAGMA integrity_check`** (or the faster `quick_check` — document the choice;
        `integrity_check` is thorough, `quick_check` skips index-consistency and is fine as the
        default for a 100k DB with `integrity_check` available as a deep option) and
        **`PRAGMA foreign_key_check`** (count of violated rows; should be 0 with `foreign_keys = ON`),
        via the SAME `sqlite.pragma(...)` / `sqlite.prepare(...)` access `db-service.ts` already uses
        for `getStatus`/`backupDatabaseTo`. `ok` is `integrityCheck === ["ok"] && foreignKeyViolations
        === 0`. **READ-ONLY** (these pragmas do not mutate).
      - `vault` is `AssetVaultService.verifyIntegrity()` (existing).
      The integrity report is the only one that may run a few seconds on a 100k DB — note it as a
      "Run integrity check" on-demand button (not auto-run on view open), with a spinner.

#### Actions (transactional, op-logged, soft-delete / undoable — the only hard deletes stay purge + collectOrphans)

- [ ] **Dedup cleanup** — a `MaintenanceService` (main-side, `apps/desktop/src/main/
      maintenance-service.ts`) method `dedupeCleanup({ removeIds: ElementId[] }): { trashed: number;
      batchId: string }` that **soft-deletes** the chosen redundant copies (the cluster `duplicates`,
      never the `canonical` keeper) in ONE batch: mint one `batchId`, call
      `ElementRepository.softDelete` per id within it (each appends `soft_delete_element` carrying the
      `batchId` + the status pre-image so `undoLast` reverses the whole sweep, per T044). It
      **validates** each id is actually a non-canonical duplicate in the current report before
      deleting (re-run the dedup detection; never trust a stale renderer id — a keeper must never be
      trashed). Reversible via Trash + command-level undo. **No merge, no hard delete.** (Merging two
      sources' children under one keeper is explicitly out of scope — note it as a future refinement;
      T099 only removes the redundant copies the user confirms.)
- [ ] **Orphan-media cleanup** — `orphanMediaCleanup({ confirm: true, relativePaths? }): { removed:
      number; freedBytes: number; vectorsPruned: number }` that calls the EXISTING
      `AssetVaultService.collectOrphans({ confirm: true, relativePaths })` (the confirmed file GC)
      and THEN `EmbeddingRepository.pruneOrphanVectors()` so the semantic index can't drift. Guarded
      by `confirm: literal(true)`. This is the vault-side hard delete that already exists — T099 only
      composes the vector prune after it.
- [ ] **Broken-source / cards-without-source cleanup** — both route through the **existing**
      soft-delete + Trash. The action is `bulkSoftDelete({ ids, kind: "trash" }): { trashed; batchId }`
      (a thin shared batch wrapper, below). For broken sources the user may instead **re-import**
      (out of scope — link to the existing URL/PDF import) or trash; for sourceless cards the user
      may **fix lineage** (out of scope — they open the card to attach a source) or trash. T099 only
      provides the trash action; the "fix" affordances are navigation to existing screens.
- [ ] **Bulk low-priority postpone / archive** — a `bulkLowPriority` report + action pair:
      - report: `LineageGapQuery`/a `MaintenanceService` `lowValueCandidates({ asOf, limit }):
        LowValueRow[]` — live, **low-priority** (`priority` in the C/D band via the `@interleave/core`
        `priorityToLabel` helper) items that are **stale** (no recent activity — reuse the
        `SourceYieldQuery` `lastActivityAt` / the existing stagnation signal, or simply
        `updated_at` older than a documented threshold), ranked lowest-value first (reuse
        `SourceYieldQuery`'s low-yield ranking for sources). Read-only.
      - action `bulkPostpone({ ids, asOf }): { postponed; batchId }` → the EXISTING
        `QueueActionService.bulkPostpone` (one `batchId`; cards defer on FSRS via `cardDeferBy`,
        attention items reschedule on the attention scheduler — the split is already correct there).
      - action `bulkArchive({ ids, mode: "trash" | "dismiss" | "retire" }): { archived; batchId }` —
        a thin batch wrapper minting ONE `batchId` and routing per id: `trash` →
        `ElementRepository.softDelete`; `dismiss` → `ElementRepository.update(id, { status:
        "dismissed" })`; `retire` → `CardRetirementService.retire(id)` (cards only; a non-card with
        `retire` is skipped/errors clearly). Every per-id mutation appends its existing op
        (`soft_delete_element` / `update_element`) carrying the `batchId` so `undoLast` reverses the
        whole sweep. **No `archived` status is minted** — "archive" is one of these three existing,
        reversible verbs.
- [ ] **A `bulkSoftDelete` / shared batch helper** — extend `QueueActionService` (or a small
      `BulkActionService` in `packages/local-db`) with `bulkSoftDelete(ids, now): { elements;
      batchId }` mirroring the existing `bulkPostpone` shape (one `batchId`, skip missing/deleted
      ids, each appends `soft_delete_element` with the `batchId` + status pre-image). Reuse it for
      dedup cleanup, broken-source trash, and `bulkArchive` `trash` mode. **Confirm the
      `soft_delete_element` payload carries `batchId` + the status pre-image** (T044 already enriched
      `softDelete`/`updateWithin`/`rescheduleWithin` pre-images; verify the `batchId` threads
      through — if `softDelete` lacks a `batchId` param, add it as an optional arg, a payload
      enrichment within the closed op set, NOT a migration/new op type).

#### IPC + renderer

- [ ] **A `maintenance.*` `window.appApi` surface** across the established seam, Zod-validated:
      - channels (`channels.ts`): `maintenanceReport` (`maintenance:report` — one read returning all
        report **counts** + the integrity-not-yet-run flag for the hub), `maintenanceDuplicates`
        (`maintenance:duplicates`), `maintenanceCardsWithoutSources`
        (`maintenance:cardsWithoutSources`), `maintenanceBrokenSources` (`maintenance:brokenSources`),
        `maintenanceIntegrity` (`maintenance:integrity` — the on-demand deep check),
        `maintenanceLowValue` (`maintenance:lowValue`), and the actions `maintenanceDedupe`
        (`maintenance:dedupe`), `maintenanceOrphanMedia` (`maintenance:orphanMedia`),
        `maintenanceBulkPostpone` (`maintenance:bulkPostpone`), `maintenanceBulkArchive`
        (`maintenance:bulkArchive`), `maintenanceBulkTrash` (`maintenance:bulkTrash`). (Reuse the
        existing `vault:*` channels for the raw vault verify/orphans where the hub just re-displays
        them; the new channels are the *maintenance-composed* reads/actions.)
      - contract (`contract.ts` + `contract.test.ts`): Zod request schemas + result types for each.
        The destructive actions take explicit id lists / `confirm: z.literal(true)` (orphan media) /
        a bounded `mode` enum (`bulkArchive`); reuse `ElementIdSchema` for element-id lists. (There
        is **no `AssetIdSchema`** and none is needed — no asset id crosses IPC: orphan media takes
        canonical relative paths, the report reads take `{ asOf?, limit? }`, and
        `BrokenSourceRow.missingAssetIds: AssetId[]` is a *result-type* field only, never a request
        input. Do not invent an asset-id-over-IPC path.) **No generic `db.query`; no raw filesystem
        path crosses IPC** (orphan media takes canonical relative paths the prior `vault:findOrphans`
        returned).
      - preload (`preload/index.ts`): a `maintenance` group.
      - IPC router (`ipc.ts`): validated handlers delegating to `DbService`/`MaintenanceService`.
      - `DbService`/`MaintenanceService` (`db-service.ts` + `db-service.test.ts`): the composing
        methods (the report reads delegate to `packages/local-db` queries; the integrity + broken-
        source + orphan-media + bulk actions compose the main `AssetVaultService` + the local-db
        services). The renderer never instantiates a service.
      - renderer client (`apps/web/src/lib/appApi.ts`): a `maintenance` group + the result types.
- [ ] **A `/maintenance` hub route + `MaintenanceScreen`** (`apps/web/src/router.tsx` + e.g.
      `apps/web/src/maintenance/MaintenanceScreen.tsx` + a css module), the janitor dashboard: one
      `Metric`/`Banner` card per report (Duplicates N · Orphan media N files / X MB · Broken sources
      N · Cards without sources N · Low-value candidates N · Integrity: Run check), each expanding to
      its drill-down list with a **confirmable** cleanup action (a confirm dialog for every
      destructive action; a `Snackbar` "Undo" after every reversible one, wired to
      `appApi.undo.last()`). Reuse `Metric`/`Banner`/`EmptyState`/`Status`/`TypeIcon`/the confirm
      dialog/`Snackbar` from the design kit; match the existing maintenance screens' structure
      (`LeechRemediation`/`RetiredCards`/`StagnantExtracts`). Wire the Analytics screen's "Open
      maintenance" affordance + add a "Maintenance" entry to the Organize nav (`shell/nav.ts`)
      pointing at `/maintenance`; the existing `/maintenance/leeches|retired|stagnant` views link
      from the hub. The hub does NOT auto-run the deep integrity check (on-demand button only).

#### Tests

- [ ] **Unit (Vitest, `packages/local-db`)** — one per report + action, against `test-db.ts`
      (in-memory) seeded via `packages/testing` factories:
      - `dedup-report-query.test.ts`: two live sources sharing a canonical URL → one
        `sourceClusters` cluster, `canonical` = newest `sources.accessed_at`, `duplicates` = the
        rest; a content-hash backstop cluster when two sources have the same cleaned-HTML hash but
        different canonical URLs — **assert the SAME keeper rule** for the hash case (`canonical` =
        newest `sources.accessed_at`) and **assert a NULL-`accessed_at` member never becomes the
        keeper** when a real-timestamp sibling exists (pin the nullable-column ordering for both
        `matchedBy` paths); soft-deleted sources are excluded; two cards with the identical
        normalized content key → a `cardClusters` cluster, keeper = oldest / better-lineaged;
        non-duplicates produce no cluster; `totalDuplicates` counts removable copies only; the
        cluster cap holds.
      - `lineage-gap-query.test.ts`: a card with `source_location_id` set → NOT a gap; a card with
        `source_id` → a live source → NOT a gap; a hand-authored card with neither → a
        `cardsWithoutSources` row; a card derived (via `derived_from`) from an extract derived from a
        live source → NOT a gap (the lineage walk resolves the root); a broken-source candidate
        (source with a snapshot asset row) is returned for the main-side disk join; `lowValueCandidates`
        returns only low-priority stale items, lowest-value first.
      - the bulk action(s): `bulkSoftDelete`/`bulkArchive` mint ONE `batchId`, soft-delete/dismiss/
        retire each id with the existing op carrying the `batchId`, skip missing ids, and the whole
        batch reverses with `UndoService.undoLast` (every item live again with its prior status);
        `dedupeCleanup` refuses to trash a `canonical` keeper / a stale non-duplicate id;
        `bulkPostpone` defers cards on FSRS + reschedules attention items (the split) under one batch.
      - integrity: `pruneOrphanVectors` is invoked after the vault GC in `orphanMediaCleanup`
        (assert no orphan `element_vectors` rowid remains); `checkIntegrity` returns `db.ok = true`
        + `vault` report on a healthy seeded DB.
- [ ] **Unit (Vitest, `apps/desktop` main):** `MaintenanceService.brokenSources` joins the SQL
      candidate set with `AssetVaultService.verifyIntegrity().missing` (a source whose snapshot file
      is deleted on disk under a temp `INTERLEAVE_DATA_DIR` appears as `reason: "missingFile"`; a
      source with no snapshot row appears as `reason: "noSnapshot"`); `checkIntegrity` runs the
      pragmas (corrupt the FKs via a direct insert with `foreign_keys` momentarily off in the test
      and assert `foreignKeyViolations > 0`, or assert the healthy `["ok"]` path); the orphan-media
      action requires `confirm: true` and composes `collectOrphans` + `pruneOrphanVectors`.
- [ ] **Unit (Vitest, `DbService` + contract):** every `maintenance.*` handler round-trips its Zod
      schema; the destructive ones reject a missing `confirm`/an out-of-enum `mode`; the report
      reads return the typed payloads (`contract.test.ts` + `db-service.test.ts`).
- [ ] **Component (Vitest, renderer):** `MaintenanceScreen` renders each report card from a mocked
      `maintenance.report` payload; expanding a report lists its rows; a cleanup action prompts a
      confirm and calls the right command; the `Snackbar` "Undo" appears after a reversible action;
      the empty case shows `EmptyState` ("Nothing to clean up"); the integrity card runs on demand.
- [ ] **Playwright E2E** (`tests/electron/maintenance.spec.ts`): on a seeded collection containing a
      **duplicate source pair**, an **orphan vault file**, a **broken source** (its snapshot file
      removed on disk), a **sourceless card**, and some **low-priority stale items**, open
      `/maintenance` → each report shows the expected non-zero count → run **dedup cleanup** → the
      redundant source moves to `/trash` and the canonical one remains → press the `Snackbar` "Undo"
      (or open `/trash` + Restore) → the duplicate returns → run **orphan-media cleanup** (confirm)
      → the orphan file is gone and `vault:findOrphans` returns empty → run **bulk low-priority
      archive** → the stale low-priority items recede/leave the queue as one undoable batch → run the
      **integrity check** → it reports `ok` → **restart the Electron app** → the trash + the
      reclaimed-space + the archived state persist correctly, and a re-opened Maintenance view shows
      the updated counts.
- [ ] **Fixtures/seed:** extend `packages/testing/src/factories.ts` (or a dedicated maintenance
      fixture) with a `seedMaintenanceCollection(repos, db, paths?)` helper that plants the
      duplicate/orphan/broken/sourceless/low-value rows the unit + e2e tests need, deterministically.
      (A large-collection / 100k seed for *performance* is **T100**'s concern — T099's fixtures are
      correctness-sized.)
- [ ] **Docs:** check the roadmap T099 box `[x]` with the commit; note (for T100) any report that
      should be load-tested + any index that *looked* like it might be missing at scale (record as a
      T100 finding — do **not** add an index in T099).

### Done when

- A **Maintenance** view surfaces **dedup** (duplicate sources/cards/extracts), **orphan-media
  cleanup**, **broken-source** reports, **cards-without-sources**, **bulk low-priority
  postpone/archive**, and **DB + vault integrity checks**, each as a read-only report paired with a
  confirmable cleanup action — so a 100k-element collection stays maintainable.
- Every report is a real domain query over real tables (`elements`/`cards`/`sources`/
  `source_locations`/`assets`/`embeddings`/`operation_log`) in `packages/local-db` / the main
  `AssetVaultService` — **never SQL in React**; reports append **no** `operation_log` row.
- Every cleanup action is one transaction that appends the correct existing `operation_log` op, is
  **soft-delete / undoable** (bulk actions share ONE `batchId` so `undoLast` reverses the whole
  sweep), and the ONLY hard deletes remain `TrashRepository.purge`/`emptyTrash` (elements) and
  `AssetVaultService.collectOrphans` (vault files, `confirm: true`) + `pruneOrphanVectors`
  (derived index). A cards-without-sources report **surfaces** the lineage gap — it never
  auto-deletes; lineage stays sacred.
- The two-scheduler split holds in bulk postpone (cards defer on FSRS, attention items on the
  attention scheduler); **no new op type, no new element status/stage, no migration**.
- All new capabilities reach the renderer **only** through the typed `window.appApi.maintenance.*`
  commands (+ the existing `vault.*`/`trash.*`/`undo.*`) with Zod-validated IPC; **no raw
  DB/filesystem access and no generic `db.query` is exposed to the renderer**.
- Everything **survives an app restart**: the trash + reclaimed space + archived state persist and
  the Maintenance counts recompute from durable tables.
- `pnpm typecheck`, `pnpm test`, `pnpm lint`, and the `tests/electron/maintenance.spec.ts`
  Playwright spec pass.

### Notes / risks

- **Composition over invention.** The single biggest risk is re-implementing what exists — dedup
  detection (`SourceDedupQuery`), vault GC (`AssetVaultService.collectOrphans`), vector prune
  (`pruneOrphanVectors`), retirement (`CardRetirementService`), bulk postpone
  (`QueueActionService.bulkPostpone`). T099 must **call** these; the genuinely-new code is the three
  read-only reports (dedup rollup, cards-without-sources, broken-source) + the integrity composition
  + thin bulk wrappers + the hub. Keep the new SQL small and indexed.
- **Never trash a keeper.** Dedup cleanup must re-validate ids against a fresh detection before
  soft-deleting — a stale renderer id, or a flipped keeper, must never trash the canonical copy. The
  canonical keeper rule (newest `sources.accessed_at` source — NULLs sort last — / oldest+best-
  lineaged card) is a documented pure helper, identical for both `matchedBy` paths, unit-tested.
- **Lineage gaps are surfaced, not auto-fixed.** A sourceless card may be intentional (a
  hand-authored card). The report exists so the user can *decide* (attach a source, or trash). T099
  provides the trash action and navigation to fix; it never auto-deletes a sourceless card.
- **The content-key for card/extract dedup is a heuristic** — pin it precisely (the normalization +
  the keeper tie-break) in the file header and the test, so it is conservative (false negatives are
  fine — a missed near-duplicate; false positives are NOT — never cluster two genuinely-different
  cards). Fuzzy/semantic dedup (KNN over `element_vectors`) is a deliberate **non-goal** here; the
  content-hash/key exact match is the safe MVP. Note semantic dedup as a possible future refinement.
- **Integrity check cost.** `PRAGMA integrity_check` on a 100k-row DB can take seconds — make it an
  on-demand button with a spinner, not an on-open auto-run; offer `quick_check` as the default and
  `integrity_check` as the deep option (document). It is read-only.
- **No migration in T099.** Every report is covered by an existing index. The 100k-scale index audit
  + any new index + the load-test harness are **T100** (where the only M20 migration, if any, lives,
  load-test-justified). If a T099 report is slow on the correctness fixtures, record it as a T100
  finding rather than adding a speculative index here.
- **Bulk-archive `retire` is cards-only.** A non-card passed with `mode: "retire"` is skipped with a
  clear error (the two-scheduler split: retirement is an FSRS-card attribute). `trash`/`dismiss`
  apply to any element type.
- Merging a duplicate source's children under the keeper (re-parenting extracts/cards) is **out of
  scope** — T099 removes the redundant copies the user confirms; lineage-preserving merge is a noted
  future refinement.

---

## Exit criteria for M20 (T099 portion)

- T099 is `[x]` in [`../roadmap.md`](../roadmap.md) with its commit recorded.
- A **Maintenance** hub surfaces all six report families (dedup, orphan media, broken sources,
  cards without sources, bulk low-priority postpone/archive, DB + vault integrity), each a read-only
  domain query paired with a confirmable, **soft-delete/undoable** cleanup action; the only hard
  deletes remain the existing two-stage `purge`/`emptyTrash` and the vault `collectOrphans` (+ the
  derived-index `pruneOrphanVectors`).
- All maintenance logic lives in `packages/local-db` (queries + bulk wrappers) and the
  `apps/desktop` main process (`MaintenanceService` composing `AssetVaultService` + `DbService` +
  the local-db services) — **never** in React; the renderer reaches it only through typed
  `window.appApi.maintenance.*` (+ existing `vault.*`/`trash.*`/`undo.*`) with Zod IPC, no
  `db.query`, no raw paths.
- No new op type, no new element status/stage, no migration; lineage stays sacred (gaps are
  surfaced, not auto-deleted); the FSRS-vs-attention split holds; everything survives app restart.
- `pnpm typecheck`, `pnpm test`, `pnpm lint`, and the maintenance Playwright spec are green.

When T099 is complete, generate `tasks/M20-qa-hardening.md` (T100) from the roadmap before starting
T100. T100 load-tests this LOCAL-FIRST app (100k cards / 100k extracts / thousands of sources /
large PDFs / long histories) and optimizes indexes / rendering / search / queue calc /
backup-restore — with **no Tauri shell (T097) and no end-to-end-encryption (T098)** in scope, per
the roadmap re-scope. The 100k index audit + the only M20 migration (if any) belong there.
