# AGENTS.md

This is the Manifest V3 capture extension.

Rules:

- Treat the desktop app as the local authority.
- Communicate through the token-protected `127.0.0.1` loopback protocol and
  `@interleave/capture-contract`.
- Do not import `@interleave/core`, `@interleave/local-db`, `apps/web`, or Electron.
- Do not talk to `apps/api` as a sync backend.
- Do not store long-term knowledge state in the extension.
- Preserve source metadata needed for lineage: URL, title, selected text, surrounding context,
  priority/reason when supplied, and capture time.

The extension handles capture, handoff, and user consent. Persistence, triage, scheduling,
extraction, cards, and review belong in the desktop app.

Verify with `pnpm lint`, `pnpm typecheck`, `pnpm test`, extension-specific tests, and relevant
loopback/Electron `pnpm e2e` coverage from the repo root.
