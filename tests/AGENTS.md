# AGENTS.md

`tests/` contains cross-package and end-to-end coverage, especially Electron Playwright flows.

Use E2E for user flows and boundaries that unit tests cannot prove:

- import and inbox triage
- source activation, reader state, read-points, extraction, and jump-to-source
- card creation, review grading, sibling burying, leech/repair flows
- search, settings, backup/export/restore, capture loopback, and app restart persistence
- renderer-to-Electron IPC behavior where real desktop wiring matters

Persistence-sensitive features should include an app restart and re-open assertion when feasible.
Keep Electron tests deterministic: isolated data dirs, explicit seeds/fixtures, and no reliance on
network access unless the test explicitly owns that mock.

Completed implementation work still needs root-level `pnpm lint`, `pnpm typecheck`, `pnpm test`,
and relevant `pnpm e2e` verification.
