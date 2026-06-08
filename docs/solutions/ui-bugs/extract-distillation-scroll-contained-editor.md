---
title: "Extract distillation prose must scroll inside the editor panel"
date: "2026-06-08"
category: "docs/solutions/ui-bugs/"
module: "apps/web extract distillation layout"
problem_type: "ui_bug"
component: "frontend_stimulus"
severity: "medium"
symptoms:
  - "Long extract prose visually overlapped the word-count footer, action buttons, and AI assistance copy."
  - "The extract/process distillation surfaces let the reading body and controls compete for the same vertical space."
  - "A first fix that hid outer overflow risked clipping controls on short viewports or expanded AI content."
root_cause: "logic_error"
resolution_type: "code_fix"
related_components:
  - "apps/web/src/reader/extract-view.css"
  - "apps/web/src/reader/ExtractView.test.tsx"
  - "apps/web/src/pages/queue/process-queue.css"
  - "apps/web/src/pages/queue/ProcessQueue.test.tsx"
  - "tests/electron/extract-review.spec.ts"
  - "tests/electron/process-editor-focus.spec.ts"
  - "tests/electron/process-queue.spec.ts"
tags:
  - "extract-view"
  - "process-queue"
  - "scroll-containment"
  - "layout-overlap"
  - "reader-css"
  - "ai-assistance"
  - "desktop-ui"
---

# Extract distillation prose must scroll inside the editor panel

## Problem

The extract distillation workspace can contain long serif prose plus fixed workflow controls: word count, "aim for a single idea" guidance, Trim/Split/Card/Postpone/Done actions, and AI assistance. When the prose is not explicitly contained, it can visually collide with those controls near the bottom of the viewport.

The same risk exists in two places: the full `/extract/$id` workspace and the inline extract workbench inside `/process`.

## Symptoms

- Long extract text overlapped the footer/status row and action buttons.
- AI assistance disabled text could visually collide with the extract body.
- The action row remained in normal flow, but the editor content did not clearly own its own scroll boundary.
- A naive outer `overflow: hidden` fix stopped text bleed but could clip actions or AI content on short desktop windows.

## What Didn't Work

- Letting the whole distillation column be the only scroll container makes the editor body, footer, actions, and AI assistance compete as one long flow.
- Hiding overflow on the outer distillation pane is unsafe because footer controls and AI drafts are important workflow UI, not decorative overflow.
- CSS text assertions alone are not enough for a visual overlap bug. They are useful guardrails, but the fix also needs browser or Electron geometry/behavior verification.

## Solution

Make the extract editor card the boundary for long prose, and keep controls outside that scroll area.

In the full extract view, keep the outer distillation column scrollable as an escape hatch:

```css
.extract-distill {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow-y: auto;
}
```

Then make the editor panel a flex column and assign scrolling to its `.reader` child:

```css
.extract-editor {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: calc(var(--s-12) + var(--s-12) + var(--s-12) + var(--s-12));
  min-width: 0;
  overflow: hidden;
}

.extract-editor .reader {
  flex: 1 1 auto;
  width: 100%;
  min-height: 0;
  overflow-y: auto;
}

.extract-editor__meta,
.extract-actions,
.ai-assist {
  flex: none;
}
```

The process queue extract workbench follows the same shape. Bound the process card/editor, make `.pq-extract__editor .reader` scroll, and keep `.pq-extract__meta` plus `.pq-extract__tools` as non-scrolling normal-flow siblings.

## Why This Works

The reading body is the only region that can grow without bound. Giving it a dedicated scroll container means the browser computes a real boundary between prose and controls. The footer/action/AI sections remain separate flex items, so they reserve space instead of being painted over.

Keeping the outer `/extract/$id` distillation pane scrollable preserves access to controls when the viewport is very short or AI drafts become tall. The inner reader scroll solves the normal long-prose case, while the outer scroll remains the fallback for whole-surface overflow.

## Prevention

- For dense editor surfaces, decide which region owns unbounded content and put `overflow-y: auto` there.
- Do not hide overflow on a container that also owns required controls unless another reachable scroll container contains those controls.
- Keep footer/status/action rows as `flex: none` siblings outside the prose scroll area.
- Prefer token-derived dimensions for layout bounds in app CSS.
- Pair jsdom structure/CSS contract tests with at least one browser or Electron verification for visual overlap bugs.

## Related Issues

- [Embedded active card detail in extract workspace](./embedded-active-card-detail-in-extract-workspace.md) - adjacent extract workspace guidance for keeping main-area surfaces contextual and reachable.
- [Compact card quality check disclosure](../design-patterns/compact-card-quality-check-disclosure.md) - related dense authoring-surface guidance for embedded `/extract` and `/process` card-builder UI.
- [Extract inspector single-responsibility layout and scheduler refresh](./extract-inspector-single-responsibility-lineage-scheduler.md) - adjacent extract UI guidance for keeping lineage/scheduler/control responsibilities distinct.
