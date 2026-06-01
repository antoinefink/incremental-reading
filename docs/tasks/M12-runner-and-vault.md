# M12 — Local background runner & asset-vault scaling (T058–T059)

Detailed, buildable specs for the two **on-device infrastructure** tasks of M12. After these
two tasks the desktop app has (a) a **100% local background job runner** — an Electron
`utilityProcess` worker with a typed `Job` model + a **persisted** queue, progress/result/error
reporting back to main, retry/failure handling, and resume-or-re-enqueue on **app restart** —
that runs heavy/async work (starting with URL fetch+snapshot) OFF the main thread without ever
corrupting the main-owned SQLite connection; and (b) a **scaled filesystem asset vault** — a
streamed (chunked) write-and-hash path for large binaries (no whole-file-in-memory),
content-hash dedup on write, integrity verification, and safe orphan GC — all behind
`AssetRepository` + a typed `window.appApi` surface.

> **Re-scope vs. the original roadmap.** These two tasks were **re-scoped local-first**
> ([`../roadmap.md`](../roadmap.md) lines ~217–223, M12 header). **T058 is NOT pg-boss, NOT a
> server worker, NOT a network service** — it is an on-device Electron utility process /
> `worker_threads` job runner; "everything is done locally; nothing is sent to a server."
> **T059 is NOT app-facing S3** — the canonical asset store stays the local filesystem vault;
> object storage exists ONLY inside the future encrypted-backup server (T052, out of scope
> here), holding opaque archives. Both honor the local-first invariant: native SQLite is the
> canonical local DB, the filesystem is the canonical local asset vault, the renderer never
> touches SQLite/Node/fs (only `window.appApi`), and everything survives an **app restart**.

Everything here obeys the established architecture (see [`../../CLAUDE.md`](../../CLAUDE.md) +
[`../architecture.md`](../architecture.md)):

```txt
React UI (renderer)                          ← observes job state only, never runs jobs
  → typed client API wrapper (appApi.ts)
  → Electron preload bridge (window.appApi)  ← narrow typed surface; named-event subscriptions
  → Electron main / DB service (validated IPC) ← OWNS the single SQLite writer + the runner host
  → JobRunner (utilityProcess) + JobsRepository + AssetRepository (packages/local-db)
  → SQLite + filesystem asset vault
```

The single load-bearing rule for T058: **SQLite is single-writer-owned by the Electron MAIN.**
The runner does heavy/async work off-main (fetch, OCR later, embeddings later, cleanup) but
**never opens the DB itself** — it posts results/progress back to main over the
`utilityProcess` message channel, and **main** commits transactionally through the existing
repositories (which already append `operation_log` for domain mutations). The runner is a
trusted main-side capability; the renderer only **observes** job state through `window.appApi`.

Read first:
- [`../architecture.md`](../architecture.md) — the **"On-device background runner"** note
  (lines ~77–79: "a **local** Electron utility process / `worker_threads` queue, **not** a
  server worker. `pg-boss` is not used."), the monorepo layout note "No apps/worker: on-device
  jobs (import/OCR/embeddings/AI) run in desktop's local runner" (line ~111), the **"Asset
  vault (Electron-managed)"** section (lines ~173–188: layout + "SQLite stores stable asset
  IDs, relative paths, content hashes, MIME types, sizes…"), and the SQLite rules (lines
  ~160–171: WAL, single app-data DB, "No large blobs in SQLite").
- [`../domain-model.md`](../domain-model.md) — the `Asset` / `AssetLocation` / `LocalVaultPath`
  bridge types (lines ~81–98), the `assets` table columns (line ~135), and the `operation_log`
  shape + "every meaningful mutation is command-shaped" rule (lines ~137–166).
- [`../../CLAUDE.md`](../../CLAUDE.md) — "Electron runtime & security" (utility-process/IPC
  rules, no raw fs/SQLite to the renderer), "Asset vault", "Data rules" (soft-delete, never
  silently destroy user data, the closed `operation_log` vocabulary).
- Spec contract: [`_TEMPLATE.md`](./_TEMPLATE.md) (REQUIRED shape). Format/depth exemplars:
  [`M2-capture-and-inbox.md`](./M2-capture-and-inbox.md) and the sibling
  [`M12-web-import.md`](./M12-web-import.md) (the `UrlImportService` it built is the **candidate
  first async job** T058 wires up end-to-end — match its structure and depth).

What already exists (confirmed by inspecting the repo — **do not rebuild these**):
- **The Electron main lifecycle** in
  [`../../apps/desktop/src/main/index.ts`](../../apps/desktop/src/main/index.ts):
  `app.whenReady().then(bootstrap)` (~line 165); `bootstrap()` opens the DB
  (`dbService.open(paths.dbPath, { migrationsDir, nativeBinding, assetsDir, allowLoopbackImport })`,
  ~line 59), constructs the `CaptureController` (~line 116), and
  `registerIpcHandlers(dbService, { paths, migrationsDir, captureController })` (~line 123);
  `app.on("will-quit", …)` (~line 184) stops the capture server, calls `disposeIpc?.()`, then
  `dbService.close()`. **This is the lifecycle the runner hooks into** — start on `whenReady`,
  drain/persist + terminate on `will-quit`.
- **The main-owned SQLite connection + repositories** in
  [`../../apps/desktop/src/main/db-service.ts`](../../apps/desktop/src/main/db-service.ts):
  `DbService.open(dbPath, options)` (~line 260) opens `better-sqlite3` via
  `@interleave/db.openDatabase` (WAL + `foreign_keys=ON` + `busy_timeout=5000`), runs
  migrations, builds `createRepositories(this.handle.db)` (~line 278), and lazily builds
  `UrlImportService` behind the public `get urlImportService()` accessor (~line 704). `close()`
  (~line 314) tears it all down. The `handle.db` is the **only** SQLite writer.
- **`UrlImportService`** in
  [`../../apps/desktop/src/main/url-import-service.ts`](../../apps/desktop/src/main/url-import-service.ts):
  `async importFromUrl(input)` (~line 209) does the network fetch (`fetchPage`, ~line 328 —
  timeout/SSRF guard/size cap/non-HTML reject) then `runPipeline` (~line 421 — Readability →
  sanitize → HTML→PM → write `original.html`/`cleaned.html` to the vault → one transaction).
  **Today this whole method runs INLINE in main** (`DbService.importFromUrl`, ~line 728, is
  `await`-ed from the IPC handler — the fetch blocks on the main event loop). T058 moves the
  **fetch** portion onto the runner; the **DB write stays in main**.
- **The typed IPC seam**: channels
  [`../../apps/desktop/src/shared/channels.ts`](../../apps/desktop/src/shared/channels.ts)
  (`IPC_CHANNELS` map ~line 11; `sourcesImportUrl: "sources:importUrl"` ~line 27); contract
  [`../../apps/desktop/src/shared/contract.ts`](../../apps/desktop/src/shared/contract.ts) (the
  `AppApi` `sources` group ~line 2615; `InboxItemSummary` ~line 792; the discriminated
  `SourcesImportUrlResult` ~line 860); router
  [`../../apps/desktop/src/main/ipc.ts`](../../apps/desktop/src/main/ipc.ts)
  (`registerIpcHandlers`, the async `sourcesImportUrl` handler ~line 195, the async
  `backupsCreate` handler ~line 450, and the `IpcHandlerContext` paths plumbing ~line 86);
  preload [`../../apps/desktop/src/preload/index.ts`](../../apps/desktop/src/preload/index.ts)
  (`sources.importUrl` ~line 110, AND the **named-event subscription pattern**
  `menu.onShowShortcuts`/`onCreateBackup` ~lines 223–235 — `ipcRenderer.on(channel, listener)`
  returning an unsubscribe fn, the EXACT pattern the runner's progress/observe surface reuses);
  renderer client [`../../apps/web/src/lib/appApi.ts`](../../apps/web/src/lib/appApi.ts).
- **`AppPaths` + the vault skeleton** in
  [`../../apps/desktop/src/main/paths.ts`](../../apps/desktop/src/main/paths.ts): `assetsDir`
  (`<dataDir>/assets`, ~line 36); `ensureVaultSkeleton` already creates `assets/sources/` +
  `assets/media/` (~lines 75–88). The vault layout (`assets/sources/<source_id>/`,
  `assets/media/<asset_id>/`) is in [`../../CLAUDE.md`](../../CLAUDE.md) + architecture.md ~line
  180.
- **`AssetRepository`** in
  [`../../packages/local-db/src/asset-repository.ts`](../../packages/local-db/src/asset-repository.ts):
  `create(input)` / `createWithin(tx, input)` (~lines 48–81, metadata only — bytes written
  separately by main), `findById` (~line 84), `listForElement`/`listForElementByKind` (~lines
  90–107), and **`findByContentHash(contentHash)`** (~line 110 — the existing hash-based dedup
  lookup; the prompt's "findByHash"). The `assets` table
  ([`../../packages/db/src/schema/system.ts`](../../packages/db/src/schema/system.ts) ~lines
  27–60) has `id, owning_element_id, kind, vault_root, relative_path, content_hash, mime, size,
  width, height, duration_ms, created_at`, with `assets_content_hash_idx` (~line 58) +
  `assets_owning_element_idx` (~line 57) + an `onDelete: "cascade"` FK to `elements`.
- **The hashing precedent** in
  [`../../apps/desktop/src/main/backup-manifest.ts`](../../apps/desktop/src/main/backup-manifest.ts):
  `sha256(bytes: Buffer)` (~line 88) + `sha256File(path)` (~line 93, `node:crypto` over a
  `readFileSync` — the WHOLE-FILE read T059 replaces with a streamed hash for large binaries),
  used by `BackupService`
  ([`../../apps/desktop/src/main/backup-service.ts`](../../apps/desktop/src/main/backup-service.ts))
  which already walks + hashes the vault (the module-level `export function listFilesRelative` ~line 99).
- **ID minting** in [`../../packages/local-db/src/ids.ts`](../../packages/local-db/src/ids.ts)
  (`newRowId()` / `newElementId()` / `nowIso()` — UUID v4; the single mint point) and
  [`../../packages/local-db/src/index.ts`](../../packages/local-db/src/index.ts) (the
  `Repositories` interface ~line 180 + `createRepositories` ~line 218 — where a new
  `JobsRepository` is registered).
- **The closed `operation_log` vocabulary** in
  [`../../packages/core/src/operation-log.ts`](../../packages/core/src/operation-log.ts)
  (`OPERATION_TYPES` ~line 23 — 15 entries; renaming/adding is "a migration"). **Jobs do NOT
  add op types** (see T058 notes): the job lifecycle is infrastructure, not a domain mutation;
  a job that mutates domain data does so through the existing repositories, which already log
  the right existing op (`create_source`/`update_document`/…).
- **The bundler** in [`../../apps/desktop/build.mjs`](../../apps/desktop/build.mjs): esbuild
  bundles `src/main/index.ts → dist/main.cjs` and `src/preload/index.ts → dist/preload.cjs`
  (CJS, node22), externalizing ONLY `electron`/`bindings`/`prebuild-install`. **A
  `utilityProcess` worker needs its OWN bundled entry file** — this is the central T058
  bundling deliverable (a third esbuild target → `dist/job-worker.cjs`); the worker must NOT be
  a stray un-bundled `.ts`.

Build order is the task order; **T059 depends on T058** (T059's integrity-verify + orphan-GC
are exposed as runner jobs as well as direct `window.appApi` commands, and the runner must
exist first). T058 wires ONE real job end-to-end (the URL-import fetch) to prove the runner is
real, not theoretical.

---

## T058 — Local background runner

- **Status:** `[ ]` not started  · **Depends on:** T050 (the packaged-app discipline:
  `app.isPackaged` gating, the self-contained `dist/` bundle, the `INTERLEAVE_DATA_DIR`
  override). Also builds directly on T060's `UrlImportService` (the first job moved onto the
  runner) — that is already shipped, so it is a concrete dependency in practice even though the
  roadmap line predates it.
- **Roadmap line:** Done when an on-device background runner (an Electron utility process /
  `worker_threads` queue — **not** a server worker, **not** pg-boss) processes local jobs: URL
  fetch/snapshot, OCR, embeddings, AI calls, cleanup; the main process can enqueue a job and
  observe progress/completion. All work runs locally; nothing is sent to a server.

### Goal

The desktop app gains a **100% on-device background job runner**. The Electron **main** process
can `enqueue` a typed `Job` (e.g. "fetch + snapshot this URL"); the job runs in a separate
Electron **`utilityProcess`** worker (off the main thread, so a slow fetch or future OCR/embed
never freezes the UI or blocks the SQLite writer); the worker reports **progress**, then a
**result** or a typed **error**, back to main over the process message channel; **main** applies
the result by committing through the existing repositories (the worker never opens SQLite). The
queue is **persisted** in a new `jobs` SQLite table, so an in-flight job **survives an app
restart** — on the next launch the runner **resumes pending/queued jobs and safely re-enqueues
any job that was `running` when the app died** (at-least-once; jobs are idempotent or
dedup-guarded so a re-run never double-creates). Failed jobs **retry with backoff** up to a cap,
then land in a terminal `failed` state with the error recorded. The **renderer** never runs a
job — it only **observes** job state (enqueue an import, watch its progress, see it complete)
through the narrow typed `window.appApi.jobs.*` surface. To prove the runner is real, T058
**moves the URL-import fetch onto it end-to-end**: `window.appApi.sources.importUrl` enqueues a
`url_import` job, the worker fetches the page off-main, posts the bytes back, and main runs the
existing `UrlImportService` snapshot+createSource pipeline.

### Context to load first

- Reference: [`../architecture.md`](../architecture.md) (the on-device-runner note + the
  "no apps/worker" layout note), [`../../CLAUDE.md`](../../CLAUDE.md) (Electron runtime &
  security, SQLite single-writer + WAL rules, the closed `operation_log` vocabulary, soft-delete
  data rules), [`../domain-model.md`](../domain-model.md) (the op-log shape).
- Existing code to inspect: `index.ts` lifecycle (`bootstrap`/`will-quit`), `db-service.ts`
  (`open`/`close`, `handle.db`, `urlImportService` accessor), `url-import-service.ts`
  (`importFromUrl` → `fetchPage` + `runPipeline` — the fetch to move off-main), `ipc.ts` (the
  async `sourcesImportUrl` + `backupsCreate` handler shape + `IpcHandlerContext`), the preload
  named-event pattern (`menu.onShowShortcuts`), `channels.ts`/`contract.ts`, `build.mjs` (the
  esbuild targets — add the worker entry), `ids.ts` + `local-db/src/index.ts`
  (`createRepositories`/`Repositories`), `packages/db/src/schema/system.ts` (the table-module
  shape to mirror for a new `jobs` table) + `packages/db/drizzle/` (migrations; next index is
  `0007_*`).
- Invariants in play: **SQLite is single-writer-owned by main** — the worker NEVER opens the DB
  (no `better-sqlite3` in the worker; it does pure compute + I/O and posts results back); DB
  writes stay in main and run in transactions through the existing repositories; **everything
  survives app restart** (the queue is persisted, in-flight jobs resume or safely re-enqueue);
  the runner is a TRUSTED main-side capability — the renderer only observes via `window.appApi`,
  never runs a job and never sees raw worker messages; the `operation_log` vocabulary stays
  closed (jobs are infra, not a domain op); soft-state only (a cancelled/failed job is recorded,
  never silently dropped).

### Runner mechanism decision (pick + justify — REQUIRED in the spec, build to it)

Build the runner as an **Electron `utilityProcess`** worker (one persistent child process the
main spawns at startup), **not** `worker_threads`, and **not** any server/`pg-boss`. Justify
exactly this way in the code's module docblock:

- **`utilityProcess` over `worker_threads`:** the worker must be cleanly isolated from the
  Electron main's V8 heap and event loop (a hostile/huge fetch or a future native OCR/PDF/embed
  job must not be able to corrupt or stall main), and `utilityProcess` is Electron's first-class,
  supported mechanism for an out-of-process Node child with a `MessagePort`-style channel
  (`child.postMessage` / `child.on("message")`), proper lifecycle (`child.kill()`), and
  Electron-ABI compatibility. `worker_threads` shares the host process: a same-process worker
  thread could (a) be tempted to share the `better-sqlite3` handle (forbidden — WAL + a single
  `better-sqlite3` connection is the safe model; a second connection from another thread invites
  `SQLITE_BUSY`/lock contention and a corruptible WAL) and (b) crash the whole app on an
  unhandled native fault. The architecture doc lists either as acceptable; we choose the
  **stronger isolation** of `utilityProcess`.
- **The worker NEVER touches SQLite or the asset vault DB rows.** It does pure compute + network
  I/O only (fetch HTML, later: OCR a PDF page to text, compute an embedding vector, hash a file)
  and returns plain serializable data. **All DB writes happen in MAIN** after the worker posts a
  result — main commits through the existing repositories in one transaction (which append the
  correct existing `operation_log` entries). This keeps the single-writer invariant intact.
- **Bundling:** the worker is bundled by esbuild into its OWN self-contained entry
  `dist/job-worker.cjs` (a third target in `build.mjs`), spawned with
  `utilityProcess.fork(path.join(__dirname, "job-worker.cjs"))`. It must NOT import
  `@interleave/db`/`better-sqlite3`/the repositories (it has no DB) — only the pure transform
  packages it needs (e.g. nothing for `url_import`'s fetch beyond `node:fetch`; later
  `@interleave/importers` transforms can run in main or the worker, but the FETCH is the
  worker's job here).

### The job model (specify concretely)

- A `Job` is `{ id, type, payload, status, attempts, maxAttempts, progress, result?, error?,
  createdAt, updatedAt, startedAt?, finishedAt? }`. `type` is a closed union (`JobType`)
  starting with **`url_import`** (T058) and **reserved** (declared, not yet wired) `ocr` /
  `embed` / `ai` / `cleanup` / `vault_verify` / `vault_gc` so M14/M18/T059 slot in without a
  shape change. `status` is `queued | running | succeeded | failed | cancelled`. `payload` and
  `result` are job-type-specific, validated with Zod per `type` at the enqueue + apply
  boundaries (mirror the IPC-contract discipline). `progress` is `{ ratio: number; note?:
  string }` (0–1).
- The job lifecycle (in MAIN, single-writer): `enqueue` → row `queued`; runner picks the
  oldest `queued` (priority-then-FIFO is fine; FIFO is acceptable for T058), marks it `running`
  + `startedAt`, posts the payload to the worker; on a worker `progress` message it updates
  `progress`; on a worker `result` message main **applies** the result (the job-type apply
  handler runs the DB transaction) then marks `succeeded` + `result` + `finishedAt`; on a worker
  `error` (or apply throw) it increments `attempts` and, if `attempts < maxAttempts`,
  re-`queued`s with a backoff `notBefore` timestamp, else marks `failed` + `error`. A
  `cancel(id)` marks a `queued` job `cancelled` (a `running` job is marked `cancelled` and its
  worker result is ignored on arrival — best-effort, no hard kill needed for `url_import`).
- **Concurrency:** a small fixed concurrency (1–2 in-flight for T058 is fine; make it a constant)
  so a slow job never starves the UI but the queue still drains. Document the constant.
- **Persistence + restart:** the queue lives in the `jobs` SQLite table (below), so it survives
  restart. On `open()`/runner-start, **recover**: any row left `running` (the app died mid-job)
  is reset to `queued` so it re-runs; `queued` rows simply resume draining. **Bound the
  poison-job loop (this is the load-bearing recovery decision — pick ONE and make the table
  columns + `recoverRunning` signature consistent with it):**
  - **Option A (recommended, simplest):** a crash-recovery reset **DOES count against the retry
    budget** — `recoverRunning()` resets each `running` row to `queued` AND increments `attempts`
    (and if `attempts` already reached `maxAttempts`, marks it terminal `failed` instead of
    re-queueing). This needs no extra column (it reuses `attempts`/`maxAttempts`) and bounds a
    job that crashes the worker on every launch to at most `maxAttempts` runs before it lands
    `failed`. Document in the docblock that a crash consumes a retry.
  - **Option B:** do NOT count a crash against the retry budget (reset to `queued` WITHOUT
    incrementing `attempts`), but add a dedicated `recoverResets` integer column to the `jobs`
    table and a `maxRecoverResets` cap; `recoverRunning()` increments `recoverResets` and marks
    the row terminal `failed` once it exceeds the cap. This preserves the full retry budget for
    genuine transient failures but needs the extra column + cap threaded through.

  Either way `recoverRunning()` must have a place to record/check the reset count so a
  crash-on-start job cannot re-run forever — a blunt "reset all running→queued with no counter"
  is NOT acceptable (it is the unbounded-retry hole). This is **at-least-once** delivery — every
  job apply handler must be **idempotent or dedup-guarded** (the `url_import` apply already is:
  T061 canonical-URL/content-hash dedup means a re-run of an already-applied import returns
  `"duplicate"`, creating nothing).

### Dependencies to add

- **None new at runtime.** `utilityProcess` ships with Electron; `fetch` is the Node 22 global
  (already used by `UrlImportService`). Add only the esbuild worker target. (Do NOT add
  `pg-boss`, `bullmq`, `bee-queue`, Redis, or any server/queue library — those are forbidden by
  the re-scope.)

### Deliverables

- [ ] **New `jobs` table + migration** — add a `jobs` table module
      `packages/db/src/schema/jobs.ts` (mirroring the `assets`/`operation_log` table shape in
      [`../../packages/db/src/schema/system.ts`](../../packages/db/src/schema/system.ts)):
      `id` (text PK), `type` (text, `check` against the `JOB_TYPES` list — add `JOB_TYPES` +
      `JobType` to [`../../packages/core/src/enums.ts`](../../packages/core/src/enums.ts)
      alongside `ASSET_KINDS`), `status` (text, `check` against `JOB_STATUSES`), `payload`
      (text JSON), `result` (text JSON, nullable), `error` (text, nullable), `attempts`
      (integer, default 0), `maxAttempts` (integer), `progressRatio` (real/integer 0–100,
      default 0), `progressNote` (text, nullable), `notBefore` (text ISO, nullable — backoff
      gate), `createdAt`/`updatedAt`/`startedAt`/`finishedAt` (text ISO; the last three
      nullable). **If recovery Option B is chosen** (crash does NOT consume a retry; see "the job
      model" persistence note), ALSO add `recoverResets` (integer, default 0) so the
      poison-job-on-start loop is capped; Option A reuses `attempts`/`maxAttempts` and needs no
      extra column — keep the column set consistent with the option you picked. Indexes:
      `jobs_status_idx` on `status`, `jobs_created_idx` on `createdAt` (the
      queue read is "oldest `queued` whose `notBefore` ≤ now"). Export it from the schema barrel
      [`../../packages/db/src/schema/index.ts`](../../packages/db/src/schema/index.ts). Run
      `pnpm db:generate` to produce the `0007_*` Drizzle migration; commit the generated SQL.
      **No domain FK** — a job is infra, not an element (it MAY carry an element id inside its
      typed `payload`/`result`, but it is not part of the lineage graph and never appears in
      `operation_log`).
- [ ] **`JobsRepository`** in `packages/local-db/src/jobs-repository.ts` — the typed,
      transactional persistence seam for the queue (the runner in main calls it; nothing else
      does). Methods: `enqueue(input: { type; payload; maxAttempts? }): Job`;
      `claimNext(now): Job | null` (atomically select the oldest `queued` row with `notBefore ≤
      now` and flip it to `running` + `startedAt` in ONE transaction so two ticks never claim
      the same job); `markProgress(id, progress)`; `succeed(id, result)`; `fail(id, error)` (the
      retry-vs-terminal decision lives in the runner, not here — this just writes the terminal
      `failed` row); `requeue(id, { notBefore, incrementAttempts })`; `cancel(id)`;
      `recoverRunning(): { requeued: number; failed: number }` — the restart-resume primitive,
      run once on startup. It MUST bound the poison-job loop (it cannot be a blunt "reset all
      `running` → `queued`"): per the chosen recovery option (see "the job model"), for each
      `running` row it either re-queues it (Option A: incrementing `attempts`; Option B:
      incrementing `recoverResets`) OR — if that job has already exhausted its budget
      (`attempts >= maxAttempts`, or `recoverResets > maxRecoverResets`) — marks it terminal
      `failed` with a "crashed too many times" error. Returns how many it re-queued vs. failed so
      the caller can log it. (Option A needs only `attempts`/`maxAttempts`; Option B needs the
      `recoverResets` column + a cap constant.) `findById(id)`; `list(filter?)` (for the observe
      surface). Map rows ↔ a `Job` domain type (add `Job`/`JobStatus`/`JobType` to
      `@interleave/core`). **Jobs append NO `operation_log` entry** (infra, not a domain
      mutation — document this in the repo docblock, mirroring `AssetRepository`'s "asset rows
      have no dedicated operation" note ~lines 11–15). Register it in `Repositories` +
      `createRepositories` ([`../../packages/local-db/src/index.ts`](../../packages/local-db/src/index.ts)
      ~lines 180/218) and export the types from the barrel.
- [ ] **The worker entry** `apps/desktop/src/worker/job-worker.ts` — the `utilityProcess` child.
      It listens for `{ jobId, type, payload }` messages, dispatches on `type` to a pure
      job-execution function (for `url_import`: fetch the URL off-main — reuse the SSRF
      guard/timeout/size-cap logic; it may import the host-classification helper
      `isBlockedImportHost`/`isImportableScheme` from `url-import-host.ts` since that is pure and
      DB-free — and post back `{ jobId, kind: "result", data: { html, finalUrl } }`), posts
      `{ jobId, kind: "progress", progress }` during work, and posts `{ jobId, kind: "error",
      code, message }` on failure. **It NEVER imports `@interleave/db`, `better-sqlite3`, the
      repositories, or `DbService`** — it has no database. Keep one message-shape module shared
      between main + worker (`apps/desktop/src/worker/messages.ts`, Zod-validated both ways) so
      the channel is typed and a malformed message is rejected.
- [ ] **The esbuild worker target** in
      [`../../apps/desktop/build.mjs`](../../apps/desktop/build.mjs) — add a third entry
      `src/worker/job-worker.ts → dist/job-worker.cjs` (same `common` CJS/node22 options;
      `mainExtras`' `import.meta.url` shim only if the worker uses `import.meta`). Add it to the
      **shared `targets` array** (build.mjs ~lines 112–124), NOT a separate prod-only build — the
      array is consumed by BOTH the `--watch` branch (~lines 128–132, `targets.map((t) =>
      esbuild.context(t))`) and the production branch (~lines 140–141, `targets.map((t) =>
      esbuild.build(t))`), so a shared entry makes both emit `dist/job-worker.cjs`. Also update the
      two console logs so they reflect the third output: the watch log
      `"[desktop] esbuild watching main + preload…"` (line 131) and the prod log
      `"[desktop] built main.cjs + preload.cjs + drizzle/"` (line 141) → mention the worker
      (e.g. `… main + preload + job-worker …` / `… main.cjs + preload.cjs + job-worker.cjs +
      drizzle/`). **Note the dev loop:** `pnpm dev` runs `scripts/dev.mjs`, which invokes
      `node build.mjs` (the ONE-SHOT prod branch, NOT `--watch`) once before launching Electron —
      so adding the worker to the shared `targets` array is what makes `dist/job-worker.cjs` exist
      under `pnpm dev` (build.mjs's `--watch` branch is only used when build.mjs is run directly
      with `--watch`). `index.ts`/the runner resolves the bundle next to the compiled main
      (`path.join(__dirname, "job-worker.cjs")`, the same `distDir` discipline `index.ts` uses for
      the renderer/preload), which holds in both dev and packaged because `dev.mjs` produces
      `dist/job-worker.cjs` exactly where the packaged build does.
- [ ] **`JobRunner`** in `apps/desktop/src/main/job-runner.ts` — the main-side orchestrator that
      OWNS the `utilityProcess`, the in-memory tick loop, and the job-type **apply** handlers. It
      is constructed with `{ jobsRepo, applyHandlers, workerPath, fork? }` (inject the worker
      path + an optional `fork` factory so a unit test can substitute a fake worker). Public:
      `start()` (spawn the worker, run `jobsRepo.recoverRunning()`, begin the tick loop),
      `enqueue(type, payload, opts?): Job` (write a `queued` row + kick the loop, return the
      row), `cancel(id)`, `observe()`/an event emitter that emits `job:update` snapshots (for the
      IPC observe surface), `stop()` (stop the loop, `child.kill()`; leave the persisted queue
      intact — pending jobs resume next launch), and — **only if the await-terminal `importUrl`
      shape is chosen** (see "Move the URL-import fetch onto the runner") — `waitForTerminal(id):
      Promise<Job>` that resolves with the final job row when it reaches a terminal state
      (`succeeded`/`failed`/`cancelled`), implemented on top of the same `job:update` emitter
      (resolve on the first terminal snapshot for `id`; resolve immediately if the job is already
      terminal when called). If the preferred enqueue-then-observe shape is chosen,
      `waitForTerminal` is unnecessary — do not add unused surface. The tick: claim the next runnable job,
      post it to the worker, and wire the worker's `progress`/`result`/`error` messages to
      `markProgress` / the apply handler + `succeed` / the retry-or-`fail` decision. **The apply
      handler for `url_import`** calls the EXISTING `UrlImportService` snapshot+createSource path
      with the worker-fetched HTML — concretely it calls `urlImportService.importFromHtml({ url,
      html, … })` (which already skips the fetch and runs the identical Readability → sanitize →
      vault-write → `createWithDocumentWithin` transaction, M12-web-import.md's `importFromHtml`
      deliverable), so the runner reuses the shipped, tested pipeline and the DB write stays in
      main. Emit a final `job:update` so observers see completion.
- [ ] **Move the URL-import fetch onto the runner (the proof job).** Change the `importUrl`
      path so the renderer's `appApi.sources.importUrl` ENQUEUES a `url_import` job instead of
      doing the fetch inline:
  - Keep `window.appApi.sources.importUrl(request)` working, but make it **enqueue + await the
    job's terminal state** (so the existing renderer modal still gets a single
    `SourcesImportUrlResult` back), OR — cleaner and the preferred shape — keep `importUrl` as a
    thin synchronous **enqueue** that returns a `{ jobId }` and have the renderer observe the
    job to completion via `jobs.subscribe` (below). **Pick ONE and document it**; the
    enqueue-then-observe shape is preferred because it is the pattern OCR/embeddings (M14/M18)
    need, and it keeps `importFromUrl` from re-blocking the main loop.
    - **If you keep the await-terminal shape** (minimal renderer churn), the IPC handler must:
      `runner.enqueue("url_import", payload)` → `const job = await runner.waitForTerminal(job.id)`
      (the primitive added to `JobRunner` above — main never blocks on the network, only on the
      job's terminal `job:update`) → **map the terminal job to the existing
      `SourcesImportUrlResult`**: a `succeeded` job carries the apply handler's result (the
      `imported`/`duplicate` inbox summary) → return it as-is; a `failed`/`cancelled` job →
      **re-throw** a `UrlImportError` reconstructed from `job.error` (its `code` + `message`) so the
      IPC `invoke` promise REJECTS exactly as the inline path does today. (`SourcesImportUrlResult`
      has **no** error arm — it is the two-arm `imported` | `duplicate` union, contract.ts:860-872;
      today `UrlImportError` is THROWN from `url-import-service.ts:312-402` and propagates through the
      `ipc.ts:195-198` handler as a rejected `invoke`, which the `ImportUrlModal` catch already
      handles. So errors are thrown, NOT returned as a result variant.) Spell this mapping out so the
      fallback is buildable, not a hand-wave. The fetch STILL runs in the worker (main never blocks on
      the network) — that is the load-bearing requirement.
  - Either way: the worker does the fetch; main runs `importFromHtml` on the result; T061 dedup
    still applies (a duplicate URL returns `"duplicate"` without creating a source); the SSRF
    guard still runs (in the worker before fetch AND the host-classification stays the single
    `url-import-host.ts` helper). `importManual`/`importSelection`/the M13 loopback path are
    UNAFFECTED (a captured selection/HTML has no fetch to offload — only `importFromUrl`'s fetch
    moves).
- [ ] **Wire the runner into the lifecycle** in
      [`../../apps/desktop/src/main/index.ts`](../../apps/desktop/src/main/index.ts): in
      `bootstrap()` construct the `JobRunner` (after `dbService.open`, with the jobs repo +
      apply handlers bound to the open DB) and `runner.start()`; thread it into
      `registerIpcHandlers` (extend `IpcHandlerContext` with `runner?: JobRunner`, mirroring the
      optional `captureController`); in `app.on("will-quit", …)` call `runner.stop()` BEFORE
      `dbService.close()` (so no apply handler writes after the DB closes). Build it lazily/once
      like the other services so a contract-only test that never enqueues still opens the DB.
- [ ] **IPC contract** in
      [`../../apps/desktop/src/shared/contract.ts`](../../apps/desktop/src/shared/contract.ts):
  - **Decision (made here once for the whole IPC chain): T058 does NOT expose a generic
    `jobs.enqueue` to the renderer.** The only renderer-reachable enqueue path is the existing
    `sources.importUrl` (which enqueues a `url_import` job in main). So **omit
    `JobsEnqueueRequestSchema` and the `jobs.enqueue` command** — the contract, channels, ipc
    handlers, and preload all follow this one decision (no per-file "if added" choices). The
    renderer surface is enqueue-via-`sources.importUrl` + observe-via-`jobs.list`/`jobs.subscribe`
    only. (M14/M18 may add a typed, renderer-allowed enqueue later; T058 deliberately does not.)
  - `JobSummary` = `{ id, type, status, progressRatio, progressNote, error, createdAt,
    updatedAt }` (a renderer-safe projection — NO raw payload/result bytes unless a type needs
    them; the `url_import` terminal result the renderer cares about is the inbox summary, surfaced
    via the existing `SourcesImportUrlResult`).
  - `JobsListRequestSchema` + `JobsListResult` = `{ jobs: readonly JobSummary[] }` (observe the
    current queue, e.g. for an Analytics/Maintenance "background activity" view).
  - A `jobs` group on the `AppApi` interface (~line 2615, beside `sources`):
    `list(request): Promise<JobsListResult>` and a **`subscribe(callback: (summary:
    JobSummary) => void): unsubscribe`** receive-only subscription (NO `enqueue` — see the
    decision above). It mirrors the STRUCTURE of
    `menu.onShowShortcuts` (a named-event listener returning an unsubscribe fn) but, unlike that
    payload-free exemplar, its callback receives a `JobSummary` argument (see the Preload
    deliverable for the payload-forwarding listener).
- [ ] **Channels** in
      [`../../apps/desktop/src/shared/channels.ts`](../../apps/desktop/src/shared/channels.ts):
      `jobsList: "jobs:list"` and a one-way main→renderer event channel
      `jobsUpdated: "jobs:updated"` (the runner broadcasts a `JobSummary` on every `job:update`;
      the preload forwards it to subscribers). **No `jobsEnqueue` channel** — per the contract
      decision, the renderer enqueues only via the existing `sources:importUrl`.
- [ ] **IPC handlers** in [`../../apps/desktop/src/main/ipc.ts`](../../apps/desktop/src/main/ipc.ts):
      register `jobsList` (parse → `runner.list()` projected to `JobSummary[]`). (T058 omits
      `jobs.enqueue` from the renderer surface — the only renderer-reachable enqueue path is
      `sources.importUrl` — so there is no `jobsEnqueue` handler; see the IPC-contract decision.)
      Subscribe the runner's `observe()` emitter and `webContents.send(IPC_CHANNELS.jobsUpdated,
      summary)` to the focused window(s) so the renderer's `jobs.subscribe` fires. A handler
      registered without a runner (contract-only tests) throws a clear error, mirroring
      `requireCaptureController` (~line 206).
  - **Tear down the `observe()` subscription in the returned disposer.** The existing disposer
    (`ipc.ts` ~lines 475–479) only loops `ipcMain.removeHandler(channel)` over
    `Object.values(IPC_CHANNELS)` — correct for `invoke` handlers but it does NOT unsubscribe the
    emitter listener this handler registers on `runner.observe()`. Capture the `observe()`
    unsubscribe fn and call it inside the returned disposer (alongside the `removeHandler` loop),
    so re-registering handlers (e.g. a `DbService`-reopen test that calls `registerIpcHandlers`
    again) does not leak emitter listeners or double-send. `jobsUpdated` is a **send-only**
    main→renderer channel (no `ipcMain.handle`), so the `removeHandler` loop is a harmless no-op
    for it — the listener teardown is the part that matters.
- [ ] **Preload** in [`../../apps/desktop/src/preload/index.ts`](../../apps/desktop/src/preload/index.ts):
      add a `jobs` group — `list(request)` (invoke) and `subscribe(callback)` (NO `enqueue` — per
      the contract decision) using the SAME structural named-event pattern as
      `menu.onShowShortcuts`/`onCreateBackup` (~lines 223–235): `ipcRenderer.on(IPC_CHANNELS.jobsUpdated,
      listener)` returning an unsubscribe fn; the renderer never sees the raw `ipcRenderer`/event.
      **One deliberate difference from the menu exemplars:** those are payload-FREE
      (`const listener = () => callback()` — they drop the event and any args), but `jobs.subscribe`
      must DELIVER a `JobSummary` to the callback, so the listener forwards the event's payload arg:
      `const listener = (_event, summary: JobSummary) => callback(summary)`. `contextBridge` requires
      the listener to project a plain serializable `JobSummary` to the callback — never the raw
      `IpcRendererEvent`. (Do not copy `() => callback()` verbatim; that ships a subscription that
      fires but never passes the summary.)
- [ ] **Renderer client** in [`../../apps/web/src/lib/appApi.ts`](../../apps/web/src/lib/appApi.ts):
      mirror the new `jobs.*` surface (+ types). If `importUrl` becomes enqueue-then-observe,
      adapt the existing `ImportUrlModal` flow (M12-web-import.md) so it enqueues, watches the
      job to terminal via `jobs.subscribe`, and then renders the same `imported`/`duplicate`
      outcome — keeping it pure UI (one command + one subscription; all fetch/clean/persist
      stays main/worker side). Render gracefully when `!isDesktop()` (mirror the existing
      desktop-only fallback).
- [ ] **Tests (unit, jobs repo + runner)** — these are the core of T058:
  - `packages/local-db/src/jobs-repository.test.ts` against this package's own
    `createInMemoryDb()` from `./test-db` (the same harness the other repo tests use):
    `enqueue` writes a `queued` row; `claimNext` flips exactly one row to `running` and a second
    call returns `null` (no double-claim); a `notBefore` in the future is NOT claimed; `succeed`
    / `fail` / `requeue(incrementAttempts)` set the right terminal/retry state; `recoverRunning()`
    re-queues a `running` row left by a crash (returns `{ requeued, failed }`) AND, for a row that
    has already exhausted its budget (per the chosen option — `attempts >= maxAttempts`, or
    `recoverResets > maxRecoverResets`), marks it terminal `failed` instead of re-queueing — so a
    poison-on-start job is bounded, not looping forever; jobs write NO `operation_log` row (assert
    the op-log count is unchanged across a job's lifecycle).
  - `apps/desktop/src/main/job-runner.test.ts` against a real temp-file SQLite DB (the
    desktop-main test pattern: `new DbService()` + `svc.open(dbPath, { migrationsDir,
    assetsDir })` under `mkdtempSync`, like
    [`../../apps/desktop/src/main/db-service.test.ts`](../../apps/desktop/src/main/db-service.test.ts))
    with a **fake/in-process worker** injected via the `fork` factory (so no real child process
    is spawned in unit tests): enqueue a job → the runner posts it → the fake worker replies
    `progress` then `result` → the apply handler runs → the job is `succeeded` and an observer
    saw the `progress` then completion; a fake worker `error` → the runner retries up to
    `maxAttempts` (assert the backoff `requeue`) then marks `failed`; a `cancel` on a queued job
    yields `cancelled` and the job never runs.
- [ ] **Tests (integration, restart-resume on a real DB — Vitest, the PRIMARY plan)** —
      `apps/desktop/src/main/job-runner.integration.test.ts` (or fold into the service test).
      **`utilityProcess` is an Electron MAIN-process-only API and is NOT available in a plain
      Vitest/Node process** (it requires the Electron runtime), so do NOT try to `fork` a real
      `utilityProcess` worker under Vitest — that path cannot run here. Instead the Vitest
      integration test covers the **restart-resume + `recoverRunning` + apply-handler** behavior
      against a real temp-file SQLite DB + temp `assetsDir` (the desktop-main pattern: `new
      DbService()` + `svc.open(dbPath, { migrationsDir, assetsDir })` under `mkdtempSync`, like
      [`../../apps/desktop/src/main/db-service.test.ts`](../../apps/desktop/src/main/db-service.test.ts))
      using the **fake/in-process worker injected via the `fork` factory** (the same fake-worker
      seam as `job-runner.test.ts`): enqueue a `url_import` job whose fake worker returns known
      HTML → main applies via `importFromHtml` → a source lands in the inbox with
      `original.html`/`cleaned.html` in the vault and the job is `succeeded`. **Restart
      persistence (load-bearing):** enqueue a job, simulate a crash by NOT running it (or stop the
      runner mid-flight leaving a `running` row), then RE-OPEN the DB + start a NEW runner (still
      with the fake worker) and assert `recoverRunning` re-queued it, it completes, and the
      resulting source + snapshot files survive across the re-open. This is fully feasible in
      Vitest with the fake worker + a real temp-file DB; it is the committed restart coverage.
- [ ] **Tests (E2E, Electron — the home for the REAL `utilityProcess` worker)** — extend or add
      to `tests/electron/` (reuse `url-import.spec.ts`'s `createServer` local fixture HTTP server
      + the `INTERLEAVE_ALLOW_LOOPBACK_IMPORT` escape so the SSRF guard permits 127.0.0.1 — both
      already exist). Because the real Electron runtime is present here (electron `^38.x`), THIS is
      where the actual `dist/job-worker.cjs` `utilityProcess` runs end-to-end: paste a URL → the
      import runs via the background runner with the **real worker fetching off-main** (the UI
      stays responsive) → main applies via `importFromHtml` → the source appears in the inbox with
      its `original.html`/`cleaned.html` snapshots in the vault → after an **app restart** against
      the same data dir, a job that was queued at quit has completed (or re-runs to completion) and
      the source/snapshot survive. Assert no orphan `running` jobs linger after restart. (The
      real-worker spawn + off-main fetch is proven HERE, not in Vitest, where `utilityProcess` is
      unavailable.)
- [ ] **Tests (contract)** — extend
      [`../../apps/desktop/src/shared/contract.test.ts`](../../apps/desktop/src/shared/contract.test.ts):
      the new `Jobs*` schemas round-trip a valid `JobSummary`/list payload and reject malformed
      ones; the worker `messages.ts` Zod shapes round-trip a `progress`/`result`/`error` message
      and reject a bad one.
- [ ] **Fixtures/seed** — no seed change required (jobs are runtime infra; the queue starts
      empty). Optionally add a tiny dev affordance to observe the queue, not required.
- [ ] **Docs** — check the T058 box in [`../roadmap.md`](../roadmap.md) with the commit ref + a
      Progress-log line noting: the local-first runner (utilityProcess, NOT pg-boss/worker), the
      new `jobs` table + `JobsRepository`, the `dist/job-worker.cjs` bundle target, and that the
      URL-import fetch now runs on the runner.

### Done when

- An on-device background runner — an Electron **`utilityProcess`** worker (NOT a server worker,
  NOT pg-boss, NO network service) — processes local jobs: the main process can **enqueue** a
  typed job and **observe** its progress/result/error, all locally; nothing is sent to a server.
- At least ONE real job is wired end-to-end: `window.appApi.sources.importUrl` runs the page
  **fetch off-main in the worker**, and **main** applies the result through the existing
  `UrlImportService` snapshot+createSource pipeline (the DB write stays in main; the worker never
  opens SQLite). The UI stays responsive during a slow fetch.
- The queue is **persisted** in the `jobs` SQLite table and an in-flight job **survives an app
  restart** — `running` rows left by a crash are re-queued and re-run (at-least-once; the apply
  is idempotent/dedup-guarded so no double-create), `queued` rows resume draining. Failed jobs
  retry with backoff up to a cap, then land terminal `failed` with the error recorded.
- The renderer reaches the runner ONLY through the typed `window.appApi.jobs.*` (+ the existing
  `sources.importUrl`) — no generic `db.query`, no raw worker messages, no SQL/fs/Node in React;
  jobs append NO `operation_log` entries (a job that mutates domain data logs through the
  existing repositories' existing ops).
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm e2e --project=electron` pass; the
  `0007_*` migration applies cleanly on an existing dev DB.

### Notes / risks

- **Single-writer is the whole game.** The one rule that must not bend: the worker does
  compute/I/O and returns serializable data; **only main writes SQLite**, in transactions,
  through the existing repositories. Never open a second `better-sqlite3` connection in the
  worker; never share the handle across the process boundary. If a future job needs to READ the
  DB to decide what to do, main reads it and passes the inputs into the job payload — the worker
  stays DB-free.
- **At-least-once, so jobs must be idempotent.** A crash-then-resume can re-run a job that had
  already partially or fully applied. The `url_import` apply is safe (T061 dedup turns a re-run
  into a `"duplicate"` no-op). Every future job type (OCR, embed, cleanup) MUST be written
  idempotent or dedup-guarded — call this out in the `JobRunner` apply-handler contract so M14/
  M18 builders inherit the requirement. (Exactly-once is intentionally NOT attempted — it would
  need a 2-phase commit across the process boundary; at-least-once + idempotency is the correct,
  simple local model.)
- **Bundling the worker.** The single biggest concrete gotcha: esbuild currently emits only
  `main.cjs` + `preload.cjs`. The worker MUST get its own bundled `dist/job-worker.cjs` target,
  spawned by absolute path next to the compiled main — and it must NOT bundle `@interleave/db`/
  `better-sqlite3` (it has no DB), only the pure code it needs. Verify the packaged app (`pnpm
  --filter @interleave/desktop build`) emits `dist/job-worker.cjs` and the runner forks it.
- **Don't over-scope.** T058 ships the runner + queue + ONE proven job. Do NOT implement OCR,
  embeddings, AI, or cleanup jobs here — declare their `JobType`s as reserved so M14/M18/T059
  add an apply handler + a worker dispatch case without changing the queue/table/IPC shape.
  Priority/fairness beyond FIFO + a tiny fixed concurrency is out of scope (T076-era overload
  work can revisit).
- **Lifecycle ordering.** `runner.stop()` MUST run before `dbService.close()` in `will-quit`, or
  a late apply handler writes to a closed DB. Mirror the capture-controller stop ordering
  already in `will-quit`.
- **Downstream:** M14 (PDF parse / OCR) and M18 (embeddings / AI calls) run their heavy work as
  NEW job types on THIS runner — they add a `JobType`, a worker dispatch case, and a main-side
  apply handler; they do NOT spin up their own runner. T059's integrity-verify + orphan-GC are
  also exposed as `vault_verify` / `vault_gc` job types (in addition to direct `window.appApi`
  commands) so a large-vault sweep runs off-main.

---

## T059 — Asset-vault scaling for large media

- **Status:** `[ ]` not started  · **Depends on:** T058 (the runner — vault integrity-verify +
  orphan-GC sweeps run as background jobs as well as direct commands; the streamed write/hash
  primitives the runner's future media jobs reuse must exist first).
- **Roadmap line:** Done when the filesystem asset vault robustly handles large binaries (PDFs,
  images, audio/video, snapshots) — streamed read/write, content-hash dedup, integrity checks,
  and orphan GC — all behind the typed `window.appApi`/`AssetRepository` seam. The vault is the
  canonical local store for assets; there is **no** app-facing S3.

### Goal

The filesystem asset vault becomes robust for **large binaries**. A new main-side
**`AssetVaultService`** writes a binary to the vault by **streaming it in chunks while hashing
as it goes** (so a multi-hundred-MB PDF/audio/video never sits whole in memory), records the
content-hashed `AssetRepository` metadata in a transaction, and **dedups on write** (if the
content hash already maps to a live asset, it reuses the existing bytes instead of writing a
second copy). The vault can be **integrity-verified** (re-hash stored bytes and compare to the
recorded `assets.content_hash`, flagging any mismatch/missing file) and **orphan-GC'd**
(identify vault **files on disk that no live `assets` row references** and remove them — safely,
confirmably, and never touching anything still referenced).

> **GC orphan model — read this before writing any of the GC code.** The orphan unit is the
> **vault FILE on disk**, not an "asset row whose element is gone." Here is why, grounded in the
> real schema + Trash path:
> - `assets.owning_element_id` has `onDelete: "cascade"` to `elements`
>   ([`../../packages/db/src/schema/system.ts`](../../packages/db/src/schema/system.ts) ~lines
>   32–34). The ONLY hard delete in the app is `TrashRepository.purge` / `emptyTrash`
>   ([`../../packages/local-db/src/trash-query.ts`](../../packages/local-db/src/trash-query.ts)
>   ~lines 120–146), a real `DELETE FROM elements` whose docblock (~lines 18–24) explicitly lists
>   `assets` among the FK cascades that "clean up every dependent row."
> - So when an element is hard-purged, its `assets` ROWS are deleted **atomically by the
>   cascade** — an "asset row with no element row" state therefore **never arises from the real
>   purge path**. There is no codepath in the app today that produces a dangling asset row.
> - What the cascade does NOT do is touch the filesystem: purge writes nothing to disk, so the
>   **vault bytes are left behind**. *That* is the real orphan class: files under `assets/` whose
>   `assets` row was cascade-deleted (or never existed).
> - Therefore GC's primary predicate is **"a vault file on disk that no live `assets` row
>   references"** (purge is the trigger that creates them, by deleting the row but not the file).
>   The classic "owner_gone asset row" predicate is **dead for the normal flow** and is NOT what
>   GC chases. (If a future feature ever introduces a non-cascading delete that leaves a dangling
>   row, GC's file-centric sweep already reclaims its now-unreferenced bytes — no separate
>   "owner_gone row" arm is needed, and none is specified.)

All of it is behind `AssetRepository`
+ a new typed `window.appApi.vault.*` surface; the renderer never resolves a raw path, never
reads/writes bytes, and there is **no app-facing S3** — the vault on the local filesystem is the
canonical store.

### Context to load first

- Reference: [`../architecture.md`](../architecture.md) ("Asset vault (Electron-managed)" ~lines
  173–188; the SQLite "no large blobs" rule ~line 169), [`../../CLAUDE.md`](../../CLAUDE.md)
  ("Asset vault", "SQLite rules", "Data rules" — soft-delete, never silently destroy user data),
  [`../domain-model.md`](../domain-model.md) (the `Asset`/`AssetLocation`/`LocalVaultPath`
  bridge types + the `assets` columns). The canonical column shape is the real schema —
  `vault_root` + `relative_path` (POSIX, no leading slash), NOT a `location` column.
  domain-model.md line ~135 already lists `vault_root` + `relative_path` (no `location` column),
  so it already matches; just confirm it still does and trust the schema in
  [`../../packages/db/src/schema/system.ts`](../../packages/db/src/schema/system.ts) ~lines 37–40.
- Existing code to inspect: `AssetRepository`
  ([`../../packages/local-db/src/asset-repository.ts`](../../packages/local-db/src/asset-repository.ts)
  — `create`/`createWithin`, `findByContentHash` ~line 110, `findById`,
  `listForElement`/`listForElementByKind`, and the `assets_content_hash_idx`), the `assets`
  schema ([`../../packages/db/src/schema/system.ts`](../../packages/db/src/schema/system.ts)
  ~lines 27–60), `AppPaths`/`assetsDir`/`ensureVaultSkeleton`
  ([`../../apps/desktop/src/main/paths.ts`](../../apps/desktop/src/main/paths.ts)), the hashing
  precedent (`sha256`/`sha256File`,
  [`../../apps/desktop/src/main/backup-manifest.ts`](../../apps/desktop/src/main/backup-manifest.ts)
  ~lines 88–95 — the WHOLE-FILE `readFileSync` this task replaces with a streamed hash for large
  files) + the exported `listFilesRelative`
  ([`../../apps/desktop/src/main/backup-service.ts`](../../apps/desktop/src/main/backup-service.ts)
  ~line 99 — a standalone `export function`, NOT a static method on the `BackupService` class;
  the vault walk to reuse for GC/verify), how `UrlImportService` writes the vault +
  records metadata (`runPipeline` ~lines 481–526 — the small-file precedent the streamed path
  generalizes), `ElementRepository` (the `deletedAt`/status fields that define a "live" owning
  element), and the T058 `JobRunner`/`JobsRepository` (verify/GC as job types).
- Invariants in play: **bytes live in the vault, never SQLite** (only metadata/hashes/relative
  paths/owning element ids in `assets`); the renderer NEVER resolves a raw path or reads bytes —
  all vault access is a typed `window.appApi` command; **soft-delete only** — orphan GC removes
  vault **files that no live `assets` row references** (the bytes a hard-purge cascade left
  behind, since the cascade deletes the row but not the file — see the GC orphan model in the
  Goal), but it NEVER deletes a file any live asset row still points at, and NEVER reclaims a
  file owned by a soft-deleted-but-restorable element (its row is still live, so the file is
  still referenced); lineage is sacred (a removed file must be provably unreferenced and the
  action confirmable); content-hash dedup reuses the existing `assets_content_hash_idx`.

### Deliverables

- [ ] **Streamed write+hash primitive** — `apps/desktop/src/main/vault-io.ts` with
      `writeStreamedToVault(input: { source: Readable | string /*abs src path*/; destAbsPath:
      string }): Promise<{ contentHash: string; size: number }>`. It pipes the source through a
      `crypto.createHash("sha256")` transform WHILE writing to a temp file (`<dest>.tmp`) via
      `fs.createWriteStream`, then atomically `rename`s the temp into place on success (so a
      partial/aborted write never leaves a corrupt asset at the final path). The bytes are NEVER
      fully buffered in memory — chunks flow through the hash + the write stream. Also add a
      streamed `hashFileStreamed(absPath): Promise<string>` (the integrity-verify primitive — the
      streaming equivalent of `sha256File`, which `readFileSync`s the whole file). Keep `sha256`/
      `sha256File` for the small-file callers (snapshots, the backup manifest) — this is the
      LARGE-file path, not a replacement everywhere.
- [ ] **`AssetVaultService`** in `apps/desktop/src/main/asset-vault-service.ts` — the main-side
      orchestrator composing `vault-io.ts` + `AssetRepository` + the vault paths (constructed
      with `{ db, repositories, assetsDir }`, the same construction-time-injection pattern as
      `UrlImportService`). Public:
  - `importAsset(input: { owningElementId; kind: AssetKind; sourceAbsPath /* or a Readable */;
    mime; destRelativePath?; width?; height?; durationMs? }): Promise<Asset>` —
    **dedup-on-write:** stream-hash the incoming bytes FIRST (or hash the source then stream),
    then look up an existing **live** asset with that hash; if one exists, **do NOT write a
    second copy** — create a new metadata row that reuses the existing bytes per the dedup policy
    below. Otherwise stream the bytes to `assets/media/<asset_id>/original.bin` (or the
    source-scoped path for `source_*` kinds, matching the vault layout), then record the metadata
    via `AssetRepository.createWithin(tx, …)` in ONE transaction (so a failed metadata insert
    rolls back and the partial file is cleaned up — mirror `UrlImportService`'s best-effort
    `rmSync` on rollback ~lines 527–538).
    - **"Live" must be defined for dedup — the existing `findByContentHash` is NOT liveness-aware.**
      `AssetRepository.findByContentHash(hash)`
      ([`../../packages/local-db/src/asset-repository.ts`](../../packages/local-db/src/asset-repository.ts)
      ~lines 110–113) returns the FIRST asset row by content hash with **no join to `elements`
      and no `deletedAt`/liveness filter** — it can return an asset whose owning element is
      soft-deleted (still restorable from the Trash). Reusing such bytes is fine (the file is
      still live because the soft-deleted owner is restorable), but the dedup decision must be
      well-defined, so T059 adds a liveness-aware lookup
      `findLiveByContentHash(hash): Asset | null` (a LEFT JOIN to `elements` returning the first
      row whose owning element exists, i.e. `deletedAt IS NULL` OR soft-deleted-but-present —
      anything still reachable, NOT a phantom-hash row whose element is somehow gone) and uses
      **THAT** for the dedup hit, NOT the bare `findByContentHash` (keep `findByContentHash` for
      callers that just want any-by-hash). Document in the docblock that dedup intentionally
      reuses bytes whose owner is soft-deleted (the file is still referenced by a live row, so GC
      will not reclaim it).
    - **Dedup policy (pick ONE, document it, make GC consistent):** the simplest correct policy
      for T059 is *content-addressed reuse* — if the hash already has a live asset, create a NEW
      `assets` row for the new owning element that points at the SAME `relative_path` (shared
      bytes), so two elements importing identical bytes store one copy; GC must then only delete a
      file when NO live asset row references that path. (An alternative — refuse the second row
      and return the existing asset — is acceptable only if no second owner needs its own row;
      prefer the shared-path policy and make GC path-reference-aware.) Make GC consistent with it.
  - `verifyIntegrity(): Promise<VaultIntegrityReport>` — for every live `assets` row, resolve its
    absolute path, **stream-hash the stored bytes**, and compare to `assets.content_hash`;
    collect `{ ok: number; mismatched: AssetId[]; missing: AssetId[]; extraFiles: string[] }`
    (extra files = vault bytes with no `assets` row at all). Read-only — it reports, never
    mutates. Big files are hashed streamed (no whole-file read).
    - **The on-disk walk and the `assets.relative_path` column must use the SAME canonical join
      key, or verify/GC misclassify on a path-separator or leading-slash mismatch.** Walk the
      vault with `listFilesRelative` (the exported `function` from
      [`../../apps/desktop/src/main/backup-service.ts`](../../apps/desktop/src/main/backup-service.ts)
      ~line 99 — a module-level export, not a `BackupService` method), which already yields
      **POSIX-style paths relative to `assetsDir`, no leading
      slash** — exactly how `assets.relative_path` is stored
      ([`../../packages/db/src/schema/system.ts`](../../packages/db/src/schema/system.ts) line 39:
      "POSIX `/`, no leading slash, no `..`"; `CreateAssetInput.relativePath` carries the same
      contract). State this canonicalization contract explicitly in the docblock: the join key
      between the disk walk and the DB is the POSIX, leading-slash-free relative path under
      `assetsDir`; normalize both sides identically before comparing. (Note: `assets.relative_path`
      is relative to `vault_root`, and the URL-import snapshots store BOTH `original.html` and
      `cleaned.html` as `source_html` asset rows under `sources/<id>/…` — fold `vault_root` into
      the comparison so a real asset file is never flagged as an `extraFile`.) This is the exact
      class of bug that turns a "safe, read-only report" into a destructive GC false-positive
      when `extraFiles` feeds `collectOrphans`.
    - **The walk root is `assetsDir` (`<dataDir>/assets`), NOT `dataDir`.** `exports/` and
      `backups/` are SIBLINGS of `assets/` under the data dir
      ([`../../apps/desktop/src/main/paths.ts`](../../apps/desktop/src/main/paths.ts) — `assetsDir`
      / `exportsDir` / `backupsDir` are separate `computeAppPaths` entries), and they are OUT OF
      SCOPE for vault verify/GC. State this in the docblock: verify and GC walk only `assetsDir`,
      so a backup archive or an export file is NEVER even considered — let alone flagged as an
      `extraFile` or reclaimed as an orphan. (Today every file under `assetsDir` is app-written
      and rowed; if a future feature writes an `assetsDir` file it never rows, it would show as an
      `extraFile`/orphan — which is correct — but `exports/`/`backups/` must stay untouched.)
  - `findOrphans(): Promise<OrphanReport>` + `collectOrphans(input: { confirm: true; relativePaths?:
    string[] }): Promise<{ removed: number; freedBytes: number }>` — the orphan GC, **file-centric**
    (see the GC orphan model in the Goal). `findOrphans` returns the candidate set: vault **files
    on disk that no live `assets` row references** — i.e. exactly the `extraFiles` that
    `verifyIntegrity` already computes (the bytes a hard-purge cascade left behind, plus any
    never-rowed stray file). There is NO separate "asset row whose element is gone" arm: the
    cascade FK guarantees a purged element's asset rows are already deleted, so the unreferenced
    FILE is the orphan, not a dangling row. `collectOrphans` requires an explicit `confirm: true`
    (and MAY take a specific `relativePaths` allow-list so the UI confirms exactly the files it
    showed), deletes ONLY the confirmed orphan **files** on disk, and returns the counts. It NEVER
    deletes a file still referenced by any live asset row (consistent with the dedup policy — a
    soft-deleted-but-restorable element keeps a live row, so its file is referenced and survives;
    GC only reclaims after the element is HARD-purged via `TrashRepository.purge`/`emptyTrash`,
    T044, which is what unreferences the file). Document the exact orphan predicate: **"a file
    under `assetsDir` whose canonical relative path is not referenced by any live `assets` row."**
- [ ] **`AssetRepository` query support for GC/verify** — add the read queries
      `AssetVaultService` needs WITHOUT leaking SQL elsewhere:
  - `listAll(): Asset[]` (or a streamed/paged variant if the vault is huge — note the option) so
    verify/GC can iterate every asset row.
  - `findLiveByContentHash(hash): Asset | null` — the liveness-aware dedup lookup (LEFT JOIN to
    `elements`, returning the first asset row whose owning element row still exists — reachable,
    NOT a phantom row). This is what `importAsset` dedup calls; the existing bare
    `findByContentHash` stays for any-by-hash callers. (Because of the cascade FK a hash row
    whose element is truly gone cannot exist today, so in practice this matches
    `findByContentHash`; the explicit liveness join makes the "LIVE asset" wording in the dedup
    deliverable actually backed by a signature and future-proofs it against any non-cascading
    delete.)
  - `referencedRelativePaths(): Set<string>` (or `listReferencedPaths(): string[]`) — the set of
    `relative_path` values referenced by **every live asset row** (a soft-deleted-but-restorable
    element's row counts as live). This is the file-centric GC's reference set: a vault file is
    an orphan iff its canonical relative path is NOT in this set. (This subsumes the old
    `softReferenceCount(relativePath)` — GC asks "is this path referenced at all?", which a set
    membership test answers; if a count is genuinely needed elsewhere, a
    `referenceCount(relativePath): number` may be added, but the set is what the file-centric
    sweep uses.)
  - `deleteAssetRow(id)` — remove a single `assets` row. NOTE: with the file-centric GC this is
    **not on the normal GC path** (purge's cascade already deletes the rows; GC deletes the
    leftover FILES, not rows). Keep it only as a repository-internal/main-only helper for the
    rare case of an explicitly-found dangling row (a future non-cascading delete); it is NOT a
    renderer command (the renderer triggers GC via the confirmable `vault.collectOrphans`, never
    deletes a specific row directly). If no caller needs it, omit it.
- [ ] **Vault verify/GC as background job types (ties to T058)** — register `vault_verify` and
      `vault_gc` as `JobType`s with `JobRunner` apply handlers that call
      `AssetVaultService.verifyIntegrity` / `findOrphans` (the heavy hashing/walk runs off-main
      on the runner). The direct `window.appApi.vault.*` commands MAY enqueue these jobs and
      observe them, OR run small/fast variants inline — document which. (A large-vault verify can
      take minutes of hashing; that is exactly why it belongs on the runner.)
- [ ] **IPC contract** in
      [`../../apps/desktop/src/shared/contract.ts`](../../apps/desktop/src/shared/contract.ts):
  - `VaultVerifyRequestSchema` (void / optional scope) + `VaultVerifyResult` =
    `{ ok: number; mismatched: readonly string[]; missing: readonly string[]; extraFiles:
    readonly string[] }`.
  - `VaultFindOrphansRequestSchema` + `VaultOrphansResult` = `{ orphans: readonly
    { relativePath: string; size: number }[]; totalBytes: number }` — each orphan is a vault
    FILE (its canonical relative path + size), since the orphan unit is the unreferenced file,
    not a dangling asset row (see the GC orphan model). There is no `reason`/`assetId` field: an
    orphan is by definition a file with no live asset row, so there is no asset id and no
    `owner_gone` vs `no_row` distinction to carry.
  - `VaultCollectOrphansRequestSchema = z.object({ confirm: z.literal(true), relativePaths:
    z.array(z.string()).optional() })` + `VaultCollectOrphansResult = { removed: number;
    freedBytes: number }` — the optional `relativePaths` allow-list lets the UI confirm exactly
    the files `findOrphans` showed (it keys on the same relative-path orphan identity), and
    `confirm: z.literal(true)` makes a destructive sweep impossible to trigger accidentally from
    the renderer.
  - A `vault` group on the `AppApi` interface: `verify(request)`, `findOrphans(request)`,
    `collectOrphans(request)`.
- [ ] **Channels** in
      [`../../apps/desktop/src/shared/channels.ts`](../../apps/desktop/src/shared/channels.ts):
      `vaultVerify: "vault:verify"`, `vaultFindOrphans: "vault:findOrphans"`,
      `vaultCollectOrphans: "vault:collectOrphans"`.
- [ ] **IPC handlers + db-service wiring** in
      [`../../apps/desktop/src/main/ipc.ts`](../../apps/desktop/src/main/ipc.ts) +
      [`../../apps/desktop/src/main/db-service.ts`](../../apps/desktop/src/main/db-service.ts):
      register the three async vault handlers (parse → delegate to the `AssetVaultService`). In
      `DbService`, build the `AssetVaultService` lazily behind a `get assetVaultService()`
      accessor (it needs `assetsDir`, already injected at `open()`) — exactly like
      `urlImportService` (~line 704) — and expose `verifyVault` / `findVaultOrphans` /
      `collectVaultOrphans` async methods the handlers call. A handler that runs without
      `assetsDir` (a contract-only test) throws a clear error.
- [ ] **Preload** in [`../../apps/desktop/src/preload/index.ts`](../../apps/desktop/src/preload/index.ts):
      add a `vault` group — `verify`, `findOrphans`, `collectOrphans` — each a thin
      `ipcRenderer.invoke`. No raw path or byte ever crosses; the renderer gets only the typed
      report/counts.
- [ ] **Renderer client + (optional) UI** in
      [`../../apps/web/src/lib/appApi.ts`](../../apps/web/src/lib/appApi.ts) (mirror the `vault.*`
      surface + types). Surfacing it in the UI belongs to the **Analytics / Maintenance** screen
      (a "Storage / Maintenance" panel: total vault size, "Verify integrity", "Find & remove
      orphaned files" with a confirm dialog showing exactly what will be freed) — wiring the
      panel is acceptable scope here if small, but the load-bearing deliverable is the typed
      command surface + the service; do NOT invent a new top-level screen. Render gracefully when
      `!isDesktop()`.
- [ ] **Tests (unit, vault-io)** in `apps/desktop/src/main/vault-io.test.ts` against a temp dir:
      `writeStreamedToVault` over a multi-MB `Readable` produces a file whose on-disk bytes hash
      to the returned `contentHash` and whose `size` matches; an aborted/erroring source leaves
      NO file at the final path (the `.tmp` is cleaned up — atomic rename); `hashFileStreamed`
      matches `sha256File` on a small file (same algorithm, streamed vs buffered) and works on a
      large file without loading it whole. (Generate a large fixture in-test, e.g. a multi-MB
      buffer of pseudo-random bytes; do not commit a large binary.)
- [ ] **Tests (unit, AssetRepository GC/verify queries)** in
      `packages/local-db/src/asset-repository.test.ts` (new file — `AssetRepository` has no
      dedicated test yet; the existing coverage lives in `repositories.test.ts`, so create this
      file or add the cases there) against `createInMemoryDb()`:
      `findByContentHash` returns an existing asset (any-by-hash) and `null` for an unknown hash;
      `findLiveByContentHash` returns the asset whose owning element still exists (live OR
      soft-deleted-but-restorable) and `null` for an unknown hash; `referencedRelativePaths`
      returns the relative paths of all live asset rows and EXCLUDES nothing for a
      soft-deleted-but-restorable owner (its row is still live, so its path is still referenced —
      assert the file is NOT an orphan); after a hard-purge of the owning element (via
      `TrashRepository.purge`, which cascade-deletes the asset row) the purged asset's path is
      ABSENT from `referencedRelativePaths` (so its leftover FILE would be a GC candidate). Do NOT
      test for a dangling "asset row whose element is gone" — the cascade FK makes that state
      unreachable; the orphan is the unreferenced file. If `deleteAssetRow` is kept, assert it
      removes exactly one row.
- [ ] **Tests (integration, AssetVaultService on a fixture vault)** in
      `apps/desktop/src/main/asset-vault-service.test.ts` against a real temp-file DB + temp
      `assetsDir` (the desktop-main pattern): `importAsset` streams bytes to the vault + records
      metadata whose `contentHash` matches a streamed re-hash; importing IDENTICAL bytes a second
      time **dedups** (no second copy on disk per the chosen policy; the asset count/byte usage
      reflects it); `verifyIntegrity` reports `ok` for an intact vault, flags a MISMATCH when a
      stored file is corrupted on disk, and flags MISSING when a referenced file is deleted, and
      lists an `extraFile` placed with no row; `findOrphans` finds the leftover FILE of an element
      that was HARD-purged (drive a real `TrashRepository.purge` so the cascade deletes the asset
      ROW while the file stays on disk — the file is now unreferenced and orphaned) plus a stray
      no-row file, but does NOT flag the file of a live OR soft-deleted-but-restorable owner (its
      row is still live, so its path is still referenced); `collectOrphans({ confirm: true })`
      removes ONLY the confirmed orphan FILES and returns the right `removed`/`freedBytes`, while
      a referenced/shared file is untouched. **Restart persistence:** re-open the DB after a GC
      sweep and assert the surviving assets + their bytes are intact and the removed files stay
      gone.
- [ ] **Tests (contract)** — extend
      [`../../apps/desktop/src/shared/contract.test.ts`](../../apps/desktop/src/shared/contract.test.ts):
      `VaultCollectOrphansRequestSchema` REJECTS a payload without `confirm: true` (the guard
      against an accidental destructive sweep) and accepts `{ confirm: true }` and `{ confirm:
      true, relativePaths: [...] }` (the file-centric orphan allow-list); the verify/orphans
      result types round-trip (an orphan entry is `{ relativePath, size }`, no `assetId`/`reason`).
- [ ] **Tests (E2E, Electron)** — a small `tests/electron/` flow (or fold into an existing one):
      import a URL source (which writes vault snapshots), run `vault.verify` → `ok` covers them;
      soft-delete then HARD-purge the source (via the existing Trash flow — the purge's cascade FK
      deletes the snapshot `assets` rows but leaves their FILES on disk, which is precisely what
      makes those files orphans), run `vault.findOrphans` → those leftover snapshot FILES appear,
      `vault.collectOrphans({ confirm: true })` frees them, and after an **app restart** they stay
      gone while every still-referenced asset survives.
- [ ] **Fixtures/seed** — no seed change required. The large-file fixtures are generated in-test
      (do not commit large binaries).
- [ ] **Docs** — check the T059 box in [`../roadmap.md`](../roadmap.md) with the commit ref + a
      Progress-log line noting: streamed write+hash, content-hash dedup-on-write, integrity
      verify, confirmable **file-centric** orphan GC, the new `vault.*` `window.appApi` surface,
      and that the vault remains the canonical local store (NO app-facing S3). Also **confirm**
      the `assets` row in [`../domain-model.md`](../domain-model.md) (~line 135) still matches the
      schema: it already lists `vault_root` + `relative_path` (POSIX, no leading slash) and NO
      `location` column, exactly like the real schema
      ([`../../packages/db/src/schema/system.ts`](../../packages/db/src/schema/system.ts) ~lines
      37–40) — so no change is expected here. If you ever find it drifted back to a `location`
      column, correct it; otherwise leave it as-is.

### Done when

- The filesystem asset vault robustly handles large binaries: writes are **streamed/chunked and
  hashed as they write** (no whole-file-in-memory), bytes go to the vault under the canonical
  layout and metadata to `assets` in a transaction, and the bytes NEVER touch SQLite.
- **Content-hash dedup on write** reuses existing bytes (via `findByContentHash` /
  `assets_content_hash_idx`) instead of storing a second copy of identical content.
- **Integrity verification** re-hashes stored bytes (streamed) and reports mismatches / missing
  files / extra files against the recorded `assets.content_hash`.
- **Orphan GC** identifies vault FILES that no live `assets` row references (the bytes a
  hard-purge's cascade left on disk), surfaces them for confirmation, and removes ONLY confirmed
  orphan files — never a file still referenced, never an asset reachable from the Trash; the
  destructive command is guarded by `confirm: true`.
- All of it is behind `AssetRepository` + the typed `window.appApi.vault.*` surface — the
  renderer never resolves a raw path, reads/writes bytes, or runs SQL; there is **no app-facing
  S3** (object storage exists only inside the future encrypted-backup server).
- Heavy verify/GC sweeps run as background jobs on the T058 runner (off-main). Everything
  **survives an app restart** (the vault stays consistent; a GC sweep's removals stay gone, its
  survivors intact). `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm e2e
  --project=electron` pass.

### Notes / risks

- **GC safety is the load-bearing risk — "do not silently destroy user data."** The orphan unit
  is the **vault FILE**, and the predicate must be conservative: a file is reclaimable ONLY when
  NO live `assets` row references its canonical relative path. The trigger that creates such files
  is a HARD-purge (`TrashRepository.purge`/`emptyTrash`, T044): its cascade FK deletes the asset
  ROWS but never touches the filesystem, so the unreferenced bytes are left behind. A merely
  soft-deleted element keeps its asset row LIVE, so its files are still referenced and MUST
  survive (it is restorable from the Trash). GC is always two-step: `findOrphans` shows exactly
  which files would be freed, `collectOrphans({ confirm: true })` removes precisely that set
  (optionally a UI-confirmed `relativePaths` allow-list). Never delete a file referenced by
  another live asset row (the shared-path dedup policy makes this a real case). When in doubt,
  KEEP the file — an orphaned file costs disk; a wrongly-deleted referenced file costs user data.
  Do NOT build GC around an "asset row whose element is gone" predicate: the cascade FK makes that
  state unreachable, so such a sweep would find nothing while the real orphans (leftover files)
  go unreclaimed.
- **Dedup policy must match GC.** Whichever dedup-on-write policy is chosen (shared `relative_path`
  reuse vs. refuse-second-row), GC's "is this file still referenced?" check MUST be consistent
  with it. Prefer shared-path reuse + a path-reference-aware GC (the `referencedRelativePaths`
  set); document the choice in both the `AssetVaultService` and the
  `AssetRepository.referencedRelativePaths` docblocks so they cannot drift.
- **No app-facing S3.** The vault on the local filesystem is the canonical asset store. The only
  object storage in the system is the future encrypted-backup server's bucket (T052), which holds
  opaque encrypted archives and is entirely out of scope here. Do not add an S3 client, a cloud
  upload, or a "remote vault" abstraction.
- **Streaming vs the existing small-file path.** Keep the existing `sha256`/`sha256File` +
  `writeFileSync` path for small files (HTML snapshots, the backup manifest) — it is correct and
  simpler. T059's streamed path is specifically for LARGE binaries (PDFs/images/audio/video that
  M14/M15 will import); do not rip out the working small-file callers.
- **Downstream:** M14 (PDF import) and M15 (rich-media cards) land their large binaries through
  `AssetVaultService.importAsset` (streamed + deduped), and their heavy parse/OCR/transcode work
  runs as T058 job types — so large media lands in this scaled vault and is processed on the
  on-device runner. The integrity-verify + orphan-GC make the growing vault maintainable
  (surfaced in the Analytics / Maintenance screen).

---

## Exit criteria for M12-infra (T058–T059)

- T058 and T059 are `[x]` in [`../roadmap.md`](../roadmap.md) with commit refs + Progress-log
  entries (noting the local-first re-scope: utilityProcess runner not pg-boss; local filesystem
  vault not S3).
- The desktop app has a **100% on-device background runner** (Electron `utilityProcess`) with a
  **persisted** `jobs` queue, typed enqueue + observe over `window.appApi`, retry/backoff, and
  resume-or-re-enqueue on **app restart** — proven by the URL-import fetch running off-main while
  main commits the source (single-writer SQLite intact, no `operation_log` op for the job
  itself).
- The asset vault robustly handles large binaries — **streamed write+hash**, **content-hash
  dedup on write**, **integrity verification**, and **confirmable orphan GC** (file-centric: it
  reclaims vault files no live `assets` row references, never a dangling row, which the cascade FK
  makes unreachable) — all behind `AssetRepository` + the typed `window.appApi.vault.*` surface,
  with NO app-facing S3 and bytes never in SQLite.
- Everything **survives an app restart** (the queue resumes; the vault stays consistent), source
  lineage is preserved (GC never removes referenced bytes), and the renderer touches no SQLite/
  Node/fs.
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, and the Electron Playwright E2E are green in CI;
  the `0007_*` `jobs` migration applies cleanly on an existing dev DB.

When M12-infra is complete, M14 (PDF/EPUB/document import — T064–T070) is unblocked: its
imported assets land in the scaled vault (T059) and its OCR/parsing run on the on-device runner
(T058).
