# AGENTS.md

## Project

Interleave is a desktop-first, local-first incremental reading system:

```txt
Source -> Topic -> Extract -> Clean extract -> Atomic statement -> Card -> Review -> Mature knowledge
```

It is not a read-it-later app, a generic notes app, or only a flashcard app. Every feature should
help users process too much source material without losing provenance, priority, scheduling, or
review quality.

## Read First

- `docs/README.md` explains the documentation control plane and task loop.
- `docs/roadmap.md` is the task queue. For roadmap work, pick the lowest-numbered unchecked task
  whose dependencies are complete.
- `CONCEPTS.md` defines project vocabulary.
- `docs/solutions/` contains prior implementation learnings. Search it before repeating work in a
  documented area.

## Scoped Instructions

Root instructions are intentionally short. Read the closest scoped instruction file before editing
inside these areas:

- `docs/AGENTS.md` - roadmap, plans, task specs, solution docs, and documentation hygiene.
- `design/AGENTS.md` - design tokens, icon map, and immutable prototype references.
- `apps/AGENTS.md` - app-layer boundaries shared by desktop, renderer, API, extension, and site.
- `apps/desktop/AGENTS.md` - Electron main/preload, IPC, app-data paths, vault, backup, local jobs.
- `apps/web/AGENTS.md` - React renderer, UI state, routes, and desktop bridge usage.
- `apps/api/AGENTS.md` - encrypted-backup API scope.
- `apps/extension/AGENTS.md` - MV3 capture extension and loopback contract.
- `apps/site/AGENTS.md` - public/static product site boundary.
- `packages/AGENTS.md` - package-layer ownership and cross-package boundaries.
- `packages/core/AGENTS.md` - domain types and universal `Element` vocabulary.
- `packages/db/AGENTS.md` - Drizzle SQLite schema and migrations.
- `packages/local-db/AGENTS.md` - repositories, transactions, persistence, and `operation_log`.
- `packages/scheduler/AGENTS.md` - FSRS card scheduling and attention scheduling.
- `packages/editor/AGENTS.md` - Tiptap/ProseMirror document lineage.
- `packages/importers/AGENTS.md` - import pipelines, snapshots, and asset-vault ingestion.
- `packages/capture-contract/AGENTS.md` - extension-to-desktop loopback capture contract.
- `packages/ui/AGENTS.md` - shared UI primitives.
- `packages/testing/AGENTS.md` - factories, fixtures, and test helpers.
- `tests/AGENTS.md` - Electron Playwright and cross-package E2E expectations.

Each scoped `AGENTS.md` has a sibling `CLAUDE.md` symlink for Claude-compatible tooling.

Older task specs may cite former root `CLAUDE.md` sections. Use this crosswalk:

| Former section | Destination |
| --- | --- |
| Preferred stack, runtime, MVP boundaries | `apps/AGENTS.md`, `apps/desktop/AGENTS.md`, `apps/api/AGENTS.md` |
| Architectural rules, Electron runtime & security | `apps/AGENTS.md`, `apps/desktop/AGENTS.md`, `apps/web/AGENTS.md` |
| SQLite rules, asset vault, data rules | `packages/db/AGENTS.md`, `packages/local-db/AGENTS.md`, `apps/desktop/AGENTS.md` |
| Document/editor rules | `packages/editor/AGENTS.md` |
| Scheduling rules, priority rules | `packages/scheduler/AGENTS.md`, `packages/core/AGENTS.md` |
| Review rules, card-quality rules | `apps/web/AGENTS.md`, `packages/core/AGENTS.md`, `packages/local-db/AGENTS.md` |
| UX rules, key screens, design system | `design/AGENTS.md`, `apps/web/AGENTS.md`, `packages/ui/AGENTS.md` |
| Testing expectations, Definition of Done | This file, `tests/AGENTS.md`, and scoped package/app files |
| Product north star | This file and `CONCEPTS.md` |

## Runtime

The canonical product is the native Electron desktop app with native SQLite via
`better-sqlite3` and a filesystem asset vault. Use native `pnpm`; Docker is only for the later
encrypted-backup server support and is not the desktop development or test loop.

Common commands:

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Full Electron app with Vite renderer and live `window.appApi`. |
| `pnpm dev:renderer` | Bare renderer only; no Electron bridge or live local data. |
| `pnpm lint` | Biome format/lint check. |
| `pnpm typecheck` | Workspace TypeScript check. |
| `pnpm test` | Vitest unit/domain/repository tests. |
| `pnpm e2e` | Playwright E2E against the Electron app where feasible. |
| `pnpm db:generate` | Generate Drizzle SQLite migrations. |
| `pnpm db:migrate` | Apply local SQLite migrations. |
| `pnpm seed` | Load demo fixtures into the dev SQLite DB. |

## Non-Negotiable Invariants

- The renderer never opens SQLite, reads arbitrary files, or writes arbitrary files. Trusted local
  capabilities live behind validated Electron IPC exposed through the typed preload bridge.
- Never expose a generic `db.query(sql)` or generic filesystem API to the renderer.
- SQLite is the canonical local database; the filesystem is the canonical local asset vault.
  Large PDFs, images, audio, video, snapshots, exports, and backups do not belong in SQLite.
- Source lineage is sacred. Extracts, cards, highlights, read-points, media fragments, and review
  actions must be able to trace back to source metadata and document context.
- Meaningful mutations are command-shaped, transactional, and appended to `operation_log` in the
  same transaction as the state change.
- Use FSRS only for active-recall cards. Sources, topics, extracts, tasks, and synthesis work use
  the attention scheduler.
- UI work follows `design/`: `design/tokens.css`, `design/icon-map.md`, and the immutable
  `design/kit/` visual reference.
- Prefer soft delete, undo, trash, and explicit destructive confirmations over irreversible data
  loss.

## Definition Of Done

Development is not complete until the change is confirmed with:

1. `pnpm lint`
2. `pnpm typecheck`
3. `pnpm test`
4. Relevant `pnpm e2e` / Electron Playwright coverage for user-facing, persistence, import,
   review, search, backup, or IPC behavior

For persistence features, also prove data survives app restart, multi-table mutations are
transactional, foreign keys are enforced, source lineage is preserved, and `operation_log` entries
are written.

When finishing roadmap work, update `docs/roadmap.md` with the completed task, commit reference,
and any downstream notes.
