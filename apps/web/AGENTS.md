# AGENTS.md

This is the React renderer UI.

Rules:

- UI only: no direct SQLite, filesystem, Node, Electron main-process, or asset-vault access.
- Use the typed client API / `window.appApi` bridge for live desktop data and mutations.
- Keep domain logic out of components; scheduling, review transitions, extraction lineage,
  repositories, and persistence belong in packages behind the desktop IPC boundary.
- Follow `design/AGENTS.md` and `docs/design-system.md`; use design tokens and `lucide-react`
  icons.

`pnpm dev:renderer` is only for isolated UI work and will not provide live desktop capabilities.
Use `pnpm dev` when behavior depends on `window.appApi`.

Verify renderer work with `pnpm lint`, `pnpm typecheck`, `pnpm test`, and relevant Electron
`pnpm e2e` from the repo root.

## Review UI

Review sessions must stay fast, repairable, and source-grounded. The UI must support reveal,
Again/Hard/Good/Easy grading with interval previews, edit prompt/answer, open source, suspend,
delete, mark leech, and add context. Do not show sibling cards back-to-back unless the flow
explicitly asks for it.
