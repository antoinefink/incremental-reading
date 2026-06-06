---
title: Captured Article Open Action
type: fix
status: completed
date: 2026-06-06
---

# Captured Article Open Action

## Summary

Browser-captured articles should be openable immediately after capture. Add a narrow authenticated extension-to-desktop action that opens the captured source in Interleave's existing source reader, activating the source first when it is still in the inbox.

---

## Problem Frame

The browser extension already receives the captured source id from the loopback capture response, and recent captures store that id. The popup and side panel only render passive success text, so a user who just saved an article has no direct path into the local reader and must later find the source through Library or Search.

---

## Requirements

- R1. A successful page or selection capture must expose a visible action to open the captured source in the desktop app.
- R2. Recent captures in the side panel must remain actionable, not just static history rows.
- R3. The open action must use the paired loopback trust boundary with bearer token and paired-origin validation.
- R4. Opening a captured source must focus the desktop window and route to `/source/$id`.
- R5. If the source is still an inbox source, opening it to start work must move it to `active` through the same logged element-update path as inbox `Read now`.
- R6. The extension must not import renderer, Electron, local-db, or filesystem code.
- R7. Existing capture, pairing, and duplicate-detection behavior must continue unchanged.

---

## Key Technical Decisions

- **Extend the capture loopback surface narrowly:** Add a token-authenticated `POST /open-source` endpoint rather than a generic command endpoint. The endpoint accepts only a source id plus an activate flag and reuses the same token/origin checks as `/capture`.
- **Keep activation main-side:** Main already owns SQLite and lifecycle state. The open command should no-op for already-active or dismissed sources but update live inbox sources to `active` with `update_element`.
- **Navigate by existing source route:** The desktop side should focus the first app window and load the existing `/source/$id` route. No renderer-side raw database or filesystem access is needed.
- **Centralize extension client behavior:** Add a shared extension helper for the open request so the popup, side panel status action, and recent rows all call the same loopback client.

---

## Implementation Units

### U1. Authenticated desktop open command

- **Goal:** Add a narrow desktop loopback command that validates the extension request, activates inbox sources when requested, focuses the app, and opens `/source/$id`.
- **Files:** Modify `packages/capture-contract/src/index.ts`, `apps/desktop/src/main/capture-server.ts`, `apps/desktop/src/main/capture-controller.ts`, `apps/desktop/src/main/index.ts`, and targeted tests in `packages/capture-contract/src/index.test.ts`, `apps/desktop/src/main/capture-server.test.ts` or `apps/desktop/src/main/capture-controller.test.ts`.
- **Patterns:** Follow `/capture` token/origin handling in `apps/desktop/src/main/capture-server.ts`, window focus behavior in `apps/desktop/src/main/index.ts`, and logged status updates via `ElementRepository.updateWithin`.
- **Test scenarios:** Bad token/origin is rejected; valid open calls the injected opener; an inbox source is updated to `active`; already-active sources open without duplicate mutation; missing/deleted/non-source ids return a typed failure.
- **Verification:** Targeted Vitest coverage proves the endpoint stays narrow and the activation update is logged.

### U2. Extension open buttons

- **Goal:** Render an `Open in Interleave` / start-working action after successful popup and side-panel captures, and make recent side-panel rows openable.
- **Files:** Modify `apps/extension/src/shared.ts`, `apps/extension/src/popup.ts`, `apps/extension/src/sidepanel.ts`, plus `apps/extension/src/shared.test.ts`, `apps/extension/src/popup.test.ts`, and `apps/extension/src/sidepanel.test.ts`.
- **Patterns:** Keep extension code browser-only and route all loopback calls through `apps/extension/src/shared.ts`. Use existing status rendering and recent-capture storage rather than adding a second source list.
- **Test scenarios:** Success status includes an open button; clicking it sends the captured id through the shared helper; recent rows expose open buttons; not-paired/not-running/bad-token outcomes render as existing warning/error states.
- **Verification:** Extension component tests cover popup, status action, and recent-row action.

### U3. In-app URL duplicate open consistency

- **Goal:** Fix the in-app URL-import duplicate `Open existing` path so it opens the existing source reader instead of trying to select a non-inbox row.
- **Files:** Modify `apps/web/src/pages/inbox/InboxScreen.tsx` and `apps/web/src/pages/inbox/InboxScreen.test.tsx`.
- **Patterns:** Follow direct source navigation from `apps/web/src/library/LibraryScreen.tsx` and keep external provenance links separate from internal processing actions.
- **Test scenarios:** Duplicate `Open existing` closes the modal and navigates to `/source/$id`; normal fresh imports still refresh/select the new inbox row.
- **Verification:** Targeted inbox component test covers the parent callback behavior.

---

## Scope Boundaries

- This does not add a generic loopback command API.
- This does not expose arbitrary renderer navigation to the extension.
- This does not change import extraction, duplicate detection, or capture pairing.
- This does not redesign the source reader or inbox screen.

---

## Risks & Dependencies

- The loopback server is intentionally small; adding one route must preserve its exact-origin CORS and bearer-token posture.
- Loading a deep route from Electron main must work in both dev-server and `app://` production modes.
- Activation is a data mutation, so it must stay main-side, transactional, and logged.

---

## Sources / Research

- `apps/extension/src/popup.ts` and `apps/extension/src/sidepanel.ts` render capture success as passive text today.
- `apps/extension/src/background.ts` and `apps/extension/src/shared.ts` already carry successful capture ids from the desktop response.
- `apps/desktop/src/main/capture-server.ts` owns the paired loopback routes and trust boundary.
- `apps/desktop/src/main/window.ts` and `apps/desktop/src/main/renderer-protocol.ts` define how desktop windows load renderer routes.
- `docs/solutions/ui-bugs/url-imported-articles-inbox-processing.md` records the existing in-app `Read now` pattern.
