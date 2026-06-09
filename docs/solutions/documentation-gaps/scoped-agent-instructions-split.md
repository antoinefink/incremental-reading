---
title: Split monolithic agent instructions into scoped AGENTS files
date: 2026-06-09
category: docs/solutions/documentation-gaps
module: Agent instructions
problem_type: documentation_gap
component: documentation
severity: medium
applies_when:
  - "Root agent instructions have grown into a long mixed charter that makes agents load too much context."
  - "Directory-specific rules need to be discoverable without duplicating the full project contract."
  - "Claude-compatible tooling still expects CLAUDE.md instruction files."
  - "Documentation-only instruction changes must still pass the repo's full verification gates."
related_components:
  - development_workflow
  - tooling
  - testing_framework
tags: [agent-instructions, documentation, scoped-guidance, claude-compatibility, vitest, pnpm]
---

# Split monolithic agent instructions into scoped AGENTS files

## Context

The root `AGENTS.md` had become a long mixed charter covering product identity, architecture, runtime, persistence, design, testing, and workflow rules. That made every agent load too much context and made directory-specific work less precise.

The split keeps durable repo-wide guidance in the root and moves operational detail to scoped files:

- root `AGENTS.md` stays concise: product north star, read-first docs, scoped instruction map, common `pnpm` commands, non-negotiable invariants, and Definition of Done;
- detailed guidance lives under the closest relevant subtree, such as `apps/desktop/AGENTS.md`, `apps/web/AGENTS.md`, `packages/db/AGENTS.md`, `packages/local-db/AGENTS.md`, `design/AGENTS.md`, `docs/AGENTS.md`, and `tests/AGENTS.md`;
- each scoped `AGENTS.md` has a sibling `CLAUDE.md` symlink for Claude-compatible tooling;
- the root includes a legacy crosswalk so old plans and specs that cite former `CLAUDE.md` sections still resolve to the new locations;
- `docs/README.md` and `docs/tasks/_TEMPLATE.md` use the native verification contract: `pnpm lint`, `pnpm typecheck`, `pnpm test`, and relevant `pnpm e2e`;
- persistence-sensitive work explicitly requires app restart verification.

## Guidance

Keep root agent instructions short and routing-oriented. Root guidance should answer:

- what this product is;
- which docs to read first;
- where scoped instructions live;
- which commands are canonical;
- which invariants must never be violated;
- what must pass before work is done.

Move subsystem detail to the nearest subtree. This prevents renderer tasks from carrying every SQLite rule, database tasks from carrying every visual-design rule, and documentation tasks from carrying Electron implementation detail.

When maintaining compatibility with tools that still look for `CLAUDE.md`, add sibling symlinks instead of duplicating content:

```txt
apps/web/AGENTS.md
apps/web/CLAUDE.md -> AGENTS.md
```

Duplication creates drift. Symlinks preserve a single source of truth.

When replacing old root sections, include a crosswalk. Older plans and task specs can still cite legacy section names, and the crosswalk lets agents resolve those references without guessing.

For Vitest workspace discovery, avoid broad project globs when non-project files can live at the same level. Adding `apps/AGENTS.md` and `packages/AGENTS.md` exposed that `projects: ["packages/*", "apps/*"]` can treat instruction files as Vitest projects. Build `test.projects` from actual directories instead.

## Why This Matters

Agent instruction files are part of the repo's execution infrastructure. If the root file is too large, every task pays the cost of irrelevant context, and agents are more likely to follow stale or overly broad guidance.

Scoped instructions improve precision. Renderer work sees renderer rules, database work sees schema and migration rules, Electron work sees IPC and trusted-capability rules. The root remains a stable navigation layer instead of a full manual.

The `CLAUDE.md` symlink pattern matters because it preserves compatibility without introducing parallel instruction sources.

Full verification matters even for documentation-heavy instruction work because the instructions define the development contract. Running `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm e2e` proved both the docs and the existing gates still agree.

## When to Apply

- A root `AGENTS.md`, `CLAUDE.md`, or contributor charter has become long enough that most tasks only need a fraction of it.
- Repo guidance differs materially by subtree.
- Old docs refer to legacy instruction sections.
- Compatibility files are needed for multiple agent harnesses.
- Adding repo instruction files changes test or tool discovery behavior.
- Docs say one verification path while the actual product uses another.
- Persistence-sensitive features need a stronger done criterion than page reload.

Also apply the Vitest directory-only discovery pattern when workspace globs can accidentally match non-project entries.

## Examples

Root instruction shape:

```md
## Read First

- `docs/README.md` explains the documentation control plane.
- `docs/roadmap.md` is the task queue.
- `CONCEPTS.md` defines project vocabulary.
- `docs/solutions/` contains prior implementation learnings.

## Scoped Instructions

- `apps/desktop/AGENTS.md` - Electron main/preload, IPC, app-data paths, vault.
- `apps/web/AGENTS.md` - React renderer, UI state, routes, desktop bridge usage.
```

Vitest project discovery pattern:

```ts
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const projectDirs = ["packages", "apps"].flatMap((parent) =>
  readdirSync(parent)
    .map((name) => join(parent, name))
    .filter((path) => statSync(path).isDirectory()),
);

export default defineConfig({
  test: {
    projects: projectDirs,
  },
});
```

Verification language to prefer:

```md
Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and relevant `pnpm e2e` checks from the repo root.
Persistence-sensitive behavior must survive app restart.
```

## Related

- [Battle-testing matrix and test-hardening execution for core app surfaces](../architecture-patterns/test-audit-driven-battle-testing.md)
- [Stabilize Electron E2E build locks and lineage contracts](../test-failures/electron-e2e-stale-build-lock-and-lineage-contract.md)
- [Quiet macOS Electron E2E launches](../developer-experience/quiet-macos-electron-e2e-launches.md)
