# AGENTS.md

This directory is Interleave's build control plane. Treat `docs/roadmap.md` as the task queue
and the reference docs as product constraints, not optional background.

## Before Starting Roadmap Work

1. Read `docs/README.md`.
2. Pick the lowest-numbered unchecked roadmap task whose dependencies are all `[x]`.
3. Read the matching `docs/tasks/M*.md` spec when it exists. If it does not, use the roadmap
   entry's `Goal`, `Depends on`, and `Done when` as the spec.
4. Load only the reference docs relevant to the task: `concept.md`, `architecture.md`,
   `domain-model.md`, `scheduling-and-priority.md`, and `design-system.md` for UI work.
5. Search `docs/solutions/` for prior lessons before changing related architecture, tests, UI
   behavior, IPC, persistence, scheduling, or lineage.

## Roadmap And Specs

- `docs/roadmap.md` is the source of truth for task status.
- Preserve task IDs (`T001` etc.) in commits, specs, and summaries.
- Status markers are `[ ]`, `[~]`, `[x]`, and `[!]`.
- When finishing a roadmap task, mark it `[x]`, record the commit or PR, and note downstream
  changes.
- Use `docs/tasks/_TEMPLATE.md` for new milestone specs.
- Do not reorder, rename, or broaden roadmap tasks casually; the app is built one coherent feature
  at a time.

## Solution Notes

Write or update `docs/solutions/` only for reusable lessons likely to recur. Keep YAML frontmatter
with searchable `module`, `problem_type`, and `tags` values. Keep each note specific to the
observed problem, why it mattered, the fix, and prevention.

## Verification Language

Native `pnpm` is canonical. Completed implementation work must be confirmed from the repo root
with `pnpm lint`, `pnpm typecheck`, `pnpm test`, and relevant `pnpm e2e` coverage. Do not describe
Docker or `make` as the desktop app verification path; Docker is reserved for future
encrypted-backup server infrastructure.
