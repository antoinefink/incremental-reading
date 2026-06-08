---
title: Source workbench full-height reading polish
status: active
date: 2026-06-08
origin: user request
execution: code
---

# Source workbench full-height reading polish

## Problem

When a source is being read inside the process queue, the reading surface is presented as a bordered workbench card and includes a persistent `Extract selection` button with the hint `Select text to extract, highlight, or copy.` The requested result is a calmer full-height reading surface without that persistent extraction CTA. Extraction should remain available from the inline selection toolbar and keyboard actions.

## Scope

In scope:
- Remove the persistent `Extract selection` button and adjacent hint from the process queue source workbench.
- Make the process queue source workbench fill the available shell work area height and remove its framed card treatment.
- Keep the source editor as the primary scroll region so long sources remain readable without nested page/card chrome.
- Update focused tests and CSS guards for the changed UI contract.
- Visually verify the queue source-reading screen after implementation.

Out of scope:
- Removing the floating text-selection toolbar.
- Removing PDF region extraction controls.
- Changing `/source/$id` source-reader extraction behavior except where shared CSS tests need to protect full-height reader ownership.

## Implementation Units

### U1: Source Workbench Markup

Files:
- Modify: `apps/web/src/pages/queue/ProcessQueue.tsx`
- Modify: `apps/web/src/pages/queue/ProcessQueue.test.tsx`

Approach:
- Delete the persistent `process-source-tools` block containing `process-source-extract` and the `pq-source__hint`.
- Keep `onCreateExtract` wired through selection toolbar actions and keyboard paths.
- Update the source workbench test so it asserts the CTA and hint are absent while the read-point control and editor remain.

Test scenarios:
- A source queue item renders the workbench and editor.
- The persistent extract button and hint are not present.
- Selection toolbar extraction behavior remains covered by existing interaction tests.

Verification:
- `pnpm vitest run apps/web/src/pages/queue/ProcessQueue.test.tsx`

### U2: Full-Height Source Workbench Styling

Files:
- Modify: `apps/web/src/pages/queue/process-queue.css`
- Modify: `apps/web/src/pages/source/reader.css`
- Modify: `apps/web/src/pages/source/reader-css.test.ts`

Approach:
- Add source-specific process queue styles so `.pq-card--source` and `.pq-center--source` fill the available vertical space and drop the bordered card background.
- Let `.pq-source` and `.pq-source__editor` flex to full height, removing the editor border and max-height cap.
- Keep existing extract-card workbench styles unchanged.
- Add CSS assertions that the source workbench is full-height and unframed.
- Add a source-reader CSS guard that `.source-reader-screen .reader-header` removes the internal divider line for the standalone source reading route.

Test scenarios:
- CSS guard confirms the source workbench card has no border/background frame and fills available height.
- CSS guard confirms the source editor has no border and owns vertical overflow.
- CSS guard confirms the standalone source reader header has no bottom border.

Verification:
- `pnpm vitest run apps/web/src/pages/queue/ProcessQueue.test.tsx apps/web/src/pages/source/reader-css.test.ts`
- Browser visual verification at the process queue source-reading screen.

## Risks

- The removed persistent CTA must not remove the actual extraction capability. Existing selection toolbar tests should remain green.
- Full-height CSS should be source-workbench-scoped so extract distillation and card review process screens keep their existing card layout.
