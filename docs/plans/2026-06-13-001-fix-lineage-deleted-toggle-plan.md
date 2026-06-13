---
title: "fix: Hide deleted lineage tombstones behind a header toggle"
type: fix
date: 2026-06-13
execution: code
---

# fix: Hide deleted lineage tombstones behind a header toggle

## Summary

Hide deleted lineage tombstones by default in the Inspector, surface a compact `Show deleted` control on the same row as `Lineage` only when restorable tombstones exist, and make revealed Restore controls visually lighter while preserving keyboard access and the existing `restoreAncestorChain` behavior.

## Problem Frame

The current tombstone UI keeps every Restore button continuously visible. That preserves recoverability, but it makes deleted lineage nodes more prominent than live lineage by adding bright, repeated action pills to rows the user usually wants to mentally de-emphasize.

This work is renderer polish over the existing lineage-aware deletion system. The backend tombstone query, typed IPC, restore service, purge guard, and operation-log behavior remain unchanged.

## Requirements

- R1. Deleted lineage nodes are hidden by default when the Inspector opens or the selected element changes.
- R2. The `Lineage` heading shows a compact show/hide control only when the current lineage contains at least one deleted, restorable tombstone.
- R3. Revealing deleted lineage shows the tombstone rows, the deleted-ancestor hint when applicable, and keyboard-reachable Restore controls using the existing ancestor-chain restore command.
- R4. Hiding deleted lineage does not hide live descendants, break navigation, or leave indentation gaps that visually imply missing rows.
- R5. Restore controls are slimmer and quieter than the current pills while staying legible in light and dark themes.
- R6. The change stays renderer-only and uses existing typed `appApi` calls; it does not add persistence, IPC, schema, or domain-service behavior.

## Key Technical Decisions

- **Keep tombstone-aware reads:** The Inspector should continue requesting `includeTombstones: true` so the renderer can decide whether deleted nodes exist and so reveal/restore is instant without a second IPC shape.
- **Default to a local collapsed UI state:** `showDeletedLineage` belongs in Inspector React state, resets on selection changes, and is not persisted to settings or local data.
- **Filter at the rendering boundary:** Pass a derived visible node list into `LineageTree` rather than changing `LineageTree`'s basic tombstone rendering contract.
- **Normalize visible depths after filtering:** When hidden deleted ancestors are omitted, live descendants should compress to the nearest visible parent depth so the tree remains visually coherent.
- **Use the existing restore primitive:** Per-tombstone Restore and the ancestor hint continue to call `restoreAncestorChain`, never `restoreFromTrash`, so unrelated deleted sibling or cousin branches are not resurrected.

## Implementation Units

### U1. Add collapsed deleted-lineage behavior

- **Goal:** Hide tombstones by default, add the conditional header toggle, and keep live lineage rows navigable when deleted rows are hidden.
- **Requirements:** R1, R2, R3, R4, R6.
- **Dependencies:** None.
- **Files:**
  - Modify `apps/web/src/components/inspector/Inspector.tsx`.
  - Modify `apps/web/src/components/inspector/LineageTree.test.tsx` only if a depth-normalization helper is extracted there.
  - Modify `apps/web/src/components/inspector/Inspector.test.tsx`.
- **Approach:** Add Inspector-local state for showing deleted lineage, reset it on selected-element changes, compute the deleted count from the tombstone-aware lineage payload, and render a compact toggle inside the existing lineage section title. Derive the nodes passed to `LineageTree`: full nodes when revealed, live-only nodes with normalized depths when collapsed. Gate the deleted-ancestor hint and per-tombstone Restore controls behind the revealed state.
- **Patterns to follow:** Existing lineage fetch and restore wiring in `apps/web/src/components/inspector/Inspector.tsx`; presentational tree rendering in `apps/web/src/components/inspector/LineageTree.tsx`; prior tombstone tests in `apps/web/src/components/inspector/LineageTree.test.tsx`.
- **Test scenarios:**
  - With live-only lineage, no show/hide deleted control is rendered and all live rows remain visible.
  - With one deleted ancestor, initial render hides the tombstone row and Restore button, shows `Show deleted`, and keeps the live descendant visible.
  - Activating `Show deleted` reveals the tombstone row, deleted tag, ancestor hint, and Restore button; activating it again hides them.
  - Selecting a different element resets the toggle to hidden for the next lineage payload.
  - When collapsed, a live descendant under a hidden tombstone renders without extra blank indentation.
- **Verification:** Component tests prove the default-hidden state, reveal state, reset behavior, and no-deleted case without mocking new backend behavior.

### U2. Make Restore controls slimmer and verify the visual result

- **Goal:** Reduce the visual weight of revealed Restore actions and update end-to-end coverage for the new toggle flow.
- **Requirements:** R3, R5.
- **Dependencies:** U1.
- **Files:**
  - Modify `apps/web/src/components/inspector/inspector.css`.
  - Modify `apps/web/src/components/inspector/inspector-css.test.ts` if CSS token expectations need coverage.
  - Modify `tests/electron/lineage-deletion.spec.ts`.
- **Approach:** Restyle `.tree-node__restore` and the lineage ancestor restore treatment to read as compact inline utilities instead of dominant pills, using existing design tokens and the `restore` icon mapping. Update Electron coverage so the real app first proves deleted lineage is hidden, then reveals deleted rows through the new header toggle before asserting tombstone restore behavior.
- **Patterns to follow:** Design token guidance in `docs/design-system.md`; lineage CSS in `apps/web/src/components/inspector/inspector.css`; current lineage deletion E2E assertions in `tests/electron/lineage-deletion.spec.ts`.
- **Test scenarios:**
  - Electron flow with a live card under a deleted ancestor initially shows the header toggle but no tombstone tag or Restore button.
  - Clicking the toggle reveals the tombstone tag, ancestor hint, and Restore control.
  - The revealed Restore control still restores through the existing typed bridge path.
  - Visual inspection in the running app confirms the heading row, toggle, hidden state, and revealed Restore treatment look balanced in the Inspector.
- **Verification:** Targeted component tests pass, the lineage deletion E2E covers the user-visible toggle flow, and a browser screenshot/inspection confirms the design.

## Scope Boundaries

- No schema, migration, IPC, local-db, or restore-service changes.
- No change to Trash restore behavior, purge guards, branch-delete grouping, or operation-log semantics.
- No persistent user preference for showing deleted lineage.
- No hover-only restore affordances; restore remains keyboard reachable after deleted rows are revealed.

## Sources & Research

- `CONCEPTS.md` defines `Lineage tombstone` as a display state derived from soft deletion and used to preserve source lineage.
- `docs/solutions/architecture-patterns/lineage-aware-deletion-tombstone-purge-guard.md` establishes the tombstone-and-restore-chain pattern this polish must preserve.
- `docs/solutions/ui-bugs/extract-inspector-single-responsibility-lineage-scheduler.md` reinforces that lineage actions belong in the Inspector lineage surface and should refresh through narrow UI paths.
- `docs/design-system.md`, `design/README.md`, and `design/icon-map.md` require design tokens and `lucide-react` icon mappings for UI work.
