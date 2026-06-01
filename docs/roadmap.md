# Roadmap — the build queue

This is the **single source of truth for orchestration**. Each entry is one buildable
task. An agent picks the lowest-numbered unchecked task whose dependencies are all `[x]`,
builds the feature + tests with native pnpm (`pnpm typecheck` / `pnpm test` / `pnpm lint`),
then checks the box and records the commit.

> **Architecture (authoritative):** the MVP ships as a local-first **Electron desktop app**
> on a **native SQLite** database (via **better-sqlite3** + Drizzle, SQLite dialect) — **not**
> a browser PWA, and **not** PGlite. The React + TypeScript + Vite app is a pure **renderer**;
> the **Electron** shell (main process, preload, IPC) owns all trusted local capabilities.
> SQLite is the canonical local database; the filesystem **asset vault** is the canonical
> local store for PDFs/snapshots/images/media/exports/backups. The renderer **never** talks
> directly to SQLite or arbitrary filesystem APIs — it calls a narrow typed `window.appApi`
> bridge. Layering: React UI → typed client API wrapper → preload bridge → Electron main/DB
> service → `packages/local-db` repositories/services → SQLite + vault. Native **pnpm** is the
> canonical way to run/dev/test the desktop app; the Docker/compose/Makefile setup is re-scoped
> to the **future encrypted-backup server only** (a thin `api` + minimal `db` + `minio`
> blob store — no sync tier, no server-side `worker`; on-device work runs in a local runner).

**Status legend:** `[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked.
Add `· (branch/commit)` after the title when you start/finish.

Format per task:

```
- [ ] **T0NN — Title** · _deps: T0xx, T0yy_
  Done when: <criterion>.
```

Reference docs: [`concept`](./concept.md) · [`architecture`](./architecture.md) ·
[`domain-model`](./domain-model.md) · [`scheduling-and-priority`](./scheduling-and-priority.md)
· [`design-system`](./design-system.md) · charter: [`../CLAUDE.md`](../CLAUDE.md).

> **UI tasks follow the design kit.** Every screen below has a matching prototype in
> [`../design/kit/`](../design/) — see the screen→milestone map in
> [`design-system.md`](./design-system.md). Use `design/tokens.css` and `lucide-react`; match
> the design pixel-for-pixel.

---

# Part I — Decent MVP (T001–T050)

Goal: a genuinely useful single-person, local-first incremental reading app — a local-first
**Electron desktop app** on **native SQLite**. **No** PDF, sync, AI, browser extension, or
mobile yet.

## M1 — Foundations & local persistence (T001–T011)
Detailed specs: [`tasks/M1-foundations.md`](./tasks/M1-foundations.md)

- [x] **T001 — Create the monorepo** · done · _deps: none_
  Done when: pnpm workspace with `apps/web` (the Electron **renderer**, pure UI), `apps/api`, `packages/{core,db,scheduler,editor,ui,testing}` exists and root scripts run from the repo root. (Pivot: `apps/desktop` (Electron main/preload/lifecycle) and `packages/local-db` are added in T007/T008; native pnpm — `pnpm typecheck`/`pnpm test`/`pnpm lint` — is the canonical desktop toolchain.)
- [x] **T002 — Tooling + CI gates (Docker re-scoped to server phase)** · done · _deps: T001_
  Done when: strict TypeScript, Biome, Vitest, Playwright, and CI are wired so CI rejects type errors, lint errors, unit failures, and one smoke E2E failure. (Pivot: native `pnpm typecheck`/`pnpm test`/`pnpm lint` are canonical for the desktop app; the existing Dockerfiles/`docker-compose.yml`/`Makefile` are kept but re-scoped to the **future server phase only** — `api`/`worker`/`db`/`minio` — and are no longer canonical for building/running the app.)
- [x] **T003 — Scaffold the React renderer** · done · _deps: T002_
  Done when: `apps/web` runs as the Vite + React + TS + TanStack Router + Tailwind v4 **renderer** with routes `/`, `/inbox`, `/queue`, `/source/$id`, `/review`, `/search`, `/settings`. (Pivot: `apps/web` is a pure UI renderer that talks to `window.appApi` in desktop mode, not a standalone PWA.)
- [x] **T004 — App shell skeleton** · done · _deps: T003_
  Done when: left sidebar, top command bar, central work area, right inspector, bottom status bar; every main route uses the same shell and is keyboard-navigable.
- [x] **T005 — Domain language in `packages/core`** · done · _deps: T001_
  Done when: documented TS types for `Element`, `ElementType`, `ElementStatus`, `DistillationStage`, `Priority`, `ReviewState`, `ReviewLog`, `Source`, `Document`, `ElementRelation`, `ElementLocation`, plus the new desktop types `Asset`, `AssetLocation`, `OperationLogEntry`, and `LocalVaultPath`, used by app and tests.
- [x] **T006 — Native SQLite + Drizzle schema** · done · _deps: T005_
  Done when: `packages/db` holds the Drizzle schema (**SQLite dialect**) and migrations for `elements`, `documents`, `document_blocks`, `document_marks`, `sources`, `source_locations`, `element_relations`, `read_points`, `cards`, `review_states`, `review_logs`, `concepts`, `tags`, `element_tags`, `tasks`, `assets`, `operation_log`, and `settings`; types align with `@interleave/core`; `drizzle-kit generate`/`migrate` plus a dev-reset can create and reset a dev database; schema round-trips against a temporary in-memory **better-sqlite3** DB in tests. Stable UUID/ULID-style IDs are generated in domain services. FTS tables (`source_fts`, `extract_fts`, `card_fts`) arrive with search later. (Pivot: native SQLite via better-sqlite3 — **no PGlite**.)
- [x] **T007 — Electron desktop shell + native SQLite persistence** · done · _deps: T006, T003_
  Done when: `apps/desktop` exists with a secure Electron window (`contextIsolation: true`, `nodeIntegration: false`, `sandbox` where practical, `enableRemoteModule: false`) and a **narrow typed preload bridge** exposing `window.appApi` (initially `app.health()`, `db.getStatus()`, `settings.get/update()`) with validated IPC payloads (Zod or equivalent); the app data directory is initialized (e.g. `~/Library/Application Support/<app>/` with `app.sqlite` + `-wal`/`-shm`, `assets/`, `backups/`); SQLite is opened via better-sqlite3 with `PRAGMA foreign_keys=ON`, `journal_mode=WAL`, `busy_timeout=5000`; Drizzle migrations run on startup (explicit/safe in production); in dev Electron loads the Vite dev server and in production it loads the built renderer files; a health command is callable from the renderer through `window.appApi`; data **persists across app restart**. The renderer has no raw Node/filesystem/SQLite access and never sees a generic `db.query(sql)`. (Pivot: replaces the old PGlite task entirely — native SQLite, not browser storage.)
- [x] **T008 — Repository classes in `packages/local-db`** · done · _deps: T007_
  Done when: `ElementRepository`, `DocumentRepository`, `SourceRepository`, `ReviewRepository`, `QueueRepository`, `SearchRepository`, `AssetRepository`, `SettingsRepository`, and `OperationLogRepository` live in `packages/local-db` behind the Electron/IPC boundary; meaningful mutations are transactional (multi-table operations in one transaction) and append `operation_log` entries; deletes are soft (`deleted_at`); the renderer consumes repositories **only** via typed `window.appApi` commands (no React component touches SQL); per-repo smoke tests cover referential integrity + persistence.
- [x] **T009 — Desktop dev seed & fixtures** · done · _deps: T008_
  Done when: a desktop dev seed command resets the dev SQLite DB and creates a realistic demo collection — a source with document blocks, an extract with a source location, a sub-extract, a Q&A card, a cloze card, review state/logs, concepts/tags, asset metadata, and `operation_log` entries; shared factories/fixtures live in `packages/testing` and are reused by both Vitest and Playwright.
- [x] **T010 — Universal element inspector** · done · _deps: T008, T004_
  Done when: the right panel shows any selected element's type, status, stage, priority, due date, parent, children, source, tags, and review metadata — fetched **through the typed `window.appApi`** (never direct DB access from the renderer).
- [x] **T011 — Local settings in SQLite** · done · _deps: T008_
  Done when: settings for daily review budget, default desired retention, default topic interval, default source priority, keyboard layout, and theme persist in the SQLite `settings` table (user/domain settings prefer SQLite; Electron config is used only for app-level desktop settings if needed) and are read by scheduler code through the typed API.

## M2 — Capture & inbox (T012–T014)

- [x] **T012 — Inbox · done** · _deps: T008, T004_
  Done when: a source can be created in inbox, listed, viewed, kept, prioritized, accepted into active learning, or deleted.
- [x] **T013 — Manual text import · done** · _deps: T012_
  Done when: a "New source" modal accepts title/URL/author/date/body and stores body as both plain text and ProseMirror JSON; a pasted article appears as a source in the inbox.
- [x] **T014 — Source provenance fields (no auto-fetch)** · done · _deps: T013_
  Done when: schema/UI capture canonical URL, original URL, accessed date, and snapshot fields for manual imports (no remote fetching yet).

## M3 — Document editor & reading (T015–T018)

- [x] **T015 — Tiptap document editor** · done · _deps: T013, T005_
  Done when: a source body renders/edits with a constrained schema (headings, paragraphs, bold, italic, links, blockquotes, lists, code, hr); edits save and reload.
- [x] **T016 — Stable block IDs** · done · _deps: T015_
  Done when: every block node has a stable ID preserved across imports and saves (basis for extraction/read-points/sync).
- [x] **T017 — Read-points** · done · _deps: T016_
  Done when: `read_point` (block ID + offset) is stored on source/topic; set/jump/auto-update-on-extract work; reopening a source resumes near the last read-point.
- [x] **T018 — Source reading mode · done** · _deps: T017, T004_
  Done when: a clean reader shows title, metadata, body, read-point marker, extracted-span markers, and keyboard actions — pleasant enough to process a long article.

## M4 — Highlights, extraction & lineage (T019–T026)

- [x] **T019 — Text-selection toolbar** · _deps: T018_ · done
  Done when: selecting text in the reader shows an inline toolbar (Extract, Cloze, Highlight, Copy, Cancel) without breaking editor selection.
- [x] **T020 — Highlights** · _deps: T019_ · done
  Done when: highlight marks persist as document annotations and can be removed (highlights are NOT extracts).
- [x] **T021 — Extraction** · _deps: T019, T008_ · done
  Done when: Extract creates a child `extract` element with its own document body, source reference, parent link, source location, inherited priority, and scheduled review state; the parent text is visually marked extracted.
- [x] **T022 — Source locations** · _deps: T021_ · done
  Done when: each extract stores source element ID, block IDs, start/end offsets, and a human-readable label; the user can jump from an extract back to the exact paragraph.
- [x] **T023 — Element hierarchy view** · done · _deps: T021, T010_
  Done when: source pages show a tree of children (extracts/sub-extracts/cards) and extract pages show parent + children; navigation works both directions.
- [x] **T024 — Extract review mode** · done · _deps: T021_
  Done when: extracts appear as readable mini-topics with trim/rewrite/split/convert/postpone/done/delete; an extract can move raw → clean → atomic.
- [x] **T025 — Extract splitting (sub-extracts)** · _deps: T024, T022_ · done
  Done when: selecting part of an extract creates a sub-extract with preserved lineage (source → extract → sub-extract).
- [x] **T026 — Mark processed on source text** · done · _deps: T020_
  Done when: processed spans can be collapsed/dimmed so the user can hide processed text without deleting the archived source.

## M5 — Priority, scheduling & queue (T027–T031)

- [x] **T027 — Priorities** · done · _deps: T008_
  Done when: priority is stored numerically and surfaced as A/B/C/D; every source/extract/card can be raised/lowered.
- [x] **T028 — Topic/extract scheduler** · done · _deps: T027, T005_
  Done when: a non-card scheduler computes `due_at` from priority, stage, last-seen, and action; items can be scheduled for tomorrow/next week/next month/manual. (See [`scheduling-and-priority`](./scheduling-and-priority.md).)
- [x] **T029 — Due queue** · done · _deps: T028, T004_
  Done when: `/queue` shows due sources/extracts/cards sorted by priority then due date, with filters for type/concept/status.
- [x] **T030 — Queue actions** · done · _deps: T029_
  Done when: each due item supports open/postpone/raise/lower/done/dismiss/delete without leaving the list.
- [x] **T031 — "Process queue" learning loop** · done · _deps: T030_
  Done when: a single mode shows one element at a time and advances after action; the user can process ten mixed elements without returning to a list.

## M6 — Cards (T032–T035)

- [x] **T032 — Card model & templates** · done · _deps: T008, T005_
  Done when: `card` elements have `card_type`, `prompt`, `answer`, `cloze_text`, `source_extract_id`, `sibling_group_id`; Q&A and cloze types exist as first-class elements with parents, priority, and review state.
- [x] **T033 — Q&A card creation** · done · _deps: T032, T024_
  Done when: from an extract, "Create Q&A card" shows prompt/answer/source-context/preview; the card appears in review.
- [x] **T034 — Cloze card creation** · done · _deps: T032, T024_
  Done when: selecting text in an extract creates a cloze card linked to the extract; clozes store `{{c1::answer}}` text plus structured cloze metadata.
- [x] **T035 — Card-quality warnings** · done · _deps: T033, T034_
  Done when: warnings flag prompt-too-long, answer-too-long, missing source, multiple clozes, ambiguous pronouns, and empty answer before activation.

## M7 — FSRS review (T036–T040)

- [x] **T036 — Integrate `ts-fsrs`** · _deps: T032_ · done
  Done when: a `SchedulerService` wraps `ts-fsrs` and persists FSRS state (due/stability/difficulty/elapsed/scheduled/reps/lapses) on `review_states`; new cards reschedule by rating.
- [x] **T037 — Review UI · done** · _deps: T036, T004_
  Done when: `/review` shows prompt → reveal → grade Again/Hard/Good/Easy, logs response time, updates scheduler state, advances; every review writes a durable `review_logs` row.
- [x] **T038 — Review editing** · done · _deps: T037_
  Done when: during review the user can edit prompt/answer, open source, suspend, delete, and flag-as-bad — fixing a bad card at the moment it fails.
- [x] **T039 — Sibling burying** · _deps: T037, T032_ · done
  Done when: cards from the same extract/cloze group don't appear back-to-back in a session unless burying is disabled.
- [x] **T040 — Basic leech detection** · done · _deps: T037_
  Done when: a card is marked leech after repeated failures (warn at 4 lapses) and appears in a cleanup view with rewrite/suspend/delete.

## M8 — Organize: concepts, tags, search, references (T041–T043)

- [x] **T041 — Concepts & tags** · done · _deps: T008_
  Done when: concepts (hierarchical) and tags (flat) can be created/assigned; elements filter by concept and tags.
- [x] **T042 — Search** · done · _deps: T008_
  Done when: local full-text search over source title/body, extract body, card prompt/answer, and tags returns sources/extracts/cards quickly with simple ranking.
- [x] **T043 — Source/reference display** · done · _deps: T022, T032_
  Done when: every extract and card shows source title/URL/author/date/location (review hides it until answer reveal); nothing feels orphaned.

## M9 — Safety, analytics & backup (T044–T047)

- [x] **T044 — Deletion, trash & undo** · done · _deps: T008_
  Done when: soft delete + trash view + restore exist; command-level undo covers delete/mark-done/suspend/bulk-postpone; accidental deletion is recoverable.
- [x] **T045 — Basic analytics** · done · _deps: T037, T028_
  Done when: a view shows daily reviews, due cards/topics, new cards/extracts, deletions, leeches, and 30-day retention.
- [x] **T046 — Import/process balance warnings** · _deps: T045_ · done
  Done when: the app warns when imports outpace processing, showing sources imported / extracts created / cards created / reviews due this week.
- [x] **T047 — Backup / export** · _deps: T008_ · done
  Done when: an Electron-managed backup exports a ZIP of `app.sqlite` + the `assets/` vault + a `manifest.json` (schema version, app version, timestamp, integrity hashes) into `backups/<timestamp>/`; the format is designed for restore from the start so a backup re-imports into a fresh install. (Pivot: backup is SQLite file + filesystem asset vault, not a JSON dump.)

## M10 — Keyboard, E2E & ship MVP as Electron desktop (T048–T050)

- [x] **T048 — Keyboard shortcuts & command palette** · done · _deps: T031, T037, T021_
  Done when: shortcuts exist for next-item, extract, cloze, postpone, done, delete, raise/lower priority, search, open-parent, open-source, and command palette; the main workflow is mouse-free. Shortcuts invoke commands through the **same typed `window.appApi` path** as the UI buttons (no separate mutation path).
- [x] **T049 — MVP end-to-end tests** · done · _deps: T048, T047_
  Done when: Playwright runs against the **Electron app** where feasible and covers import → activate → read → extract → convert-to-card → review → reschedule → search → backup, plus a **restart-app → verify-persistence** step proving data survives an app restart.
- [x] **T050 — Ship MVP as a local-first Electron desktop app** · done · _deps: T049_
  Done when: the app builds and runs as an Electron desktop app on macOS at minimum — SQLite persists in the app data directory, assets persist in the vault, backup works, the core loop works, the app survives restart, and no raw DB/filesystem APIs are exposed to the renderer; backup prompts and onboarding are polished; one person can use it daily for a week with no manual DB edits. (Pivot: ships as a desktop app, not a PWA.)

---

# Part II — Gold-standard application (T051–T100)

Goal: turn the useful MVP into a serious long-term system — imports, PDFs, capture, overload
management, semantic search, AI, media, reliability, scale — **while staying local-first**.

> **Direction (authoritative for Part II).** Interleave stays **local-first**: everything —
> import, reading, extraction, scheduling, review, search, AI — runs **on the device** against
> native SQLite + the filesystem asset vault. The server is **only an end-to-end-encrypted
> backup target**: it stores opaque archives + minimal metadata and **never** mirrors the domain
> model, replays the op-log, or processes content. There is **no live multi-device sync** — one
> canonical device + restore-to-a-fresh-install; two-way sync and conflict resolution are out of
> scope. The `operation_log` (built from day one) now powers **undo, audit, and incremental
> backup**, not server-side convergence. AI/semantic search run on-device (local model or the
> user's own API key) with an **optional, off-by-default** managed proxy.

## M11 — Backup & restore (local-first; server = encrypted backup only) (T051–T057)

> M11 collapses from the old "sync engine + server domain mirror + conflict resolution" into a
> small, low-risk **encrypted backup** milestone. Because nothing else depends on it, it no
> longer has to lead Part II — it can land whenever offsite durability is wanted.

- [ ] **T051 — Thin backup API skeleton** · _deps: T050_
  Done when: `apps/api` (Hono) exposes a SMALL typed surface — auth middleware, health checks, structured errors, and backup routes (`upload-archive`, `list-backups`, `download-archive`) — and the desktop app can call a typed endpoint in dev. It is **not** a domain RPC mirror: no element/card/extract endpoints, no `db.query`, no server-side domain logic.
- [ ] **T052 — Minimal server backup store** · _deps: T051_
  Done when: the server persists only what a blob backup needs — `users`, `devices`, and `backup_manifests` (id, user, device, created_at, size, content hash, encryption metadata, schema/app version, storage key) — plus the encrypted-archive bytes in object storage. The server schema does **not** mirror `elements`/`cards`/`documents`/etc.; it stores opaque ciphertext + metadata. Server migrations create a working DB.
- [ ] **T053 — Authentication** · _deps: T052_
  Done when: email/password or passkey-first auth identifies the user and gates their backups; self-host/personal mode remains possible. Auth protects *backup storage*, not live domain data (there is none on the server).
- [ ] **T054 — Incremental-backup design (op-log + asset manifest)** · _deps: T052_
  Done when: backup is designed around the local SQLite `operation_log` (introduced in T006/T008) + a content-hash asset manifest so a backup ships only what changed since the last one (new ops + new/changed asset bytes) rather than re-uploading everything. The op-log is the local changelog that makes backups incremental — it is **not** replayed into a server domain DB (no Postgres mirror, no Electric/PowerSync). Every local mutation already appends a deterministic op.
- [ ] **T055 — Encrypted backup & restore** · _deps: T054, T053_
  Done when: the desktop encrypts the SQLite DB + asset vault into an archive **client-side (end-to-end)** and uploads it to the server, and can restore it onto a fresh desktop install so the whole knowledge base (data + assets + lineage) comes back intact. The server only ever holds ciphertext. No multi-device conflict resolution (single canonical device).
- [ ] **T056 — Automatic backups, retention & integrity verification** · _deps: T055_
  Done when: backups can run automatically (scheduled / after-N-changes), old backups are pruned by a retention policy, every archive is integrity-verified (hash/manifest check), and a restore **drill** proves an archive restores cleanly — so backup is trustworthy and hands-off, not a manual chore. (Replaces the dropped two-way-sync task; there is no live sync.)
- [ ] **T057 — Backup encryption keys & recovery** · _deps: T055_
  Done when: the user's backup encryption is key-managed safely — a passphrase/key derives the archive encryption, recovery codes let a user restore on a new device, and re-keying is possible. Losing the key means losing the ability to restore (by design — the server cannot read the data), and the UI makes that consequence explicit. (Replaces the dropped conflict-UI task.)

## M12 — Local background runner, vault & web import (T058–T061)
Detailed specs: [`tasks/M12-web-import.md`](./tasks/M12-web-import.md)

- [ ] **T058 — Local background runner** · _deps: T050_
  Done when: an on-device background runner (an Electron utility process / `worker_threads` queue — **not** a server worker, **not** pg-boss) processes local jobs: URL fetch/snapshot, OCR, embeddings, AI calls, cleanup; the main process can enqueue a job and observe progress/completion. All work runs locally; nothing is sent to a server. (Re-scope: replaces the pg-boss/Postgres server worker — "everything is done locally".)
- [ ] **T059 — Asset-vault scaling for large media** · _deps: T058_
  Done when: the filesystem asset vault robustly handles large binaries (PDFs, images, audio/video, snapshots) — streamed read/write, content-hash dedup, integrity checks, and orphan GC — all behind the typed `window.appApi`/`AssetRepository` seam. The vault is the canonical local store for assets; there is **no** app-facing S3 (object storage exists only inside the T052 backup server, holding encrypted archives). (Re-scope: replaces app-level S3 object storage.)
- [x] **T060 — Automatic URL import (local-first)** · done · _deps: T013, T015, T016, T047_
  Done when: URL import — run in the **Electron main process** — fetches the page, runs Readability, stores the original snapshot + cleaned HTML in the asset vault, converts to ProseMirror JSON, and creates an inbox source. (Re-scoped local-first off T058/T059 — see [`tasks/M12-web-import.md`](./tasks/M12-web-import.md).)
- [ ] **T061 — Canonical URL & duplicate detection** · _deps: T060_
  Done when: URLs are normalized (tracking params removed), already-imported canonical URLs are detected against the local `sources` table, content hashes computed; re-importing prompts reuse-or-new-version. (Local-first — see [`tasks/M12-web-import.md`](./tasks/M12-web-import.md).)

## M13 — Browser extension (local-first capture) (T062–T063)
Detailed specs: [`tasks/M13-browser-extension.md`](./tasks/M13-browser-extension.md)

- [ ] **T062 — Browser extension MVP** · _deps: T060_
  Done when: a Manifest V3 extension can "save page" / "save selection" / "save to inbox" via its service worker; the capture is POSTed to a token-protected `127.0.0.1` **loopback** server in the Electron main, which runs the M12 import pipeline. The extension never writes the SQLite DB directly and makes no cloud call. (Re-scoped local-first off the original T053 cloud-auth dep — see [`tasks/M13-browser-extension.md`](./tasks/M13-browser-extension.md).)
- [ ] **T063 — Side-panel capture** · _deps: T062_
  Done when: the extension's Side Panel shows inbox/import UI beside the page and can save a selection with priority + reason, routed through the **same loopback capture path** (not direct DB writes).

## M14 — PDF / EPUB / document import (T064–T070)

> Local-first: imported documents and their assets live in the **filesystem asset vault**
> (T059 scaling), never app-level S3; OCR/parsing run on the **local background runner** (T058),
> never a server worker.

- [ ] **T064 — PDF import** · _deps: T059, T018_
  Done when: PDF.js renders PDFs, extracts selectable text, tracks page read-points, and stores page-level source locations; PDF text extracts link to page numbers.
- [ ] **T065 — PDF region extraction** · _deps: T064_
  Done when: drawing a rectangle around a figure/table creates an image extract with page number + coordinates as its own scheduled topic.
- [ ] **T066 — OCR fallback** · _deps: T064, T058_
  Done when: OCR jobs run on the **local background runner** (on-device, e.g. Tesseract/WASM) and produce searchable/extractable text for scanned pages/images with confidence metadata attached to page/region (not blindly inserted into the body).
- [ ] **T067 — EPUB import** · _deps: T059, T018_
  Done when: EPUBs parse into book/chapter/section sources preserving chapters/headings/footnotes/locations; a chapter can be read incrementally.
- [ ] **T068 — Markdown & HTML import/export** · _deps: T015_
  Done when: Markdown and HTML are first-class imports preserving code/headings/links/images; exported Markdown round-trips back with acceptable fidelity.
- [ ] **T069 — Highlight import (Readwise/Kindle-style)** · _deps: T012_
  Done when: a generic highlight import format + adapters turn external highlights into inbox extracts (not active cards).
- [ ] **T070 — Anki import/export** · _deps: T032_
  Done when: cards export to Anki-compatible packages/CSV with source refs, and Anki cards import as card elements preserving review history when available.

## M15 — Rich media cards (T071–T075)

> Local-first: image/video/audio bytes live in the **asset vault** (T059), transcoding/clipping
> runs on the **local background runner** (T058); no app-level S3, no server processing.

- [ ] **T071 — Image occlusion** · _deps: T065_
  Done when: image-occlusion cards generate from image extracts with masks/regions stored separately from the base image; one diagram yields multiple sibling cards.
- [ ] **T072 — Formula & code cards** · _deps: T015, T032_
  Done when: MathJax/LaTeX, syntax-highlighted code, and code-specific prompts render correctly in source/extract/review.
- [ ] **T073 — Video import** · _deps: T059_
  Done when: YouTube/local video metadata + transcript (if available) + timestamped read-points create video sources resumable from a saved timestamp.
- [ ] **T074 — Video/audio clip extraction** · _deps: T073_
  Done when: selecting start/end timestamps creates a scheduled `media_fragment` storing transcript segment + clip metadata + source timestamp.
- [ ] **T075 — Audio review cards** · _deps: T074, T036_
  Done when: audio prompt/answer/looped-fragment cards can be reviewed as active recall.

## M16 — Advanced scheduling & overload (T076–T082)

- [ ] **T076 — Advanced auto-sort** · _deps: T029, T036_
  Done when: queue sorting uses a scoring function over priority, due date, retrievability, type, sibling spacing, concept diversity, and session mode.
- [ ] **T077 — Auto-postpone** · _deps: T076_
  Done when: when due load exceeds the daily budget, low-priority topics then low-priority mature cards are postponed first while high-priority fragile cards are protected.
- [ ] **T078 — Catch-up & vacation modes** · _deps: T077_
  Done when: catch-up recovers from backlog and vacation pre-adjusts future load, both showing the cost of postponement.
- [ ] **T079 — Desired retention by priority/concept** · _deps: T036, T041_
  Done when: retention targets can differ by concept or priority band.
- [ ] **T080 — FSRS parameter optimization** · _deps: T036_
  Done when: accumulated review history can optimize FSRS parameters per preset/concept, with suggested updates and a workload-impact preview.
- [ ] **T081 — Workload simulation** · _deps: T080, T079_
  Done when: the user can preview how load changes from altering desired retention, adding cards, or postponing low-priority material before committing.
- [ ] **T082 — Mature-card retirement** · _deps: T036_
  Done when: cards can be retired/archived/moved to very-low retention so low-value mature cards leave active review gracefully.

## M17 — Analytics, quality & maintenance (T083–T086)

- [ ] **T083 — Source-yield analytics** · _deps: T045_
  Done when: each source shows read %, extracts/cards/mature-cards created, leeches, and time spent; low-yield sources are identifiable.
- [ ] **T084 — Extract-stagnation analytics** · _deps: T045, T024_
  Done when: extracts that keep returning without progressing are detected and surfaced with rewrite/convert/postpone/delete suggestions.
- [ ] **T085 — Leech remediation workflow** · _deps: T040_
  Done when: a repair screen offers split/add-context/open-source/back-to-extract/lower-priority/suspend/delete for repeated failures.
- [ ] **T086 — Minimum-information-principle checks** · _deps: T035_
  Done when: quality warnings extend to multiple facts, long lists, vague pronouns, unsupported claims, similar answers, no/outdated source, and oversized clozes.

## M18 — Semantic search & AI (T087–T095)

> Local-first: embeddings and the vector index live **on-device** (e.g. `sqlite-vec` on the same
> better-sqlite3 DB); AI runs from the Electron main with a **local model or the user's own API
> key**. Your infrastructure is never in the loop by default. An **optional, off-by-default**
> managed AI proxy may route calls through the first-party server for convenience — enabling it
> must visibly disclose that content is sent to the server. AI output is always **drafts** until
> the user approves it.

- [ ] **T087 — Semantic search (local)** · _deps: T058, T042_
  Done when: embeddings for sources/extracts/cards are generated **on-device** (a local model via the background runner, or an embedding API called with the user's own key) and stored in a **local vector index** (e.g. `sqlite-vec` on the same better-sqlite3 DB); search finds conceptually related material without keyword match. (Re-scope: local vector store, **not** Postgres/pgvector.)
- [ ] **T088 — Related-item suggestions** · _deps: T087_
  Done when: each element shows similar extracts, possible duplicates, prerequisite concepts, and sibling sources.
- [ ] **T089 — Contradiction detection** · _deps: T087_
  Done when: semantic similarity + claim metadata flag possibly conflicting cards/extracts ("newer source conflicts with older card").
- [ ] **T090 — Staleness & expiry** · _deps: T032_
  Done when: `fact_stability`, `valid_from`, `valid_until`, `jurisdiction`, `software_version`, `review_by` let facts expire and trigger verification.
- [ ] **T091 — Source-reliability metadata** · _deps: T043_
  Done when: source type, author, date, primary/secondary/tertiary, confidence, and notes can show reliability/uncertainty on important cards.
- [ ] **T092 — Verification tasks** · _deps: T090, T091_
  Done when: scheduled `task` elements ("verify this claim", "find better source", "update outdated card", "check current version") keep time-sensitive knowledge from rotting.
- [ ] **T093 — AI-assisted distillation (local-first)** · _deps: T058, T024_
  Done when: AI actions (explain/simplify/suggest Q&A/suggest cloze/detect ambiguity/propose prerequisites/summarize) help formulation but never schedule unapproved cards (drafts only). AI calls run **from the Electron main with the user's own API key (or a local model via the background runner)** — your infrastructure is never in the loop by default; an **optional, off-by-default managed proxy** may route calls through the first-party server, disclosing that content is sent. (Re-scope: no server worker mediates AI by default.)
- [ ] **T094 — AI source grounding** · _deps: T093_
  Done when: every AI suggestion links back to selected source text and AI output is stored separately from source quotes.
- [ ] **T095 — Incremental writing / synthesis notes** · _deps: T024, T028_
  Done when: scheduled `synthesis_note` elements collect linked extracts/cards and return for refinement.

## M19 — Review modes, desktop & encryption (T096–T098)

- [ ] **T096 — Branch/subset/semantic review modes** · _deps: T087, T037_
  Done when: review by concept, source, search query, branch, stale items, leeches, or random audit works outside normal scheduling.
- [ ] **T097 — Tauri shell (deprioritized — possible future alternative)** · _deps: T050_
  Deprioritized: the canonical desktop shell is **Electron** (`apps/desktop`, shipped in T050). Do **not** build both Electron and Tauri. This task is parked as a possible future alternative shell only; if ever revisited, a Tauri shell would reuse the same renderer, typed `window.appApi` surface, SQLite DB, and asset vault — native menus, global shortcuts, clipboard helpers, filesystem backups, and local media storage all already belong to the Electron shell.
- [ ] **T098 — Backup encryption hardening & audit** · _deps: T055_
  Done when: the end-to-end backup encryption (introduced in T055/T057) is hardened and audited — per-user keys, device recovery, key rotation, and a threat-model review — so a server compromise reveals only ciphertext. (Re-scope: encryption protects *backups*; there is no live sync to encrypt.)

## M20 — Scale & hardening (T099–T100)

- [ ] **T099 — Large-collection maintenance tools** · _deps: T044, T083_
  Done when: dedup, orphan-media cleanup, broken-source reports, cards-without-sources, bulk low-priority postpone/archive, and DB integrity checks keep a 100k-element collection maintainable.
- [ ] **T100 — Gold-standard QA & performance hardening** · _deps: T099, T096, T097, T098_
  Done when: load-tested at 100k cards / 100k extracts / thousands of sources / large PDFs / long histories, with indexes, rendering, search, queue calc, and backup/restore optimized so the app stays fast, safe, backed up, and searchable after years of use.

---

## Progress log

Record notable completions / decisions here as tasks land (newest first).

- 2026-06-01 - T060 Automatic URL import (local-first) - done. Pasting a URL now imports a web page entirely on-device: the **Electron main process** fetches the page, runs Readability to extract the article, sanitizes the cleaned HTML, stores both the original snapshot and cleaned HTML in the filesystem asset vault, converts the article to ProseMirror JSON, and creates an inbox `source` with title/byline/site/canonical-URL metadata and full lineage — no renderer DB/filesystem access and nothing sent to a server. A new `@interleave/importers` package holds the pure pipeline (`readability.ts`, `sanitize.ts`, `html-to-prosemirror.ts` + their tests and `__fixtures__/`); the orchestration/IPC host lives in `apps/desktop/src/main/url-import-service.ts` and `url-import-host.ts`, exposed through the typed `window.appApi` surface (new `channels.ts` entry + `contract.ts`/`contract.test.ts` schema + `ipc.ts` + `db-service.ts` + `preload/index.ts` + `apps/web/src/lib/appApi.ts`). The inbox UI gets an `ImportUrlModal.tsx` wired into `InboxScreen.tsx`; the import persists snapshot/cleaned-HTML assets via `AssetRepository`, creates the source via `SourceRepository`, and appends `operation_log` (`create_source`/`update_document`) entries so it survives restart. ProseMirror helpers extended in `packages/core` (`prosemirror.ts`/`prosemirror.test.ts`). Covered by Vitest (`packages/importers` `readability.test.ts`, `sanitize.test.ts`, `html-to-prosemirror.test.ts`; `apps/desktop/src/main/url-import-service.test.ts`, `url-import-host.test.ts`; `packages/local-db/src/source-repository.test.ts`; `contract.test.ts`) and the Playwright spec (`tests/electron/url-import.spec.ts`).
- 2026-06-01 - Part II re-scoped local-first (server = encrypted backup only). The gold-standard half of the roadmap (T051–T100) is reframed so EVERYTHING runs on-device and the server is **only an end-to-end-encrypted backup target** — it never mirrors the domain model, replays the op-log, or processes content. Decisions: (1) **pure backup, single canonical device** — no live multi-device sync, so the old two-way-sync (T056) and conflict-UI (T057) tasks are **dropped and repurposed** into automatic-backup/retention/verification (T056) and encryption-keys/recovery (T057); (2) a **thin first-party backup server** (auth + encrypted blob store), so M11 collapses from a sync engine + server domain mirror into "Backup & restore" (T051 thin API, T052 minimal blob store, T053 light auth, T054 incremental-backup design, T055 encrypted backup+restore); (3) **local/BYO-key AI + an optional, off-by-default managed proxy** — semantic search moves to a local vector store (`sqlite-vec`, not pgvector — T087) and AI runs from the Electron main with the user's own key (T093). M12's server worker (T058) becomes a **local background runner** and app-level S3 (T059) becomes **asset-vault scaling**; M14/M15 storage is the local vault and OCR/embeddings run on the local runner; T098 becomes backup-encryption hardening; T100 drops multi-device from the load matrix. The MVP (T001–T050) is unchanged and nothing already built is wasted — the `operation_log` now powers undo/audit/**incremental backup** instead of server convergence. Reconciled `roadmap.md`, `architecture.md`, `CLAUDE.md`, and `domain-model.md`; the local-first `tasks/M12-web-import.md` and `tasks/M13-browser-extension.md` specs now match the roadmap.
- 2026-05-30 - T050 Ship MVP (Electron desktop) - done. The MVP now packages and runs as a local-first Electron desktop app on macOS: `apps/desktop` builds a distributable via electron-builder (`electron-builder.yml`, `scripts/dist.mjs`, `RELEASE.md`), SQLite persists in the app data directory and assets in the filesystem vault, backup/onboarding/backup-prompt flows are polished (`apps/web/src/components/Onboarding.tsx`, `BackupPrompt.tsx`), and the core loop survives restart with no raw DB/filesystem APIs exposed to the renderer. Covered by Vitest (`Onboarding.test.tsx`, `BackupPrompt.test.tsx`, `paths.test.ts`, `contract.test.ts`) and the Playwright spec (`tests/electron/onboarding.spec.ts`).
- 2026-05-30 - T049 MVP end-to-end tests - done. A single serial Playwright/Electron spec (`tests/electron/mvp-flow.spec.ts`) drives the whole MVP loop against the real Electron app: import a pasted article → activate → read + set read-point → extract a paragraph (with lineage) → author Q&A + cloze cards → review/reschedule (durable review log, advanced due date) → search → open original source → backup (valid hashed zip), then relaunches the app and verifies every artifact survives the restart. Exercises only the typed `window.appApi` surface, so the renderer-never-touches-DB/filesystem invariant is asserted end-to-end.
- 2026-05-30 - T048 Keyboard shortcuts & command palette - done. The main workflow is now mouse-free: scoped shortcuts (next-item, extract, cloze, postpone, done, delete, raise/lower priority, search, open-parent, open-source) plus a command palette invoke commands through the same typed `window.appApi` path as the UI buttons, with a native Electron menu wired up. Shortcuts/scope/global-actions live in `apps/web/src/shell/` (`shortcuts.ts`, `activeScope.ts`, `useGlobalActions.ts`, `useShellShortcuts.ts`, `CommandPalette.tsx`) and the native menu in `apps/desktop/src/main/menu.ts`. Covered by Vitest (`shortcuts.test.ts`, `CommandPalette.test.tsx`, `useShellShortcuts.test.tsx`, `nav.test.ts`, `contract.test.ts`) and the Playwright spec (`tests/electron/keyboard.spec.ts`).
- 2026-05-30 - T047 Backup / export - done. Backup creates a restore-ready zip (SQLite db + asset vault + manifest) behind the Electron/IPC boundary, exposed through the typed `window.appApi` surface so the renderer never touches the filesystem directly. Covered by Vitest (`backup-manifest.test.ts`, `backup-service.test.ts`, `contract.test.ts`, `db-service.test.ts`) and the Playwright spec (`tests/electron/backup.spec.ts`).
- 2026-05-30 - T046 Import/process balance warnings - done. A balance banner warns when imports outpace processing: the import/process rates are computed behind the Electron/IPC boundary (`packages/core/balance.ts`, `packages/local-db/balance-query.ts`) and read through the typed `window.appApi` surface, with a `BalanceBanner` shown on inbox/analytics so the renderer never touches the DB directly. Covered by Vitest (`balance.test.ts`, `balance-query.test.ts`, `BalanceBanner.test.tsx`, `contract.test.ts`, `db-service.test.ts`) and the Playwright spec (`tests/electron/balance.spec.ts`).
- 2026-05-30 - T045 Basic analytics - done. A new analytics view surfaces daily reviews, due cards/topics, new cards/extracts, deletions, leeches, and 30-day retention, computed behind the Electron/IPC boundary and read through the typed `window.appApi` surface so the renderer never touches the DB directly.
- 2026-05-30 - T044 Deletion, trash & undo - done. Soft delete now has a recoverable path: a `/trash` view lists soft-deleted elements and supports restore, backed by a `trash-query` in `packages/local-db`; command-level undo covers delete/mark-done/suspend/bulk-postpone via a transactional `UndoService` (`packages/local-db/src/undo-service.ts`). Everything is exposed through the typed `window.appApi` surface (channels + contract + ipc + db-service + preload + appApi) so the renderer never touches the DB directly; mutations append `operation_log` entries (`soft_delete_element`/`restore_element`/`update_element`/`reschedule_element`) and survive app restart. Covered by Vitest (`trash-query.test.ts`, `undo-service.test.ts`, `contract.test.ts`, `db-service.test.ts`, `nav.test.ts`, `settings.test.ts`) and the Playwright spec (`tests/electron/trash-undo.spec.ts`).
- 2026-05-30 - T043 Source/reference display - done. Every extract and card now surfaces its source reference (title/URL/author/date/location) via a shared refblock so nothing feels orphaned; review hides the reference until the answer is revealed.
- 2026-05-30 - T042 Search - done. Local full-text search over sources/extracts/cards is now backed by SQLite FTS5 (`source_fts`, `extract_fts`, `card_fts`), kept in sync by repository writes and exposed through the typed `window.appApi` search surface so the renderer never touches the DB directly.
- 2026-05-30 - T041 Concepts & tags - done. Hierarchical concepts and flat tags can now be created and assigned to elements, and elements can be filtered by concept and tags.
- 2026-05-30 - T040 Basic leech detection - done. Cards that repeatedly fail are now detected as leeches (warn at 4 lapses) and surfaced in a dedicated cleanup view with rewrite/suspend/delete actions. The leech-detection heuristic lives in `packages/scheduler` (`leech.ts`) with unit tests (`leech.test.ts`); leech state persists on `review_states`/`cards` (Drizzle migration `0001_clever_rictor.sql`) via `ReviewRepository` in `packages/local-db`, and the cleanup view (`apps/web/src/maintenance/`) plus the review repair bar drive everything through the typed `window.appApi` surface (channels + contract + ipc + db-service + preload + appApi) so the renderer never touches the DB directly. Covered by Vitest (`packages/scheduler/src/leech.test.ts`, `packages/local-db/src/leech.test.ts`, `db-service.test.ts`, `contract.test.ts`, `ReviewRepairBar.test.tsx`, `nav.test.ts`) and the Playwright spec (`tests/electron/leech.spec.ts`).
- 2026-05-30 - T039 Sibling burying - done. A review session no longer surfaces two cards that share the same parent element back-to-back: a transactional `ReviewSessionService` (`packages/local-db/src/review-session-service.ts`) tracks the recently-shown card lineage and skips/defers siblings of the just-reviewed card when picking the next due card (unless the user explicitly opts into showing siblings). The behavior is exposed through the typed `window.appApi` queue/review surface so the renderer never touches the DB directly, with a Settings toggle (`packages/core/src/settings.ts`, `apps/web/src/pages/Settings.tsx`). Covered by Vitest (`review-session-service.test.ts`, `db-service.test.ts`, `contract.test.ts`, `settings.test.ts`, `ReviewScreen.test.tsx`, `ReviewRepairBar.test.tsx`) and the Playwright spec (`tests/electron/sibling-burying.spec.ts`).
- 2026-05-30 - T038 Review editing - done. The review session's repair row is now functional: while a card is surfaced the user can edit its body (Q&A prompt/answer or cloze text), open the source, suspend, soft-delete, or flag-as-bad — without leaving review. The mutating repairs live in a transactional `CardEditService` (`packages/local-db/src/card-edit-service.ts`) that composes `ElementRepository`/`ReviewRepository` and writes the correct EXISTING `operation_log` op (no new op types): `update_element` for body edits and the schema-churn-free advisory flag marker (latest `{flagged, reason?}` marker wins), `update_element` for suspend, `soft_delete_element` for delete. Edits never touch lineage, `review_states`, or the append-only `review_logs`, preserving the two-scheduler split. The repair UI (`apps/web/src/review/ReviewRepairBar.tsx`) drives everything through the typed `window.appApi` `cards.*` surface (channels + contract + ipc + db-service + preload + appApi) so the renderer never touches the DB directly. Covered by Vitest (`card-edit-service.test.ts`, `ReviewRepairBar.test.tsx`, `ReviewScreen.test.tsx`, `db-service.test.ts`, `contract.test.ts`) and the Playwright spec (`tests/electron/review-edit.spec.ts`). Committer note: fixed a latent op-log ordering flake surfaced by this feature — `OperationLogRepository.listForElement`/`listAll` now break `createdAt` ties by the implicit insertion-order `rowid`, so the "latest flag marker wins" read is deterministic for same-millisecond flag/un-flag ops.
- 2026-05-30 - T037 Review UI - done. The `/review` route now runs a full FSRS review session: it shows the card prompt, reveals the answer, and lets the user grade Again/Hard/Good/Easy with next-interval previews; each grade logs response time, advances the scheduler state via the `SchedulerService`, moves to the next due card, and writes a durable `review_logs` row. The session UI lives in `apps/web/src/review/` (wired into `router.tsx`) and drives grading through the typed `window.appApi` review surface (channels + contract + ipc + db-service + preload + appApi) so the renderer never touches the DB directly; mutations append `operation_log` (`add_review_log`/`reschedule_element`) entries and survive app restart. Covered by Vitest (`db-service.test.ts`, `contract.test.ts`) and the Playwright spec (`tests/electron/review.spec.ts`).
- 2026-05-30 - T036 Integrate ts-fsrs - done. A `SchedulerService` now wraps `ts-fsrs` for active-recall card scheduling: grading a card (Again/Hard/Good/Easy) advances and persists FSRS state (due/stability/difficulty/elapsed/scheduled/reps/lapses) on `review_states`, and new cards reschedule by rating. Domain logic stays behind the Electron/IPC boundary in `packages/local-db`; mutations append `operation_log` (`add_review_log`/`reschedule_element`) entries and survive app restart.
- 2026-05-30 - T035 Card-quality warnings - done. The card builder now surfaces minimum-information-principle warnings before activation: prompt-too-long, answer-too-long, missing source, multiple clozes, ambiguous pronouns, and empty answer. The heuristics live in `packages/core` (`card-quality.ts`) with unit tests (`card-quality.test.ts`), exported from the core index, and are evaluated in the renderer's `apps/web/src/reader/CardBuilder.tsx` (with styles in `extract-view.css`) so domain logic stays out of React internals. Covered by Vitest (`card-quality.test.ts`, `CardBuilder.test.tsx`) and the Playwright spec (`tests/electron/cards.spec.ts`).
- 2026-05-30 - T034 Cloze card creation - done. Selecting text inside an extract now creates a cloze `card` linked to that extract: the selection is wrapped as `{{c1::answer}}` cloze text and stored alongside structured cloze metadata (cloze number, answer, span offsets) so the prompt/answer can be reconstructed deterministically. Cloze parsing/serialization lives in `packages/core` (`cloze.ts`) with unit tests, the editor `cloze` mark lives in `packages/editor` (`marks/cloze.ts`) with tests, and creation flows through the `CardService` in `packages/local-db` behind the typed `window.appApi` card surface so the renderer never touches the DB directly. The cloze builder UI is wired into `apps/web/src/reader/CardBuilder.tsx`; creation appends an `operation_log` (`create_card`) entry, preserves source lineage back to the extract, and the card appears in the review queue. Covered by Vitest (`cloze.test.ts`, `marks/cloze.test.ts`, `CardBuilder.test.tsx`, `card-service.test.ts`, `db-service.test.ts`) and the Playwright spec (`tests/electron/cards.spec.ts`).
- 2026-05-30 - T033 Q&A card creation - done. From an extract, a "Create Q&A card" builder lets the user enter a prompt and answer with the source context shown and a live preview, then creates a Q&A `card` element linked to the extract that appears in the review queue. The builder UI lives in `apps/web/src/reader/CardBuilder.tsx` (wired into `ExtractView.tsx`) and drives card creation through the existing typed `window.appApi` card surface, so the renderer never touches the DB directly; creation appends an `operation_log` (`create_card`) entry and preserves source lineage back to the extract. Covered by Vitest (`CardBuilder.test.tsx`, `ExtractView.test.tsx`) and a Playwright spec (`tests/electron/cards.spec.ts`).
- 2026-05-30 - T032 Card model & templates - done. `card` elements are now first-class with `card_type` (Q&A / cloze), `prompt`, `answer`, `cloze_text`, `source_extract_id`, and `sibling_group_id`, alongside parents, priority, and review state. The transactional `CardService` lives in `packages/local-db` (`card-service.ts`) with unit tests; card creation flows through the typed `window.appApi` surface (channels + contract + ipc + db-service + preload + appApi) so the renderer never touches the DB directly. Mutations append `operation_log` (`create_card`) entries and preserve source lineage back to the extract.
- 2026-05-30 - T031 Process-queue learning loop - done. A single "process queue" mode now shows one due element at a time and advances to the next after each action, so the user can process a run of mixed elements (sources/extracts/cards) without returning to the list. The mode lives in `apps/web/src/pages/queue/ProcessQueue.tsx` with its keyboard-shortcut hook `useProcessShortcuts.ts` and styles `process-queue.css`, wired into the queue screen (`QueueScreen.tsx`) and router (`router.tsx`); it reuses the existing typed `window.appApi` queue surface (`queue.next`/queue actions) so the renderer never touches the DB directly. Covered by Vitest (`ProcessQueue.test.tsx`) and a Playwright spec (`tests/electron/process-queue.spec.ts`) verifying ten mixed elements process end-to-end.
- 2026-05-30 - T030 Queue actions - done. Each due item in `/queue` now supports open/postpone/raise/lower/done/dismiss/delete without leaving the list. The transactional `QueueActionService` lives in `packages/local-db` (`queue-action-service.ts`) with unit tests and composes the existing scheduler/element/queue repositories; actions append `operation_log` entries (`reschedule_element`, `update_element`, `soft_delete_element`) and survive app restart. The action surface is exposed through the typed `window.appApi` (channels + contract + ipc + db-service + preload + appApi); the renderer (`apps/web/src/pages/queue/` + new `QueueSnackbar.tsx` for undo/feedback) never touches the DB directly. Covered by Vitest (`queue-action-service.test.ts`, `QueueScreen.test.tsx`, `contract.test.ts`) and the Playwright spec (`tests/electron/queue.spec.ts`).
- 2026-05-30 - T029 Due queue - done. A new `/queue` route lists due sources, extracts, and cards sorted by priority then due date, with filters for element type, concept, and status. The due-queue query lives in `packages/local-db` (`queue-query.ts`) with unit tests and is exposed through the typed `window.appApi` surface (channels + contract + ipc + db-service + preload + appApi); the renderer (`apps/web/src/pages/queue/` + `apps/web/src/components/queue/`) never touches the DB directly. Covered by Vitest (`queue-query.test.ts`, `contract.test.ts`) and a Playwright spec (`tests/electron/queue.spec.ts`).
- 2026-05-30 - T028 Topic/extract scheduler - done. Sources, topics, and extracts now get an attention-based next-review schedule that is distinct from FSRS card review (it answers "should the user process this again, and when?" rather than "can the user recall this?"). The scheduler weighs priority, distillation stage, last-processed date, user action, whether the element produced useful children, stagnation, and repeated postponement; logic lives in `packages/core` with unit tests and is composed by the `SchedulerService` in `packages/local-db` behind the typed `window.appApi` surface. Mutations append `operation_log` (`reschedule_element`) entries and survive app restart.
- 2026-05-30 - T027 Priorities (A/B/C/D) - done. Priority is stored numerically on every element and surfaced as the A/B/C/D labels (A = high value, B = useful, C = maybe, D = low/background); every source, extract, and card can be raised or lowered. Mapping/clamp logic lives in `packages/core` (`priority.ts`) with unit tests, persistence runs through `ElementRepository` in `packages/local-db` behind the typed `window.appApi` surface (channels + contract + ipc + db-service + preload + appApi), and the inspector exposes raise/lower controls. The renderer never touches the DB directly; mutations append `operation_log` entries and survive app restart (Playwright `tests/electron/priority.spec.ts`).
- 2026-05-30 - T026 Mark processed on source text - done. Processed spans on a source can now be marked, collapsed/dimmed, and restored so the user can hide processed text without deleting the archived source. The `processed` document mark lives in `packages/editor` (`marks/processed.ts`) with unit tests; reader rendering/collapse logic is in `reader-decorations.ts`, the renderer hook is `apps/web/src/pages/source/useProcessedSpans.ts` with controls in `ProcessedSpanButtons.tsx`, and persistence flows through the typed `window.appApi` document surface (renderer never touches the DB). Survives app restart (Playwright `tests/electron/processed-spans.spec.ts`).
- 2026-05-29 - T025 Extract splitting (sub-extracts) - done. An extract can now be split into child sub-extracts that preserve full source lineage (source element ID, source block IDs, offsets, inherited source metadata/priority) back to the original source. Split logic lives in `packages/local-db` (`extraction-service`) with unit tests; the renderer drives it through the typed `window.appApi` surface (`apps/web/src/reader/ExtractView.tsx`) and never touches the DB directly. Mutations append `operation_log` entries and the flow survives app restart (Playwright `tests/electron/sub-extract.spec.ts`).
- 2026-05-29 - T024 Extract review mode - done. Extracts now open as readable mini-topics with trim/rewrite/split/convert/postpone/done/delete actions, and an extract can advance its distillation stage raw_extract → clean_extract → atomic_statement. The stage-transition and review logic live in `packages/local-db` (`extract-service`) with unit tests; the renderer drives everything through the typed `window.appApi` surface (channels + contract + ipc + db-service + appApi) and never touches the DB directly. UI is `apps/web/src/reader/ExtractView.tsx`. Mutations append `operation_log` entries, lineage is preserved, and the flow survives app restart (Playwright `tests/electron/extract-review.spec.ts`).
- 2026-05-29 - T023 Element hierarchy view - done. Source and extract pages now render a lineage tree in the inspector: source pages show their children (extracts/sub-extracts/cards) and extract pages show their parent chain plus children, with click-through navigation working in both directions. The tree is backed by a `packages/local-db` `lineage-query` exposed through the typed `window.appApi` surface (channels + contract + ipc + db-service + appApi); the renderer never touches the DB directly. Covered by Vitest (`lineage-query`, `LineageTree`) and a Playwright spec (`tests/electron/lineage.spec.ts`); lineage is preserved.
- 2026-05-29 - T022 Source locations - done. Each extract now persists its source element ID, source block IDs, start/end offsets, and a human-readable label, and the user can jump from an extract back to the exact paragraph in the originating source. Source-location logic and the jump-to-source flow run through the typed `window.appApi` surface; lineage is preserved and survives app restart.
- 2026-05-29 - T021 Extraction (keystone) - done. Extracting selected source text now creates a child `extract` element with its own document body, a source reference back to the originating source, a parent link, a persisted source location (source element ID, block IDs, start/end offsets, human-readable label), inherited priority, and a scheduled review state; the parent text is visually marked as an extracted span in the reader. Extraction is transactional, appends `operation_log` entries, preserves source lineage, and survives app restart; the renderer drives it only through the typed `window.appApi` surface (no direct DB access).
- 2026-05-29 - T020 Highlights - done. Highlights now persist as document marks (annotations), distinct from extracts: applying "Highlight" from the selection toolbar stores a highlight mark on the underlying document and renders it in the reader, and highlights can be removed without affecting extracts. Mark logic lives in `packages/editor` (`marks/`) with unit tests; the renderer hook is `apps/web/src/pages/source/useHighlights.ts`, persistence flows through the typed `window.appApi` document surface (channels + contract + ipc + db-service + document-repository), and the renderer never touches the DB directly. Survives app restart (Playwright `tests/electron/highlights.spec.ts`).
- 2026-05-29 - T019 Text-selection toolbar - done. Selecting text in the source reader now surfaces an inline toolbar (Extract, Cloze, Highlight, Copy, Cancel) anchored to the selection without breaking editor selection. Selection-to-source-location logic lives in `packages/editor` (`selection-location.ts`) with unit tests; the toolbar UI/positioning lives in `apps/web/src/reader/`, wired into `SourceReader.tsx`. Covered by Playwright `tests/electron/selection-toolbar.spec.ts`.
- 2026-05-29 - T018 Source reading mode - done. A clean source reader (`apps/web` `SourceReader.tsx` + `reader.css`) shows title, metadata, body, the read-point marker, and extracted-span markers, with keyboard actions for processing a long article. Reader decoration logic lives in `packages/editor` (`reader-decorations.ts`) with unit tests; persistence/queries flow through the typed `window.appApi` surface (contract + db-service), renderer never touches the DB directly. Survives app restart (Playwright `tests/electron/source-reader.spec.ts`).
- 2026-05-29 - T017 Read-points - done. Sources/topics now carry a `read_point` (block ID + offset) that can be set, jumped to, and auto-updated when an extract is created; reopening a source resumes near the last read-point. Read-point logic lives in `packages/editor` (`read-point.ts`) with the renderer hook in `apps/web` (`useReadPoint.ts`); persistence flows through the typed `window.appApi` surface (channels + contract + ipc + db-service), renderer never touches the DB directly. Survives app restart (Playwright `tests/electron/read-points.spec.ts`).
- 2026-05-29 - T016 Stable block IDs - done. Every block node now carries a stable ID preserved across imports and saves (the basis for extraction, read-points, and sync). Block-ID generation/normalization lives in `packages/editor` (`block-id.ts`, `blocks.ts`) and the constrained Tiptap schema; IDs survive the ProseMirror JSON round-trip through `packages/core` (`prosemirror.ts`) and the typed `window.appApi` document surface (db-service + contract), and persist across app restart (Playwright `tests/electron/block-ids.spec.ts`). Renderer never touches the DB directly.
- 2026-05-29 - T015 Tiptap document editor - done. Source bodies render/edit through a constrained Tiptap/ProseMirror schema (headings, paragraphs, bold, italic, links, blockquotes, lists, code, hr) in `packages/editor` (`schema.ts`, `serialize.ts`, `SourceEditor.tsx`); edits serialize to ProseMirror JSON and save/reload via the typed `window.appApi` document surface. Renderer never touches the DB directly.
- 2026-05-29 - T014 Source provenance fields - done. Manual imports now capture canonical URL, original URL, accessed date, and snapshot provenance fields (no remote fetching). URL normalization/canonicalization lives in `packages/core` (`url.ts`); the schema, typed `window.appApi` import contract, and the "New source" modal persist these fields, and the inspector surfaces them. Renderer never touches the DB directly.
- 2026-05-29 - T013 Manual text import - done. The "New source" modal now accepts a body that is stored both as plain text and as ProseMirror JSON; a pasted article appears as a source in the inbox. Plain-text-to-ProseMirror conversion lives in `packages/core`; the typed `window.appApi` source-import surface persists both representations, and renderer never touches the DB directly.
- 2026-05-29 - T012 Inbox - done. Sources can be created in the inbox, listed, viewed, kept, prioritized, accepted into active learning, or deleted — all via the typed `window.appApi` surface (no renderer DB access). Mutations run in single transactions and append `operation_log` entries; deletes are soft.
- 2026-05-29 - T011 Local settings in SQLite - done. User/domain settings (daily review budget, default desired retention, default topic interval, default source priority, keyboard layout, theme) now persist in the SQLite `settings` table and are read through the typed `window.appApi` surface; scheduler code consumes them via the typed API rather than touching the DB directly.
- 2026-05-29 - T010 Universal element inspector - done. The right inspector panel now renders any selected element's type, status, stage, priority, due date, parent, children, source, tags, and review metadata, fetched through a new typed `window.appApi` inspector query (backed by `packages/local-db` `inspector-query`) — the renderer never touches the DB directly. Shell selection state lives in a dedicated `selection` context; Vitest covers the inspector query and a Playwright spec exercises the inspector end-to-end.
- 2026-05-29 - T009 Desktop dev seed & fixtures - done. A `pnpm seed` desktop dev command resets the dev SQLite DB and builds a realistic demo collection (a source with document blocks, an extract with a source location, a sub-extract, a Q&A card, a cloze card, review state/logs, concepts/tags, asset metadata, and `operation_log` entries). Shared factories/fixtures now live in `packages/testing` and are reused by both Vitest and Playwright; `packages/local-db` gains a `test-db` helper for in-memory/seeded test databases.
- 2026-05-29 - T008 Repository classes in packages/local-db - done. `packages/local-db` now holds `ElementRepository`, `DocumentRepository`, `SourceRepository`, `ReviewRepository`, `QueueRepository`, `SearchRepository`, `AssetRepository`, `SettingsRepository`, and `OperationLogRepository` behind the Electron/IPC boundary. Meaningful mutations run in single transactions across multiple tables and append `operation_log` entries; deletes are soft (`deleted_at`); the renderer reaches repositories only via typed `window.appApi` (no React component touches SQL). Per-repo smoke tests cover referential integrity + persistence.
- 2026-05-29 - T007 Electron desktop shell + native SQLite persistence - done. `apps/desktop` provides a secure Electron window (contextIsolation, no nodeIntegration, no remote module, sandbox where practical) and a narrow typed `window.appApi` preload bridge (`app.health()`, `db.getStatus()`, `settings.get/update()`) with Zod-validated IPC payloads. The app data directory is initialized (app.sqlite + -wal/-shm, assets/, backups/), SQLite opens via better-sqlite3 with foreign_keys=ON / journal_mode=WAL / busy_timeout=5000, Drizzle migrations run safely on startup, dev loads the Vite dev server and production loads the built renderer, and data persists across app restart. The renderer has no raw Node/filesystem/SQLite access and never sees a generic db.query(sql).
- 2026-05-29 - T006 Native SQLite Drizzle schema - done. `packages/db` now holds the Drizzle SQLite-dialect schema and generated migrations for all M1 tables (elements, documents, document_blocks, document_marks, sources, source_locations, element_relations, read_points, cards, review_states, review_logs, concepts, tags, element_tags, tasks, assets, operation_log, settings); types align with @interleave/core, drizzle-kit generate/migrate plus a dev-reset can create/reset a dev DB, and the schema round-trips against an in-memory better-sqlite3 DB in tests. FTS tables arrive with search later.
- 2026-05-29 - Architecture pivot to Electron + native SQLite. The project moves from a PGlite/browser-first PWA to a local-first **Electron desktop app** on a **native SQLite** database (better-sqlite3 + Drizzle, SQLite dialect), with a filesystem **asset vault** for PDFs/snapshots/media/exports/backups and an `operation_log` from day one. The React + Vite app becomes a pure **renderer** that talks to a narrow typed `window.appApi` preload bridge; Electron (main/preload/IPC) owns all trusted local capabilities and the renderer never touches SQLite or arbitrary filesystem APIs. New monorepo additions: `apps/desktop` and `packages/local-db`; `packages/db` keeps the schema/migrations (now SQLite dialect). Native **pnpm** (`pnpm typecheck`/`pnpm test`/`pnpm lint`) is the canonical desktop toolchain; the Docker/compose/Makefile setup is kept but re-scoped to the future server phase (`api`/`worker`/`db`/`minio`). Definition of Done now requires features to survive **app restart**. Roadmap content revised in place (T001–T011, T047–T050) and pivot notes added to gold-standard sync/extension/semantic-search/desktop tasks; task numbering unchanged. Cloud sync (T051+) is designed around the SQLite op-log + Postgres (not Electric/PGlite/PowerSync now); Tauri (T097) is deprioritized to a possible future alternative shell only; a PWA/browser version is deprioritized.
- 2026-05-29 - T005 Domain language in packages/core - done. Documented TS types for the Element family (Element, ElementType, ElementStatus, DistillationStage, Priority), ReviewState/ReviewLog, Source, Document, ElementRelation, ElementLocation, plus the new desktop types Asset, AssetLocation, OperationLogEntry, and LocalVaultPath, exported from @interleave/core for app and tests.
- 2026-05-29 - T004 App shell skeleton - done. Keyboard-first shell with left sidebar, top command bar, central work area, right inspector, and bottom status bar; every main route renders through the same shell and is keyboard-navigable.
- 2026-05-29 - T003 Scaffold the React app - done. Vite + React 19 + TS + TanStack Router + Tailwind v4 in apps/web with routes /, /inbox, /queue, /source/$id, /review, /search, /settings, wired to the design tokens.
- 2026-05-29 - T002 Tooling + Docker + CI gates - done. Strict TypeScript, Biome, Vitest, Playwright smoke E2E, Dockerfiles + docker-compose + Makefile, and GitHub Actions CI wired so CI rejects type errors, lint errors, unit failures, and a smoke E2E failure.
- 2026-05-29 - T001 Create the monorepo - done. pnpm + Turborepo workspace with apps/{web,api} and packages/{core,db,scheduler,editor,ui,testing}; root typecheck/lint/test scripts pass.
</content>
