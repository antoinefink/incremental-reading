# AGENTS.md

`apps/` contains runnable application surfaces. Keep boundaries explicit:

- `desktop/` owns trusted local capabilities: Electron main/preload, native menus, app paths,
  SQLite access, asset vault access, backups, local jobs, and IPC.
- `web/` is renderer UI only. It calls typed app APIs and must not import Node, SQLite,
  filesystem, or Electron main-process modules.
- `api/` is encrypted-backup infrastructure only. Do not build sync, plaintext domain mirrors,
  product workflow APIs, or server-side knowledge processing there.
- `extension/` captures material into the local desktop app through the loopback contract. It is
  not a sync client.
- `site/` is public/static product presentation; it must not depend on local app internals.

Use native `pnpm` from the workspace root for `pnpm lint`, `pnpm typecheck`, `pnpm test`, and
relevant `pnpm e2e`. Docker is not the desktop app development or verification path.
