# M1 — Foundations & local persistence (T001–T011)

Detailed, buildable specs for the first milestone. After these eleven tasks the app is an
empty-but-real local-first shell: a pnpm monorepo, a typed domain, a native SQLite
database behind repositories inside an Electron desktop shell, seed data, an inspector, and
settings. No reading features yet — those start in M2.

The canonical architecture is an **Electron desktop app**: a React + TypeScript + Vite
**renderer** for UI only, an Electron **main process** owning all trusted local
capabilities, and a **native SQLite** database file (via `better-sqlite3`) with Drizzle
ORM. Large assets live on the filesystem in an **asset vault**, never in the DB. The
renderer never talks directly to SQLite or arbitrary filesystem APIs — it calls a narrow
typed `window.appApi` exposed by the preload bridge over validated IPC. M1 adds
`apps/desktop` (Electron main/preload/lifecycle/windows/IPC/paths/backups) and
`packages/local-db` (the SQLite adapter + repositories + transactional domain operations +
operation-log append), while `apps/web` becomes the pure UI renderer.

Read first: [`../architecture.md`](../architecture.md), [`../domain-model.md`](../domain-model.md),
[`../design-system.md`](../design-system.md) (for T003/T004/T010/T011),
[`../../CLAUDE.md`](../../CLAUDE.md). Spec contract: [`_TEMPLATE.md`](./_TEMPLATE.md).

Native **pnpm** is the canonical way to run, dev, and test the desktop app
(`pnpm typecheck` / `pnpm test` / `pnpm lint`). The Docker/compose/Makefile setup is kept
but re-scoped to the future **server phase** only (`api`/`worker`/`db`/`minio`); it is no
longer canonical for the desktop app.

Build order is the task order; each depends on the previous unless noted. T005 can be built
in parallel with T003/T004 (it only depends on T001).

---

## T001 — Create the monorepo

- **Status:** `[x]`  · **Depends on:** none

### Goal
A pnpm + Turborepo workspace with the full app/package skeleton, so every later task has a
home and root-level task commands exist.

### Deliverables
- [x] `pnpm-workspace.yaml`, root `package.json`, `turbo.json`, root `tsconfig.json`.
- [x] App dirs `apps/web` (the Electron **renderer**), `apps/api` (api may be a stub
      package for now, server-phase only).
- [x] Package dirs `packages/{core,db,scheduler,editor,ui,testing}`, each with its own
      `package.json` + `tsconfig.json` and an `index.ts` that exports something trivial.
      `apps/desktop` and `packages/local-db` are added in T007/T008.
- [x] Root scripts that Turbo fans out: `dev`, `build`, `test`, `typecheck`, `lint`.
- [x] `.gitignore`, `.nvmrc`/`engines` pin (native pnpm is canonical for the desktop app).

### Done when
- The workspace installs cleanly and `pnpm dev`, `pnpm test`, `pnpm typecheck`,
  `pnpm lint` all run from the repo root (they may be near-empty but must succeed).

### Notes
- Keep package names scoped, e.g. `@interleave/core`. Use TS project references so
  `packages/core` can be imported by `apps/web` without a build step in dev.
- **Committed.** `apps/web` is the React + Vite renderer of the Electron app, not a
  standalone PWA.

---

## T002 — Tooling + CI gates (+ server-phase Docker)

- **Status:** `[x]`  · **Depends on:** T001

### Goal
Make native **pnpm** the canonical way to run, dev, and test the desktop app, and make CI
reject bad changes. The Definition of Done uses `pnpm typecheck` / `pnpm test` /
`pnpm lint`. The existing Docker/compose/Makefile setup is kept but re-scoped to the future
server phase only.

### Deliverables
- [x] **Strict TypeScript** baseline (`strict: true`, `noUncheckedIndexedAccess`, etc.).
- [x] **Biome** config for format + lint (JS/TS/JSON/CSS).
- [x] **Vitest** config (workspace-aware) with one passing sample unit test.
- [x] **Playwright** config with one passing smoke E2E (loads the app shell).
- [x] **Server-phase Docker (not canonical for the desktop app):**
  - `docker/Dockerfile.app`, `docker/Dockerfile.e2e`, `docker-compose.yml`, and the
    `Makefile` are **kept but reframed** for the future server phase
    (`api`/`worker`/`db`/`minio`). They are not used to run, dev, or test the Electron
    desktop app — do not delete them, but treat them as server-phase tooling.
- [x] **CI** (GitHub Actions or equivalent) running `pnpm typecheck`, `pnpm lint`,
      `pnpm test`, and the smoke Playwright E2E on the host toolchain (native pnpm).

### Done when
- CI fails on a type error, a lint error, a unit-test failure, and a smoke-E2E failure
  (verify by temporarily introducing each, then reverting).
- `pnpm typecheck`, `pnpm test`, and `pnpm lint` run on the canonical native toolchain.

### Notes
- Document the canonical `pnpm` commands in the root `README` and confirm they match
  `architecture.md` and the Definition of Done in `CLAUDE.md`. Note that Docker/`make` is
  reserved for the future server phase.
- **Committed.**

---

## T003 — Scaffold the React renderer

- **Status:** `[x]`  · **Depends on:** T002

### Goal
A running React renderer with routing and styling, ready to host screens (the UI half of
the Electron desktop app).

### Deliverables
- [x] `apps/web` on Vite + React 19 + TS — the Electron **renderer** (UI only).
- [x] TanStack Router with typed routes: `/`, `/inbox`, `/queue`, `/source/$id`, `/review`,
      `/search`, `/settings`. Each route renders a placeholder for now.
- [x] **Adopt the design tokens:** import [`../../design/tokens.css`](../../design/tokens.css)
      globally and derive the Tailwind v4 `@theme` from those variables (do not re-declare
      colors/spacing). Wire `data-theme` light/dark and the IBM Plex font load.
- [x] **Icons:** add `lucide-react` and a thin `Icon` wrapper per
      [`../../design/icon-map.md`](../../design/icon-map.md) (default `strokeWidth ≈ 1.75`).

### Done when
- `pnpm dev` serves the renderer; all seven routes load and are reachable by URL.
- Tokens are live: toggling `data-theme` switches light/dark; Tailwind utilities resolve to
  token values (spot-check accent + surface).
- The smoke E2E from T002 navigates between at least two routes.

### Notes
- No domain logic in components (see layering). Routes are placeholders; data wiring comes
  after the Electron shell + native SQLite land (T007), and the renderer will reach data
  only through the typed `window.appApi`.
- This is the first UI task — read [`../design-system.md`](../design-system.md). The full
  screens come later; here you only stand up the token/theme/icon foundation + routing.
- **Committed.**

---

## T004 — App shell skeleton

- **Status:** `[x]`  · **Depends on:** T003

### Goal
The persistent workspace chrome every screen shares.

### Deliverables
- [x] Layout matching `design/kit/app/shell.jsx`: left sidebar (brand, primary nav +
      "Organize" group, streak, user/"Local vault" chip), top command bar, central work
      area, right inspector, bottom status bar — using the layout dim tokens
      (`--sidebar-w`, `--inspector-w`, `--topbar-h`).
- [x] `⌘K` **command palette** and `?` **cheat sheet** (`CheatSheet`), plus `g`+letter
      navigation, per the prototype.
- [x] All seven routes render inside this shell.

### Done when
- Every main route uses the same shell and is navigable by keyboard; ⌘K and ? work.
- The shell matches the design in both light and dark (compare to `screenshots/`).

### Notes
- The right panel is a placeholder container now; T010 fills it with the inspector.
- Match the prototype's *visual output*, rebuilt in our components — don't copy its
  Babel-in-browser structure. Keep it "dense but calm."
- **Committed.**

---

## T005 — Domain language in `packages/core`

- **Status:** `[ ]`  · **Depends on:** T001  · _(parallelizable with T003/T004)_

### Goal
The shared, documented vocabulary the whole codebase imports. This is where the
[`domain-model`](../domain-model.md) becomes code.

### Deliverables
- [ ] TS types/enums for: `Element`, `ElementType`, `ElementStatus`, `DistillationStage`,
      `Priority` (numeric type + A/B/C/D mapping), `ReviewState`, `ReviewLog`, `Source`,
      `Document`, `ElementRelation`, `ElementLocation`.
- [ ] **New for the desktop pivot:** `Asset`, `AssetLocation`, `OperationLogEntry`,
      `LocalVaultPath` — the vocabulary for the filesystem asset vault and the
      operation log that back native SQLite persistence.
- [ ] Doc comments on each, citing the invariant they protect (lineage, stage vs status,
      asset-vault separation, command/op-log shape).
- [ ] Unit tests for any helpers (e.g. priority numeric↔label conversion).

### Done when
- Types are exported from `@interleave/core` and consumed by both `apps/web` and tests.
- `pnpm typecheck` and `pnpm test` pass.

### Notes
- Match the enum values exactly to `domain-model.md` and `CLAUDE.md` (no casual renames).
- Keep these framework-agnostic — no React, no Drizzle, no `better-sqlite3` imports here.
- `OperationLogEntry` models a command-like mutation (e.g. `create_element`,
  `update_element`, `soft_delete_element`, `add_review_log`, `reschedule_element`); it is
  consumed by `packages/local-db` (T008) when appending to the `operation_log`.

---

## T006 — Native SQLite + Drizzle schema

- **Status:** `[ ]`  · **Depends on:** T005

### Goal
The relational SQLite schema (Drizzle, SQLite dialect) and migrations that can
create/reset a dev database.

### Deliverables
- [ ] Drizzle tables (SQLite dialect) in `packages/db`: `elements`, `documents`,
      `document_blocks`, `document_marks`, `sources`, `source_locations`,
      `element_relations`, `read_points`, `cards`, `review_states`, `review_logs`,
      `concepts`, `tags`, `element_tags`, `tasks`, `assets`, `operation_log`, `settings`.
- [ ] Columns aligned with [`domain-model`](../domain-model.md) and `@interleave/core`
      (only what M1–M10 needs; leave sync/server-only fields for later milestones). The
      `assets` table stores stable asset IDs, relative vault paths, content hashes, MIME
      types, sizes, timestamps, and owning element IDs — never blob payloads. FTS tables
      (`source_fts`, `extract_fts`, `card_fts`) come with search later.
- [ ] Stable UUID/ULID-style IDs generated in domain services (not DB autoincrement).
- [ ] Drizzle migration files (drizzle-kit generate/migrate) + a dev reset script.
- [ ] Schema round-trip tests (insert/select for a couple of tables) run against a
      **temporary in-memory `better-sqlite3`** database.

### Done when
- Migrations create the schema from empty and reset cleanly.
- Types inferred from Drizzle align with `@interleave/core` (no drift).
- Round-trip tests pass against in-memory `better-sqlite3`.

### Notes
- This schema targets native SQLite locally (`better-sqlite3`) and PostgreSQL later in the
  server phase — keep types portable, but the canonical local dialect is SQLite.
- Any future schema change ships its own migration (Definition of Done).

---

## T007 — Electron desktop shell + native SQLite persistence

- **Status:** `[ ]`  · **Depends on:** T006, T003

### Goal
Stand up the Electron desktop app that owns all trusted local capabilities and persists
data in a native SQLite file, with the renderer reaching it only through a narrow typed
preload bridge. This replaces the previous browser-storage approach.

### Deliverables
- [ ] **Create `apps/desktop`** — the Electron main process, preload, app lifecycle,
      window management, native menus, IPC, filesystem paths, and backups. In dev it loads
      the Vite dev server (`apps/web` renderer); in production it loads the built renderer
      files.
- [ ] **Secure window:** `contextIsolation: true`, `nodeIntegration: false`,
      `sandbox: true` if practical, `enableRemoteModule: false`. The renderer has no raw
      Node/filesystem/SQLite access.
- [ ] **Narrow typed preload bridge:** expose `window.appApi` over **validated IPC**
      (Zod or equivalent on every payload). M1 surface: `app.health()`, `db.getStatus()`,
      `settings.get()/settings.update()`. Never expose a generic `db.query(sql)` to the
      renderer.
- [ ] **App data dir + asset vault:** initialize the app data directory (e.g.
      `~/Library/Application Support/<app>/`) containing `app.sqlite` (+ `-wal`/`-shm`),
      `assets/`, and `backups/`. Create the vault skeleton on first launch.
- [ ] **Open SQLite with pragmas:** `better-sqlite3` with `PRAGMA foreign_keys = ON`,
      `journal_mode = WAL`, `busy_timeout = 5000`.
- [ ] **Run migrations on startup:** run the Drizzle (T006) migrations against the local
      SQLite DB on launch, in an explicit and safe way for production.
- [ ] **Health command:** a `app.health()` / `db.getStatus()` command callable from the
      renderer that reports the DB is open and migrated.

### Done when
- The app boots as an Electron desktop app (macOS at minimum).
- Data written to SQLite persists across a full **app restart** (not just a window reload).
- An automated test confirms a value survives an app restart.
- The renderer reaches persistence only through `window.appApi`; no raw DB/filesystem APIs
  are exposed to it.

### Notes
- Layering is enforced: React UI → typed client API wrapper → preload bridge →
  Electron main/DB service → `packages/local-db` repositories → SQLite + filesystem vault.
- The DB lives under the app data directory; large assets go to the filesystem vault
  (T008/later), never into SQLite.
- Keep the Electron security posture strict — this shell owns trusted capabilities so the
  renderer never has to.

---

## T008 — Repository classes in `packages/local-db`

- **Status:** `[ ]`  · **Depends on:** T007

### Goal
The persistence/domain seam behind the Electron/IPC boundary. React never touches SQL.

### Deliverables
- [ ] **Create `packages/local-db`** (the SQLite adapter via `better-sqlite3` +
      repositories + transactional domain operations + operation-log append) with:
      `ElementRepository`, `DocumentRepository`, `SourceRepository`, `ReviewRepository`,
      `QueueRepository`, `SearchRepository`, `AssetRepository`, `SettingsRepository`,
      `OperationLogRepository`, each with CRUD + the queries M1 needs.
- [ ] Every meaningful mutation **appends an `operation_log` entry** (command-like:
      `create_element`, `update_element`, `soft_delete_element`, `restore_element`,
      `create_source`, `update_document`, `set_read_point`, `create_extract`,
      `create_card`, `add_review_log`, `reschedule_element`, `add_relation`,
      `remove_relation`, `add_tag`, `remove_tag`).
- [ ] Multi-table domain operations run inside SQLite **transactions**; soft-delete
      (`deleted_at`) semantics start here.
- [ ] The renderer consumes these repositories **only via typed `appApi` commands** over
      IPC — never directly.
- [ ] Per-repository smoke tests for referential integrity + persistence (run against a
      temp `better-sqlite3` instance via `packages/testing`).

### Done when
- All data access in the app goes through repositories; no SQL in components.
- Meaningful mutations write an `operation_log` entry.
- `pnpm test` covers each repository's core behavior, referential integrity, and
  persistence.

### Notes
- Keep repository methods small and composable. Soft-delete semantics start here
  (`deleted_at`), even before the trash UI (T044).
- The operation log is not a sync engine yet — just make mutations command-like and
  logged so backup/audit/undo/cloud-sync can build on it later.

---

## T009 — Seed data & fixtures

- **Status:** `[ ]`  · **Depends on:** T008

### Goal
A realistic demo collection for development and tests.

### Deliverables
- [ ] A **desktop dev seed command** that resets the dev SQLite DB and creates realistic
      sample data: a source with document blocks, an extract with a source location, a
      sub-extract, a Q&A card, a cloze card, review state/logs, concepts/tags, asset
      metadata, and the corresponding `operation_log` entries.
- [ ] Shared factories/fixtures in `packages/testing` reused by Vitest and Playwright.

### Done when
- The dev seed command yields a usable demo collection; tests can build deterministic
  fixtures.

### Notes
- Content should exercise lineage (card → extract → source location) so later screens have
  something meaningful to render.
- Seeded asset metadata points at vault paths/hashes — the seed writes metadata to SQLite,
  not blob payloads into the DB.

---

## T010 — Universal element inspector

- **Status:** `[ ]`  · **Depends on:** T008, T004

### Goal
One consistent right-panel view of any element's metadata.

### Deliverables
- [ ] Inspector built from the design primitives (`MetaRow`, `TypeIcon`, `Prio`, `Stage`,
      `Status`) showing: type, status, stage, priority, due date, parent, children, source,
      tags, review metadata.
- [ ] **Scheduler-aware:** show a `SchedulerChip` — FSRS signals (retrievability/stability)
      for cards vs attention signals (stage/priority/last-processed/postponed×N) for
      sources/extracts/topics. Wire the presentation now from seeded data; real values land
      with T028/T036.
- [ ] A selection mechanism (selected-element state) the rest of the app can set.

### Done when
- Selecting any element shows consistent, type-appropriate metadata and the correct
  scheduler chip, matching [`../design-system.md`](../design-system.md).

### Notes
- Read-only for M1 (editing priority/stage comes with T027 and the relevant features).
- Pull data **through the typed `window.appApi`** (preload bridge → main → repositories),
  never via direct DB or filesystem calls from the renderer.

---

## T011 — Local settings

- **Status:** `[ ]`  · **Depends on:** T008

### Goal
Persisted user settings that scheduling and UI read.

### Deliverables
- [ ] Settings model + `SettingsRepository`-backed read/write **stored in the SQLite
      `settings` table** for: daily review budget, default desired retention, default topic
      interval, default source priority, keyboard layout, theme.
- [ ] A `/settings` UI to view/edit them (reading/writing through the typed
      `settings.get()/settings.update()` `appApi` commands).

### Done when
- Settings persist in SQLite across app restart and are read by scheduler code (verify the
  scheduler/queue picks up at least the daily budget + default priority once those exist).

### Notes
- Prefer SQLite for user/domain settings; reserve Electron config for app-level desktop
  settings (e.g. window bounds) only if needed.
- These values feed T028 (topic scheduler) and T036/T037 (FSRS review). Keep keys stable —
  they'll be part of backup/export (T047).

---

## Exit criteria for M1

- All of T001–T011 are `[x]` in [`../roadmap.md`](../roadmap.md).
- The app **boots as an Electron desktop app**, persists data in native **SQLite** across a
  full **app restart**, shows seeded elements in the inspector, and respects settings.
- The renderer reaches data only through the typed `window.appApi`; **no raw
  DB/filesystem APIs are exposed to the renderer**.
- `pnpm typecheck`, `pnpm test`, and the smoke Playwright E2E are green in CI.

When M1 is complete, generate `tasks/M2-capture-and-inbox.md` from the roadmap before
starting T012.
</content>
