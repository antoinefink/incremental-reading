# AGENTS.md

`packages/importers` converts external material into normalized source/document/asset inputs. It
does not write SQLite directly and does not expose filesystem access to the renderer.

Imported sources must preserve provenance:

- original URL/path and canonical URL when available
- author, published, and accessed metadata when available
- cleaned/readable content plus original snapshot reference when applicable
- stable blocks suitable for editor lineage

Large assets belong in the Electron-managed asset vault, not SQLite. Importers should produce
asset metadata, content hashes, MIME types, sizes, and vault-relative placement requests for
Electron/local-db code to persist.

Do not silently discard source text or metadata that future extracts/cards may need. Add fixtures
for representative article/PDF/media inputs and tests for malformed, partial, and metadata-poor
imports.
