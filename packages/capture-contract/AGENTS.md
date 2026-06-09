# AGENTS.md

`packages/capture-contract` owns the browser-extension-to-desktop loopback wire contract.

Keep it small and dependency-light:

- Zod schemas and TypeScript types for capture payloads, pairing, ping, and validation.
- No Electron, React, SQLite, local-db, filesystem, or renderer imports.
- Payloads must preserve provenance needed for source lineage: URL, title, selected text,
  surrounding context, priority/reason when supplied, and capture time.
- Enforce size limits, allowed shapes, and explicit failure modes in the schema rather than in
  extension or desktop callers alone.

Changes need tests covering valid payloads, malformed payloads, boundary sizes, and compatibility
between extension callers and desktop loopback handlers.
