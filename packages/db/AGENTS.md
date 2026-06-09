# AGENTS.md

`packages/db` owns the Drizzle SQLite schema, migration files, schema alignment tests, and
migration utilities.

Any schema change must include:

- Drizzle schema update
- generated SQLite migration under `drizzle/`
- snapshot metadata update
- tests for schema shape, constraints, and migration behavior where relevant

SQLite is canonical for local data. Do not store large PDF/image/audio/video/HTML blobs here; store
asset metadata, hashes, MIME types, sizes, owning element IDs, and vault-relative paths.

Preserve foreign keys and soft-delete semantics. `operation_log` is part of the durable schema and
must support meaningful mutations such as element creation/update, source import, document update,
extraction, card creation, review logs, scheduling, relations, and tags.

Do not model the backup server as a domain mirror. Backup stores encrypted archives only.
