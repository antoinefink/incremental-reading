---
title: Process queue extract height
status: completed
created: 2026-06-08
origin: user screenshot follow-up
execution: code
---

# Process Queue Extract Height

## Problem

The `/process` extract workbench appears as a centered content-sized card with a
short internal editor, leaving large unused vertical space above and below the
card. The user expected the extract block to claim much more of the middle
viewport so fewer prose lines are hidden behind internal scrolling.

## Scope

Improve the Process Queue extract workbench only. Do not change source reader
routes, queue ordering, queue actions, extract persistence, card creation,
selection toolbar geometry, or scheduling behavior.

## Requirements

- R1. Extract items in Process Queue should use the available vertical space in
  the middle work area instead of staying content-height and vertically centered.
- R2. The extract editor/prose area should flex to fill the expanded card.
- R3. The bottom process action bar and keyboard hint should remain reachable.
- R4. Only the prose/editor reader should own unbounded vertical scrolling; fixed
  controls, metadata, and action rows should stay as normal-flow siblings.
- R5. Loading/done/empty/card states may keep their existing centered presentation.

## Key Technical Decisions

- **Add an explicit extract center modifier.** Derive `pq-center--extract` from
  the current item type instead of relying on `:has()` selector behavior.
- **Make extract cards fill the center height.** Let `.pq-card--extract` use
  `height: 100%` with a bounded max height and `overflow: hidden` so the card,
  not the page, owns the workbench frame.
- **Make the workbench/editor flex.** Let `.pq-extract` and
  `.pq-extract__editor` flex through the card; remove the old `46vh` editor cap.
- **Keep controls non-scrolling.** Preserve `.pq-extract__meta`,
  `.pq-extract__tools`, `.pq-actions`, and `.pq-keys` as non-scrolling siblings;
  keep `.pq-extract__editor .reader` as the scroll owner.

## Existing Patterns

- `apps/web/src/pages/queue/ProcessQueue.tsx` renders the process loop and the
  current `ProcessCard`.
- `apps/web/src/pages/queue/process-queue.css` owns `.pq-center`,
  `.pq-card--extract`, `.pq-extract`, and `.pq-extract__editor` layout.
- `apps/web/src/pages/queue/ProcessQueue.test.tsx` already contains the process
  extract scroll-containment structure/CSS contract.
- `docs/solutions/ui-bugs/extract-distillation-scroll-contained-editor.md`
  documents the same prose-scrolls-inside-editor pattern for `/process`.

## Implementation Units

### U1. Process Center Extract Modifier

- **Goal:** Stop vertically centering extract workbench cards while preserving
  centered loading/done/card/source presentation.
- **Files:**
  - Modify: `apps/web/src/pages/queue/ProcessQueue.tsx`
  - Modify: `apps/web/src/pages/queue/process-queue.css`
  - Test: `apps/web/src/pages/queue/ProcessQueue.test.tsx`
- **Approach:** Compute whether the current item is an extract and add
  a `pq-center--extract` class to the process center. In CSS, make that center
  `justify-content: flex-start` and `overflow: hidden`.
- **Test Scenarios:**
  - Extract items render within a center carrying `pq-center--extract`.
  - Loading/done states do not require the workbench modifier.
  - The process item/action behavior remains unchanged.
- **Verification:** Targeted ProcessQueue tests.

### U2. Taller Extract Card and Editor Flex Contract

- **Goal:** Make the extract card/editor fill available height while keeping
  action controls reachable and prose scroll-contained.
- **Files:**
  - Modify: `apps/web/src/pages/queue/process-queue.css`
  - Test: `apps/web/src/pages/queue/ProcessQueue.test.tsx`
- **Approach:** Update `.pq-card--extract`, `.pq-extract`, and
  `.pq-extract__editor` so height flows from center to card to workbench to
  editor. Keep `.pq-extract__editor .reader` scrollable and keep footer/action
  rows `flex: none`.
- **Test Scenarios:**
  - `.pq-card--extract` has `height: 100%`, a non-`none` max-height, and hidden
    overflow.
  - `.pq-extract` and `.pq-extract__editor` flex with `min-height: 0`.
  - `.pq-extract__editor` no longer has the old `46vh` cap.
  - `.pq-extract__editor .reader` remains the only scrollable prose region.
- **Verification:** Targeted ProcessQueue tests and changed-file Biome check.

## Verification Plan

- Run `pnpm --filter @interleave/web test -- ProcessQueue`.
- Run `pnpm e2e tests/electron/process-editor-focus.spec.ts`.
- Run `pnpm typecheck`.
- Run `pnpm test`.
- Run `pnpm exec biome check` on changed files.
- If feasible, visually inspect `/queue/process` in the app or via browser/Electron
  coverage to confirm the extract workbench fills the available middle height.
