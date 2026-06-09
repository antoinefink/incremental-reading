# AGENTS.md

`packages/` contains shared code used behind the Electron app boundary and by the renderer.

Keep ownership clear:

```txt
core -> db -> local-db/services -> desktop IPC -> web renderer
core -> scheduler/editor/importers/ui/testing as needed
```

Do not introduce renderer access to SQLite, filesystem paths, or asset bytes. Trusted local
capabilities stay in Electron and `packages/local-db`.

Preserve the Element model: sources, topics, extracts, cards, tasks, concepts, media fragments,
and synthesis notes are elements or belong to elements. Source lineage must remain traceable from
card/extract back to source location, source metadata, and original document context.

Behavioral package changes need focused Vitest coverage, usually near the changed package plus
shared fixtures from `packages/testing`.
