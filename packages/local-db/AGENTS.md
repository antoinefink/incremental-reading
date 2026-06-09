# AGENTS.md

`packages/local-db` owns SQLite repositories, transactional domain operations, and operation-log
appends behind the Electron/IPC boundary.

Use `better-sqlite3` + Drizzle. Database opens must enforce:

- `PRAGMA foreign_keys = ON`
- `journal_mode = WAL`
- `busy_timeout = 5000`

Multi-table mutations must run in transactions and append the matching `operation_log` entry in
the same transaction. Do not add mutations that update durable user data without a command-shaped
log entry.

Preserve lineage fields when creating extracts/cards: parent element, source element, source
location, stable block IDs, offsets when available, and selected text snapshot.

Do not expose raw SQL, arbitrary filesystem access, or absolute vault paths to the renderer.
Repositories return typed domain data suitable for IPC services.

Every review grade creates a durable review log and updates review state transactionally. Repair,
suspend, delete, leech, and source-opening support must preserve lineage and remain auditable.
