# Interleave

A desktop-first, local-first **incremental reading** application. Import sources, read
them gradually, extract useful fragments, distill them into clean notes, and convert the
most valuable ideas into spaced-repetition flashcards — all while keeping every card
traceable back to its source.

```txt
Source → Topic → Extract → Clean extract → Atomic statement → Card → Review → Mature knowledge
```

See [`CLAUDE.md`](./CLAUDE.md) for the engineering charter and [`docs/`](./docs/) for the
concept, architecture, domain model, and the build roadmap.

## Docker-first workflow

**Everything runs in Docker.** There is no reliance on a host Node/pnpm install — the
canonical commands are `make` targets that wrap `docker compose` (see
[`Makefile`](./Makefile), [`docker-compose.yml`](./docker-compose.yml), and
[`docker/`](./docker/)). The same targets run locally and in CI.

| Command | What it does |
|---------|--------------|
| `make dev` | Start the dev stack (Vite) with hot reload at <http://localhost:5173> |
| `make typecheck` | Typecheck the whole workspace (strict TypeScript) in a container |
| `make test` | Run Vitest unit/domain tests in a container |
| `make e2e` | Run the Playwright smoke E2E (official Playwright image) |
| `make lint` | Run the Biome format + lint check (JS/TS/JSON/CSS) |
| `make format` | Auto-format the workspace with Biome |
| `make seed` | Load demo fixtures (stub until T009) |
| `make migrate` | Run Drizzle migrations (stub until the server DB arrives) |
| `make shell` | Open an interactive shell in the toolchain container |
| `make down` | Stop the stack and remove containers/networks |
| `make build` | Build the Docker images (`app` + `e2e`) |

Run `make` (or `make help`) to list the targets.

### First run

```bash
make build      # build the app toolchain image
make dev        # start Vite; open http://localhost:5173
```

The container installs dependencies on first run (with a frozen lockfile) and caches them
in named volumes, so subsequent commands start fast. The first `make e2e` pulls the
~2 GB official Playwright image — expected, and only once.

## What's wired today

This is early in the [roadmap](./docs/roadmap.md). As of **T002 (Tooling + Docker + CI
gates)** the repo is a containerized pnpm + Turborepo monorepo with:

- **Strict TypeScript** baseline ([`tsconfig.base.json`](./tsconfig.base.json)) inherited
  by every package/app.
- **Biome** for format + lint ([`biome.json`](./biome.json)).
- **Vitest** (workspace-aware) with a passing sample unit test.
- **Playwright** with a passing smoke E2E that loads the app shell.
- A **minimal Vite dev server** in [`apps/web`](./apps/web) serving a placeholder page
  (the real React 19 + TanStack Router app is scaffolded in T003).
- **CI** ([`.github/workflows/ci.yml`](./.github/workflows/ci.yml)) running
  `make typecheck`, `make lint`, `make test`, and the smoke `make e2e` — all in Docker.

## Layout

```txt
apps/
  web/         React + Vite app (the MVP lives almost entirely here)
  api/         Hono API server (gold-standard phase; stub for now)
packages/
  core/        domain types: Element model, scheduler interfaces, enums
  db/          Drizzle schemas, migrations, repositories
  scheduler/   FSRS wrapper + topic/extract scheduler
  editor/      Tiptap extensions, cloze marks, extraction commands
  ui/          shared components
  testing/     factories, fixtures, mock sources
```
