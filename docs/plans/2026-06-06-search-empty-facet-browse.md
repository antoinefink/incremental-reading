---
title: Fix Search Empty Facet Browse
type: fix
status: completed
date: 2026-06-06
---

# Fix Search Empty Facet Browse

## Summary

The `/search` page should be useful before a keyword is typed. Type, Concept, and Priority facets need visible counters on the empty screen, and selecting a facet such as `Sources` or `Intelligence` must show the matching collection rows instead of staying on the prompt.

## Problem Frame

The prior `docs/plans/2026-06-06-search-filterbar-counts.md` fixed keyword-search facet counts, but `apps/web/src/library/LibraryScreen.tsx` still hides Type/Priority counters until `hasQuery` and explicitly clears results for an empty query. That makes empty-query facet clicks inert even though `apps/web/src/library/BrowseScreen.tsx` and `appApi.libraryBrowse` already support browse-first facets with main-side counts.

## Requirements

- R1. `/search` renders counters next to each Type chip even when no keyword query is active.
- R2. Clicking a Type chip with no keyword shows matching collection rows from the existing typed `library.browse` bridge.
- R3. Clicking a Concept chip with no keyword shows rows assigned to that concept; clicking `Intelligence` must reveal its matching collection items.
- R4. Empty-query Priority clicks also browse by priority within the same source/extract/card search universe.
- R5. Every empty-query `/search` browse request is bounded to `source`, `extract`, and `card`, including concept-only and priority-only clicks.
- R6. Keyword search keeps the existing FTS/semantic behavior, including drill-down counts, stale-response guards, and no renderer-side SQL.
- R7. Tests cover renderer wiring and Electron E2E facet clicks; backend/property coverage is added only where the implementation changes backend semantics.

## Key Technical Decisions

- **Use `library.browse` only for empty-query browsing:** The browse bridge already returns live collection rows and global drill-down counts without a keyword. Reusing it avoids inventing a second empty-query search path or doing domain counting in React. Requests from `/search` always pass the searchable type set when no single type is active.
- **Keep searchable result grouping to Source/Extract/Card on `/search`:** The search screen's Type facet only exposes the three searchable types. Empty-query browse calls should pass those type filters and render rows through the same source/extract/card result UI.
- **Normalize browse rows into the existing search row shape:** `LibraryItem` already carries the fields the search result UI needs. A small renderer adapter can convert browse items to `LibraryRow` with a neutral score/snippet so detail panels and open behavior stay shared.
- **Preserve keyword paths unchanged:** Once a keyword is present, continue using `search.query` or `semantic.search` so FTS ranking, semantic fusion, and exact drill-down counts stay intact.

## Implementation Units

### U1. Empty-Query Browse In LibraryScreen

- **Goal:** Run `appApi.libraryBrowse` when the search query is empty and a filter is selected, and render the returned source/extract/card rows.
- **Files:** `apps/web/src/library/LibraryScreen.tsx`.
- **Patterns:** Follow `apps/web/src/library/BrowseScreen.tsx` for request shape and cancellation; keep the existing `LibraryScreen` keyword effect for non-empty queries.
- **Test Scenarios:** No filters shows prompt but counters; Type=source fetches `{ types: ["source"] }` and renders source rows; Concept=Intelligence fetches `{ conceptId, types: ["source", "extract", "card"] }` and renders rows; Priority=A fetches `{ priorityLabel: "A", types: ["source", "extract", "card"] }`.
- **Verification:** `apps/web/src/library/LibraryScreen.test.tsx` passes.

### U2. Empty-Query Counter Semantics

- **Goal:** Render Type and Priority counts from `library.browse` counts when no keyword is active, while Concept chips continue using browse drill-down counts instead of only global `memberCount`.
- **Files:** `apps/web/src/library/LibraryScreen.tsx`, `apps/web/src/library/LibraryScreen.test.tsx`.
- **Patterns:** Follow `apps/web/src/library/BrowseScreen.tsx` and `packages/local-db/src/library-query.ts` drill-down count semantics.
- **Test Scenarios:** Empty-query Type chip counts reflect backend browse `byType`; Concept counts reflect searchable-type browse counts; Type and Concept together keep counts synchronized with the list; no keyword still does not call `search.query`.
- **Verification:** Renderer and local-db property tests pass.

### U3. Electron E2E Regression Coverage

- **Goal:** Prove the user-visible search page works in the real Electron app.
- **Files:** `tests/electron/search.spec.ts`.
- **Patterns:** Use the existing `launchApp` seeded data dir and direct typed-bridge assertions already in the search spec.
- **Test Scenarios:** Opening `/search` shows Type counters before typing; clicking `Sources` with no keyword renders source results; clicking the seeded `Intelligence` concept with no keyword renders relevant rows; keyword search still works after app restart.
- **Verification:** `pnpm e2e -- tests/electron/search.spec.ts` or the closest supported targeted Electron Playwright command passes.

## Scope Boundaries

- Do not change FTS ranking, search syntax, semantic embedding, or database migrations.
- Do not add status facets to `/search`; the broader `/library` route already owns all-type/status browsing.
- Do not turn `/search` into unfiltered browse-all; with no keyword and no selected facet it should still show the search prompt while rendering facet counters.
- Do not expose raw DB or filesystem access to the renderer.

## Risks & Dependencies

- The empty-query browse response can include non-searchable types if called without a Type filter. The `/search` renderer must request only the three searchable types unless a single searchable type is selected.
- `/search` and `/library` now share browse semantics for empty-query facets, so tests should keep their expected UI roles distinct: `/search` remains keyword-first, while `/library` remains browse-first.

## Sources

- `docs/solutions/ui-bugs/search-filterbar-facet-counts-after-search.md`
- `docs/tasks/M8-organize.md`
- `CONCEPTS.md`
- `apps/web/src/library/LibraryScreen.tsx`
- `apps/web/src/library/BrowseScreen.tsx`
- `apps/desktop/src/main/db-service.ts`
- `packages/local-db/src/library-query.ts`
- `tests/electron/search.spec.ts`
