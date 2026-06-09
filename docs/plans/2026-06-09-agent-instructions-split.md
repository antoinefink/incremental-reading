---
title: Split and tighten agent instructions
status: completed
date: 2026-06-09
origin: user request
execution: code
---

# Split and tighten agent instructions

## Problem Frame

The root `AGENTS.md` has become a long mixed charter: project identity, build orchestration,
runtime rules, architecture, domain invariants, design rules, data rules, and testing policy
all live in one file. That makes every agent load too much context and makes subdirectory work
less precise. The repo also has `CLAUDE.md` as a compatibility symlink to `AGENTS.md`; that
pattern should continue for any moved subdirectory instruction files.

## Requirements

- Keep root `AGENTS.md` concise and efficient.
- Move detailed guidance to subdirectory `AGENTS.md` files where directory-specific scope is
  clear.
- Add matching `CLAUDE.md` symlinks to those subdirectory instruction files.
- Remove stale or contradictory instruction drift, especially Docker-as-canonical guidance.
- Preserve the important product invariants: local-first Electron app, SQLite and filesystem
  vault, renderer trust boundary, source lineage, operation logging, scheduling split, and UI
  design source of truth.
- Make it explicit that development is not complete until `pnpm lint`, `pnpm typecheck`,
  `pnpm test`, and relevant `pnpm e2e` pass.

## Scope Boundaries

- This is documentation and instruction-structure work, plus narrow verification-support fixes
  discovered by the required lint/test/e2e gates.
- Do not change application code, package scripts, migrations, roadmap task status, or product
  behavior except for mechanical formatting needed for `pnpm lint`.
- Do not introduce generic "LLM common sense" guidance that agents already know.

## Implementation Units

### U1: Root Instruction Contract

Files:

- Modify: `AGENTS.md`
- Existing symlink: `CLAUDE.md`

Approach:

- Reduce the root file to durable repo-wide facts, routing rules, and verification gates.
- Point agents to subdirectory instruction files and reference docs instead of duplicating their
  contents.
- Keep workflow-specific task queue rules concise and avoid restating basic coding behavior.

Test Scenarios:

- Root file names all canonical verification commands, including lint and e2e.
- Root file no longer carries long per-domain bullet lists that now belong in subdirectories.
- `CLAUDE.md` still resolves to the root instruction file.

### U2: Subdirectory Instruction Files

Files:

- Add: `apps/AGENTS.md`, `apps/CLAUDE.md`
- Add: `apps/desktop/AGENTS.md`, `apps/desktop/CLAUDE.md`
- Add: `apps/web/AGENTS.md`, `apps/web/CLAUDE.md`
- Add: `apps/site/AGENTS.md`, `apps/site/CLAUDE.md`
- Add: `packages/AGENTS.md`, `packages/CLAUDE.md`
- Add: `packages/core/AGENTS.md`, `packages/core/CLAUDE.md`
- Add: `packages/db/AGENTS.md`, `packages/db/CLAUDE.md`
- Add: `packages/local-db/AGENTS.md`, `packages/local-db/CLAUDE.md`
- Add: `packages/scheduler/AGENTS.md`, `packages/scheduler/CLAUDE.md`
- Add: `packages/editor/AGENTS.md`, `packages/editor/CLAUDE.md`
- Add: `packages/importers/AGENTS.md`, `packages/importers/CLAUDE.md`
- Add: `packages/capture-contract/AGENTS.md`, `packages/capture-contract/CLAUDE.md`
- Add: `packages/ui/AGENTS.md`, `packages/ui/CLAUDE.md`
- Add: `packages/testing/AGENTS.md`, `packages/testing/CLAUDE.md`
- Add: `docs/AGENTS.md`, `docs/CLAUDE.md`
- Add: `design/AGENTS.md`, `design/CLAUDE.md`
- Add: `tests/AGENTS.md`, `tests/CLAUDE.md`

Approach:

- Put runtime and trust-boundary rules under `apps/`.
- Put Electron-specific main/preload/filesystem rules under `apps/desktop/`.
- Put renderer/UI rules under `apps/web/`.
- Put domain, persistence, scheduling, and repository rules under `packages/`.
- Put roadmap, solution-doc, and documentation orchestration rules under `docs/`.
- Put token/icon/prototype rules under `design/`.
- Add `CLAUDE.md` symlinks pointing to each sibling `AGENTS.md`.

Test Scenarios:

- Every new `CLAUDE.md` symlink resolves to its sibling `AGENTS.md`.
- No subdirectory file contradicts root verification or runtime guidance.
- Moved content remains discoverable from root.

### U3: Verification and Review

Files:

- Modified documentation files above.
- Modify: `vitest.config.ts`
- Modify: E2E/unit test files only when existing test assumptions block the required full
  verification gate.

Approach:

- Run linter, typecheck, unit tests, and e2e tests even though the change is documentation-only,
  because the task explicitly requires the instruction to enforce that development standard.
- Run multi-agent review against the diff and fix actionable issues.
- Keep verification-support edits minimal: no product behavior changes, only test/config
  compatibility for the new root instruction files and stale assertions exposed by the full gate.

Verification:

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm e2e`
- `find`/`readlink` checks for symlinks.
