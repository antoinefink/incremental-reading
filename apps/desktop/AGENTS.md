# AGENTS.md

This is the trusted Electron desktop shell.

Owns:

- Electron main process, preload bridge, lifecycle, windows, menus, IPC, app paths, native SQLite,
  asset vault, backups, capture server, and on-device background work.
- Validated command-shaped APIs exposed to the renderer through `window.appApi`.

Security boundary:

- Keep `contextIsolation: true`, `nodeIntegration: false`, `enableRemoteModule: false`, and
  sandboxing where practical.
- Never expose generic SQL, arbitrary filesystem access, or raw Node capabilities to the renderer.
- Validate IPC payloads and keep durable mutations transactional, operation-logged, and
  source-lineage preserving.
- Worker/utility-process jobs do compute and return results; main-side services own trusted
  persistence and vault writes.

Renderer code belongs in `apps/web`; desktop provides trusted capabilities, not React UI domain
logic. Verify desktop changes with `pnpm lint`, `pnpm typecheck`, `pnpm test`, and relevant
Electron `pnpm e2e` from the repo root.
