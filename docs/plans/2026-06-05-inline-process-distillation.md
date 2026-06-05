---
title: Process Queue Extract Workbench and Review Presentation
status: completed
created: 2026-06-05
execution: code
---

# Process Queue Extract Workbench and Review Presentation

## Product Judgment

The first inline `/process` extract workbench moved the queue from passive triage to real
distillation: stage changes, rewriting, trimming, and card creation now happen without leaving
the daily queue. Two follow-up observations show where the experience still falls short of a
gold-standard incremental reading app:

- A reviewed Q&A card can show the answer and then immediately show the same source snippet in the
  reference block. That is not data corruption, but it is a presentation bug. The answer is the
  thing the user had to recall; the reference block is evidence/provenance. When those strings are
  effectively identical, the reference should collapse to citation/provenance instead of repeating
  the full text.
- A selected passage inside an extract should be actionable. In the full extract workspace this is
  already the intended model: selection -> sub-extract, cloze, copy. The inline queue workbench
  currently lacks that selection toolbar, which makes "Open in full" feel required for a core
  incremental-reading gesture. That is acceptable as an incomplete first pass, but not as the final
  behavior.

The target product rule is:

```txt
Source selection -> Extract / Highlight / Cloze / Copy
Extract selection -> Sub-extract / Cloze / Copy
Card review evidence -> show citation always; show snippet only when it adds new information
```

## Scope

In scope:

- Keep the already-built `/process` extract workbench: editable extract body, stage stepper, trim,
  save, Q&A/cloze builder entry, source grounding, and queue actions.
- Add context-aware selection actions inside the inline `/process` extract editor:
  - `Sub-extract` from the selected text
  - `Cloze` from the selected text
  - `Copy`
- Align the full `/extract/$id` selection toolbar with the same context-aware action set.
- Remove no-op or misleading actions from extract-selection toolbars, especially `Highlight` when
  it is not implemented for extract bodies.
- Add review/process card reference de-duplication so identical answer/evidence is not shown twice.
- Preserve lineage: sub-extracts must keep `sourceElementId` pointing at the original source root
  and `parentId` pointing at the extract currently being processed.
- Add tests for all new renderer wiring and a real Electron persistence flow.
- Re-run visual checks for the process queue and card review surfaces.

Out of scope:

- New schema, migrations, or IPC commands. Existing bridge commands already cover this:
  `extractions.create`, `extracts.rewrite`, `extracts.updateStage`, `cards.create`,
  `documents.marks.*`, and review reads.
- Implementing extract-body highlight persistence. Highlights are currently a source-reader
  annotation model; adding extract highlights needs a separate product decision about whether they
  are purely visual, scheduled, or lineage-bearing.
- Replacing the full extract workspace. `/process` should be dense and fast; `/extract/$id` remains
  the deep inspection and lineage surface.

## Current State

- `/process` card review:
  - Reveals and grades cards inline.
  - Shows `CardBody(answer)` and then `RefBlock(sourceRef)`.
  - The repeated-text screenshot is explained by this: `card.answer` and
    `sourceRef.snippet` can be the same extracted passage.
- `/process` extract workbench:
  - Supports stage changes, editing, trim/save, and opening Q&A/cloze card builder.
  - Does not yet bind `useTextSelection` or render `SelectionToolbar`.
  - Does not yet create sub-extracts from inline selections.
- `/extract/$id` full workspace:
  - Already has `useTextSelection`, `SelectionToolbar`, and `onSubExtract`.
  - `Extract` maps to a child sub-extract.
  - `Cloze` opens the builder pre-wrapped from selection.
  - `Highlight` is visible but currently only dismisses the toolbar, which is misleading.

## UX Specification

### Review Evidence De-Duplication

When a Q&A card is revealed:

- Always show the card answer prominently.
- Always show citation/provenance if a source reference exists.
- Show the source snippet only when it adds materially different context.
- If `normalize(answer) == normalize(sourceRef.snippet)` or one is a near-substring of the other,
  render the reference block without the quote body.
- Keep the source title, author/date, location, reliability badge, external URL, and open-source
  action visible.

This applies to:

- `ReviewScreen`
- inline card review inside `ProcessQueue`

It should not change:

- Extract source-context panels, where showing the original snippet is useful.
- Inspector and library details, unless those surfaces later get their own de-duplication rules.

### Context-Aware Selection Toolbar

`SelectionToolbar` should become presentational but configurable:

- Source reader actions:
  - `Extract` (`E`)
  - `Cloze` (`C`) if/when supported on that surface
  - `Highlight` (`H`)
  - `Copy`
  - Cancel
- Extract reader/actions:
  - `Sub-extract` (`E`)
  - `Cloze` (`C`)
  - `Copy`
  - Cancel

The extract toolbar must not show `Highlight` until extract-body highlights are real.

Keyboard behavior:

- `E` means "lift this selection into the next pipeline element":
  - source -> extract
  - extract -> sub-extract
- `C` opens cloze creation with the selected text wrapped as `{{c1::selection}}`.
- `Esc` cancels.
- Toolbar clicks must preserve the live ProseMirror selection via the existing
  `onMouseDown.preventDefault` behavior.

### Inline `/process` Sub-Extract Workflow

Inside the process extract workbench:

- Selecting text in the editor opens the extract-mode selection toolbar.
- Clicking `Sub-extract` or pressing `E` calls `appApi.createExtraction` with:
  - `sourceElementId`: original source root from inspector/source lineage
  - `parentId`: current extract id
  - `selectedText`, `blockIds`, `startOffset`, `endOffset`: from `useTextSelection`
- On success:
  - keep the queue cursor on the same parent extract
  - mark the selected blocks as extracted in the editor decorations
  - refresh inspector/right panel context
  - show a toast
  - keep the newly created sub-extract available through lineage/children
- If no source root is available:
  - do not silently fail
  - show a calm error toast
  - keep the selection/workbench stable

Action-bar fallback:

- Add a compact `Sub-extract` button near `Trim`/`Save`.
- If a selection exists, it runs the same command as the toolbar.
- If no selection exists, it tells the user to select text first.

### Inline `/process` Cloze From Selection

Inside the process extract workbench:

- Selecting text and choosing `Cloze`, or pressing `C`, opens the existing `CardBuilder` inline.
- The builder opens on the cloze tab.
- The selected text is pre-wrapped as `{{c1::selected text}}`.
- Creating the cloze card keeps the queue cursor on the extract and refreshes inspector context.

## Implementation Plan

### U1: Review Reference De-Duplication

Files:

- `apps/web/src/components/RefBlock.tsx`
- `apps/web/src/components/RefBlock.test.tsx`
- `apps/web/src/review/ReviewScreen.tsx`
- `apps/web/src/review/ReviewScreen.test.tsx`
- `apps/web/src/pages/queue/ProcessQueue.tsx`
- `apps/web/src/pages/queue/ProcessQueue.test.tsx`

Approach:

- Add an optional `dedupeSnippetAgainst` prop to `RefBlock`.
- Normalize strings by lowercasing, collapsing whitespace, stripping simple punctuation noise.
- Hide only the quote snippet when the normalized snippet and comparison body are identical or one
  substantially contains the other.
- Keep all citation/link/reliability/open-source affordances.
- Pass the revealed card answer as `dedupeSnippetAgainst` from `ReviewScreen` and `ProcessQueue`
  for Q&A cards.

Tests:

- `RefBlock` hides only the quote when the snippet duplicates the comparison text.
- `RefBlock` still shows citation and URL when the quote is hidden.
- `RefBlock` keeps the snippet when it adds different context.
- Review and process card tests assert duplicated snippets are not rendered after reveal.

### U2: Configurable Selection Toolbar

Files:

- `apps/web/src/reader/SelectionToolbar.tsx`
- `apps/web/src/pages/source/SourceReader.tsx`
- `apps/web/src/pages/source/SourceReader.test.tsx`
- `apps/web/src/reader/ExtractView.tsx`
- Extract-view tests if present; add focused tests if absent.

Approach:

- Replace hard-coded toolbar buttons with an `actions` prop.
- Preserve current source-reader action set by default or by explicit source config.
- Use extract config in `ExtractView`: `Sub-extract`, `Cloze`, `Copy`, cancel.
- Keep keyboard labels accurate.
- Remove visible `Highlight` from extract surfaces until implemented.

Tests:

- Source reader still shows and dispatches Highlight.
- Extract view toolbar shows Sub-extract/Cloze/Copy and not Highlight.
- `E` still dispatches extraction/sub-extraction in each context.
- `C` still opens cloze builder in extract context.

### U3: Inline Process Selection State

Files:

- `apps/web/src/pages/queue/ProcessQueue.tsx`
- `apps/web/src/pages/queue/process-queue.css`
- `apps/web/src/pages/queue/ProcessQueue.test.tsx`

Approach:

- Track the live extract editor instance in state as already done.
- Add `editorReady` state for `useTextSelection`.
- Reuse `useTextSelection(extractEditor, editorReady)` when current item is an extract.
- Render `SelectionToolbar` near the process workbench with extract-mode actions.
- Wire keyboard `E`/`C` while the toolbar is open using the same capture-phase pattern as
  `ExtractView`.
- Avoid conflicts with process-level shortcuts:
  - when the selection toolbar is open, `E`/`C` are selection actions
  - existing queue keys still apply outside text-selection mode
  - `d`, `p`, `x`, `o`, `n` keep their queue meanings

Tests:

- Selecting text causes the toolbar to render in process extract context.
- Toolbar exposes `Sub-extract`, `Cloze`, and `Copy`, not `Highlight`.
- Keyboard `E`/`C` dispatch the same actions when the toolbar is open.

### U4: Inline Process Sub-Extract Creation

Files:

- `apps/web/src/pages/queue/ProcessQueue.tsx`
- `apps/web/src/pages/queue/ProcessQueue.test.tsx`
- `tests/electron/process-queue.spec.ts`

Approach:

- Implement `onProcessSubExtract` mirroring `ExtractView.onSubExtract`.
- Use inspector source as the original root source id.
- Call existing `appApi.createExtraction` with `parentId` = current extract id.
- Optimistically mark extracted blocks through `doc.markExtracted`.
- Refresh inspector and shared inspector panel.
- Keep cursor stable.

Tests:

- Unit: `createExtraction` is called with source root id, parent extract id, selected text, block
  ids, and offsets.
- Unit: no queue `act` call and no navigation.
- E2E: create a sub-extract from selected text inside `/process`, restart the app, verify the child
  extract remains under the parent and lineage/source root are preserved.

### U5: Inline Process Cloze From Selection

Files:

- `apps/web/src/pages/queue/ProcessQueue.tsx`
- `apps/web/src/pages/queue/ProcessQueue.test.tsx`
- `tests/electron/process-queue.spec.ts`

Approach:

- Implement `onProcessSelectionAction("cloze")`.
- Open existing inline `CardBuilder` with:
  - `tab: "cloze"`
  - `clozeText: "{{c1::selected text}}"`
- Keep the cursor stable after card creation and refresh inspector context.

Tests:

- Unit: selecting text and choosing Cloze opens the builder on cloze tab with wrapped text.
- Unit: creating that card calls `cards.create` as cloze.
- E2E: create a cloze card from selected text inside `/process`, restart, verify child card exists.

### U6: Visual And Regression Verification

Files:

- No production files unless visual checks reveal layout issues.

Approach:

- Capture `/process` with:
  - extract workbench, no selection
  - extract workbench with selection toolbar open
  - extract workbench with cloze builder open
  - constrained desktop width
- Capture card review/process card after reveal where answer equals source snippet.
- Confirm:
  - no duplicated text block
  - toolbar does not overlap selected text badly
  - action rows wrap cleanly
  - card builder stays within the process surface

Verification commands:

- `pnpm exec biome check <changed files>`
- `pnpm --filter @interleave/web test -- ProcessQueue.test.tsx`
- relevant `ReviewScreen` / `RefBlock` / `SourceReader` tests
- `pnpm typecheck`
- `pnpm test`
- `pnpm e2e tests/electron/process-queue.spec.ts`
- visual Electron screenshots inspected manually

## Risks And Decisions

- **Selection toolbar conflict with queue shortcuts:** Use toolbar-open state to let `E`/`C` win
  only while a selection exists. Avoid stealing process-session shortcuts outside selection mode.
- **Source root missing:** Sub-extract creation depends on the root source id. If inspector cannot
  resolve it, the UI should explain failure rather than create a malformed child.
- **No extract highlights yet:** Do not expose a dead Highlight button. Hiding it is more honest than
  showing a familiar action that silently does nothing.
- **Reference de-duplication must not hide evidence entirely:** Only hide the quote text. The
  citation, URL, reliability, location, and open-source affordance remain.
- **Inline vs full workspace:** The queue should support the most frequent actions. Deep lineage
  inspection, broader source context, and complex repair still belong in `/extract/$id`.

## Completion Criteria

- Card review/process no longer repeats identical answer/evidence text.
- Inline `/process` extract selection can create sub-extracts and cloze cards without navigation.
- Full extract selection toolbar no longer presents unsupported Highlight behavior.
- Sub-extracts created from `/process` persist after app restart and keep correct lineage.
- Existing queue actions, card review, and extract edit/save flows still pass.
- Visual checks show a dense, professional, non-overlapping workflow at desktop and constrained
  desktop widths.

## Completed Implementation

- Added `RefBlock.dedupeSnippetAgainst` and wired it into full review plus inline process review for
  Q&A cards.
- Made `SelectionToolbar` configurable, with source-reader actions preserved by default and
  extract-mode actions set to `Sub-extract`, `Cloze`, and `Copy`.
- Updated full extract view to stop showing the unsupported Highlight action for extract-body
  selections.
- Added inline `/process` extract selection state, keyboard handling, sub-extract creation, cloze
  builder seeding, extracted-block decoration refresh, and stable cursor behavior.
- Fixed the process editor lifecycle so saving/patching the current extract does not detach the
  live editor instance from selection handling.

## Verification

- `pnpm --filter @interleave/web test -- ProcessQueue.test.tsx RefBlock.test.tsx ReviewScreen.test.tsx SelectionToolbar.test.tsx ExtractView.test.tsx`:
  5 files, 83 tests passed.
- `pnpm --filter @interleave/web test -- ProcessQueue.test.tsx SelectionToolbar.test.tsx`: 2 files,
  34 tests passed after formatting.
- `pnpm typecheck`: passed.
- `pnpm test`: 348 files, 2702 tests passed.
- `pnpm e2e tests/electron/process-queue.spec.ts`: 8 Electron tests passed, including inline
  selection -> sub-extract and restart persistence.
- `pnpm exec biome check <changed files>`: passed.
- `pnpm lint`: exited 0; unrelated pre-existing warnings remain in maintenance/dedup/lineage tests.
- Visual Electron screenshots inspected:
  - `/private/tmp/interleave-process-extract-selection.png`
  - `/private/tmp/interleave-process-card-dedupe.png`
