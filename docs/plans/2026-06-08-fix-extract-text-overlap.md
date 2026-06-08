---
title: Fix extract text overlap
status: active
created: 2026-06-08
origin: user bug report with screenshot
execution: code
---

# Fix Extract Text Overlap

## Problem

Long extract prose can visually collide with the bottom distillation controls in the extract processing surface. The screenshot shows body text overlapping the action row, word-count/status copy, and AI assistance disabled text. This breaks the desktop-first reading workflow because controls and prose become hard to scan and click.

## Scope

Fix the extract distillation layout only. Do not change persistence, scheduling, extraction lineage, card creation, AI behavior, or global reader typography.

## Requirements

- Long extract body text must never overlap the editor footer, action buttons, or AI assistance copy.
- The reading body should keep the existing `.reader` measure and serif typography.
- The fix must be scoped to extract distillation surfaces, not global `.reader-actions` or source-reader behavior.
- Buttons may wrap at narrower widths, but wrapping must reserve layout space instead of covering prose.
- Avoid absolute, fixed, or sticky bottom overlays for this fix.

## Implementation Units

### U1: Contain Standalone Extract Editor Layout

Files:

- Modify: `apps/web/src/reader/extract-view.css`
- Test: `apps/web/src/reader/ExtractView.test.tsx`

Approach:

- Make `.extract-distill` and `.extract-editor` explicit flex columns with `min-height: 0`.
- Make the editor panel contain its `.reader` child so prose scrolls inside the editor region when needed.
- Keep `.extract-editor__meta`, `.extract-actions`, and `.ai-assist` in normal flow with stable spacing.

Test scenarios:

- The extract editor renders as a flex column.
- The `.reader` inside the extract editor is scrollable and bounded.
- The meta row remains after the editor content and before action buttons.
- AI assistance remains after the action row.

### U2: Contain Process Queue Extract Workbench

Files:

- Modify: `apps/web/src/pages/queue/process-queue.css`
- Test: `apps/web/src/pages/queue/ProcessQueue.test.tsx`

Approach:

- Preserve the process card layout while making `.pq-extract__editor` a bounded flex editor panel.
- Ensure `.pq-extract__editor .reader` owns vertical overflow and cannot paint under `.pq-extract__meta` or `.pq-extract__tools`.
- Add bottom spacing within the scrollable reader region so the last line is not tight against the editor footer.

Test scenarios:

- The inline extract workbench renders editor, meta row, and tool row in the intended order.
- The process extract editor CSS establishes a scroll-contained reader region.
- The process extract tool row remains a normal-flow sibling below the editor.

## Verification

- Run targeted Vitest coverage for `ExtractView` and `ProcessQueue`.
- Run `pnpm typecheck`.
- Run `pnpm test` if feasible.
- For visual confidence, run the renderer or Electron app and inspect the extract process surface at a constrained desktop viewport when feasible.
