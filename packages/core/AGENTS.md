# AGENTS.md

`packages/core` owns domain types and invariants. Keep it persistence-agnostic: no Drizzle,
SQLite, Electron, filesystem, React, or IPC imports.

Element is the universal primitive. Do not add parallel domain models for sources, extracts,
cards, tasks, concepts, media fragments, or synthesis notes.

Keep these concepts distinct:

- lifecycle status: inbox, pending, active, scheduled, done, dismissed, suspended, deleted
- distillation stage: raw_source through synthesis
- numeric priority, surfaced as A/B/C/D labels elsewhere
- source lineage: parent element, source element, source location, selected text snapshot

Asset types describe metadata and vault-relative locations only. Raw absolute paths are resolved by
Electron/local-db code, never by core or renderer code.

Operation log types should remain command-shaped and stable enough for undo, audit, and
incremental backup.

## Card Quality

Card-quality heuristics follow the minimum-information principle and belong in pure domain code,
not React components. Warn or block when cards are empty, too long, multi-fact, ambiguous, missing
source, oversized cloze/list, likely to interfere with similar cards, or time-sensitive without an
anchor date/version. AI-generated cards are drafts until explicitly approved.
