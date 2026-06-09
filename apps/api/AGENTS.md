# AGENTS.md

This app is scoped to the encrypted-backup service only.

Allowed scope:

- Account/auth surfaces needed for backup access.
- Backup manifest metadata.
- Encrypted archive/blob coordination.
- Health and operational endpoints for the backup service.

Do not implement live multi-device sync, server-side domain mirrors, plaintext source/extract/card
storage, product workflow APIs, or background workers for local knowledge processing. The desktop
app remains the source of truth: SQLite plus local asset vault. The API never receives plaintext
domain data.

Use native `pnpm` for repository checks. Docker may support future backup infrastructure, but it is
not the desktop app development loop.
