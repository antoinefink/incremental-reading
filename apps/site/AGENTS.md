# AGENTS.md

`apps/site` is the public/static product site, not the local desktop app.

Boundaries:

- Do not use `window.appApi`, Electron IPC, SQLite, local-db, or asset-vault internals.
- Reuse Interleave's visual language through design tokens, typography, and `lucide-react`, but do
  not import renderer-only desktop surfaces when a static page should stand alone.
- Keep copy aligned with the local-first product identity: Electron desktop, native SQLite,
  filesystem asset vault, source lineage, and encrypted-backup-only server scope.
- Static build/deploy assumptions belong here; desktop runtime assumptions belong in
  `apps/desktop` or `apps/web`.

Package checks are `pnpm --filter @interleave/site typecheck`, `pnpm --filter @interleave/site
test`, and `pnpm --filter @interleave/site build`. Completed repo work still needs root
`pnpm lint`, `pnpm typecheck`, `pnpm test`, and relevant `pnpm e2e`.
