---
title: "Process Queue Source Reader Unframed Workbench"
date: "2026-06-08"
category: "docs/solutions/ui-bugs/"
module: "apps/web process queue source reader"
problem_type: "ui_bug"
component: "frontend_stimulus"
symptoms:
  - "The process queue source reader was visually framed like a card instead of reading as a full-height workbench."
  - "A persistent Extract selection button stayed visible even when no active text selection was present."
  - "Static extraction hint text competed with the selection-toolbar extraction flow."
  - "Removing the persistent action still needed to preserve extraction through the contextual selection toolbar."
root_cause: "scope_issue"
resolution_type: "code_fix"
severity: "medium"
related_components:
  - "apps/web/src/pages/queue/ProcessQueue.tsx"
  - "apps/web/src/pages/queue/process-queue.css"
  - "apps/web/src/pages/queue/ProcessQueue.test.tsx"
  - "apps/web/src/pages/queue/process-queue-css.test.ts"
tags:
  - "process-queue"
  - "source-reader"
  - "reading-workbench"
  - "selection-toolbar"
  - "extract-selection"
  - "reader-chrome"
  - "desktop-ui"
---

# Process Queue Source Reader Unframed Workbench

## Problem

The `/process` source-reading item used the generic process card frame even though the user was reading a source, not inspecting a repeated card. It also showed a persistent `Extract selection` button and the hint `Select text to extract, highlight, or copy.` under the editor.

That made the reading surface feel like a framed instructional panel instead of a calm full-height reading workbench.

## Symptoms

- Source items in `/process` inherited the bordered `.pq-card` treatment.
- The embedded source editor also had its own border, radius, and `max-height` cap.
- The persistent `Extract selection` button duplicated the contextual selection toolbar.
- The static hint was visible even when the user had no active text selection.

## What Didn't Work

- Removing shared `.pq-card--workbench` styling would have affected extract workbenches, which still need framed panels and separate card-builder behavior.
- Removing PDF extraction controls would have changed a different surface: PDF region extraction has its own page/region controls and did not contain the requested hint.
- Removing extraction entirely would break the source-processing loop. The right fix is to remove the persistent CTA while keeping selection-toolbar extraction.
- Changing standalone `/source/$id` reader header borders was too broad; that also touched PDF and media reader routes outside the process source workbench.

## Solution

Add source-specific layout state in `ProcessQueue` instead of changing shared workbench classes:

```tsx
const isRenderingSource = !deckLoading && !done && current?.type === "source";
const centerClassName = `pq-center${isRenderingExtract ? " pq-center--extract" : ""}${isRenderingSource ? " pq-center--source" : ""}`;
```

Give source items their own card modifier:

```tsx
className={`pq-card fade-up${isWorkbench ? " pq-card--workbench" : ""}${isSource ? " pq-card--source" : ""}${isExtract ? " pq-card--extract" : ""}`}
```

Then make only that source modifier full-height and unframed:

```css
.pq-center--source {
  align-items: stretch;
  justify-content: flex-start;
  overflow: hidden;
  padding: 0;
}

.pq-card--source {
  flex: 1 1 0;
  min-height: 0;
  height: 100%;
  max-width: none;
  border: 0;
  border-radius: 0;
  background: transparent;
}

.pq-source,
.pq-source__editor {
  flex: 1 1 auto;
  min-height: 0;
}
```

Remove the persistent source extraction tools block:

```tsx
<SelectionToolbar
  position={selectionPosition}
  actions={PROCESS_SOURCE_SELECTION_ACTIONS}
  onAction={onSelectionAction}
/>
```

The selection toolbar remains the owner of extraction, highlight, and copy actions once text is selected.

## Why This Works

The fix creates a source-specific height chain:

```txt
process center -> source card modifier -> source workbench -> source editor -> reader
```

The source reader can now occupy the available process work area without card borders or nested editor framing. Extract cards keep their existing `.pq-card--extract` behavior because source layout is isolated behind `.pq-center--source` and `.pq-card--source`.

Removing the persistent CTA also clarifies action ownership. Extraction is selection-driven; the visible affordance appears only when text is selected, so it stays tied to an exact source span and preserves the lineage mental model.

## Prevention

- Use explicit item-type layout modifiers for process queue items with materially different surfaces.
- Do not change shared `.pq-card--workbench` rules when the intended change is source-only.
- Keep extraction actions contextual to `SelectionToolbar` unless there is a separate source type that genuinely needs persistent region controls.
- When changing reader chrome, check PDF/media/source route branches for unintended shared-selector fallout.
- Pair class-level tests with live visual verification for border/full-height requests; text presence alone does not prove geometry.

Regression coverage added:

- Component test asserts source process items get `pq-center--source` and `pq-card--source`.
- Component test asserts the persistent `process-source-extract` button and hint text are absent.
- Existing selection-toolbar tests continue to assert source extraction/highlight/copy actions are present when text is selected.
- CSS contract test asserts source process cards and editors are full-height, unframed, and uncapped.
- Live renderer visual verification measured zero borders, transparent background, full work-area height, and absence of the removed CTA/hint.

## Related Issues

- [Process Queue extract cards should use available height without vertical centering](./process-queue-extract-card-height-alignment.md) covers the adjacent extract-card height chain in `/process`.
- [Source Reader Taller Middle Area](./source-reader-taller-middle-area.md) covers standalone source-reader vertical chrome compaction.
- [Source Reader Scroll Extents and Rich Source Rendering](./source-reader-scroll-extents-rich-source-rendering.md) covers the source-reader scroll-owner contract.
- [Large selection toolbar must anchor to visible viewport geometry](./large-selection-toolbar-visible-viewport-anchoring.md) is the selection-toolbar guardrail that remains load-bearing after persistent extraction UI is removed.
- [Rich extracts must rebuild from source document structure](../logic-errors/rich-extractions-preserve-paragraphs-and-images.md) is the lineage/content guardrail: UI extraction affordance changes must not weaken source-location anchors or rich extract reconstruction.
