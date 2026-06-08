---
title: "Process Queue extract cards should use available height without vertical centering"
date: "2026-06-08"
category: "docs/solutions/ui-bugs/"
module: "apps/web process queue extract workbench"
problem_type: "ui_bug"
component: "frontend_stimulus"
symptoms:
  - "Process Queue extract cards were vertically centered instead of starting at the top of the work area."
  - "The extract editor stayed artificially short and left usable vertical space unused."
  - "Source and extract workbench width styling was coupled to extract-only height behavior."
  - "Tall extract prose risked competing scroll containers instead of letting the reader own scrolling."
root_cause: "logic_error"
resolution_type: "code_fix"
severity: "medium"
related_components:
  - "apps/web/src/pages/queue/ProcessQueue.tsx"
  - "apps/web/src/pages/queue/process-queue.css"
  - "apps/web/src/pages/queue/ProcessQueue.test.tsx"
  - "tests/electron/process-editor-focus.spec.ts"
tags:
  - "process-queue"
  - "extract-card"
  - "workbench"
  - "css-layout"
  - "flex-height"
  - "scroll-ownership"
  - "electron-geometry"
  - "regression-test"
---

# Process Queue Extract Cards Should Use Available Height Without Vertical Centering

## Problem

The Process Queue extract workbench rendered as a centered, content-height card with a short capped editor. Long extracts left large unused vertical space in the middle pane, while the prose body hid most content behind a small internal scroll area.

The required behavior was for extract cards in Process Queue to fill the available vertical work area, keep only the reader/prose region scrollable, and leave bottom action rows visible.

## Symptoms

- `/process` extract items appeared vertically centered instead of starting at the top of the available work area.
- `.pq-extract__editor` stayed artificially short because it had calculated min/max sizing and a `46vh` cap.
- `.pq-card--extract` did not claim the process center height, so long extract prose scrolled in a small editor even when the middle pane had room.
- The shared process action rows had to remain reachable below the editor rather than becoming part of the prose scroll area.

## What Didn't Work

- Treating source and extract workbench cards the same with one `.pq-card--extract` class was too broad. Source workbenches need the wider workbench width, but extract workbenches also need full-height flex behavior.
- Relying on the default `.pq-center` behavior kept extract cards centered via `justify-content: center`, which fought the desired full-height layout.
- Capping `.pq-extract__editor` with calculated min/max heights and `46vh` made the reader short regardless of available vertical space.
- Making the whole card or center scroll would keep content reachable, but would regress the scroll-ownership contract documented in [extract-distillation-scroll-contained-editor.md](extract-distillation-scroll-contained-editor.md): fixed controls stay outside the prose scroller.

## Solution

Add an explicit extract-rendering state for the process center. Gate it on the rendered state, not only the stale cursor, so loading and done panels keep their centered presentation during reloads:

```tsx
const isRenderingExtract = !deckLoading && !done && current?.type === "extract";
const centerClassName = isRenderingExtract ? "pq-center pq-center--extract" : "pq-center";
```

Split generic workbench width from extract-only height:

```tsx
const isWorkbench = isExtract || isSource;

className={`pq-card fade-up${isWorkbench ? " pq-card--workbench" : ""}${isExtract ? " pq-card--extract" : ""}${extractBuilder ? " pq-card--builder" : ""}`}
```

Make the extract card a bounded flex frame, then let the extract workbench and editor fill it:

```css
.pq-center--extract {
  justify-content: flex-start;
  overflow: hidden;
}

.pq-card--workbench {
  max-width: 820px;
  gap: var(--s-4);
  min-height: 0;
}

.pq-card--extract {
  box-sizing: border-box;
  flex: 1 1 0;
  min-height: 0;
  height: auto;
  max-height: 100%;
  overflow: hidden;
}

.pq-card--extract .pq-extract {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}

.pq-extract__editor {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  max-height: none;
  overflow: hidden;
}

.pq-extract__editor .reader {
  flex: 1 1 auto;
  min-height: 0;
  max-height: none;
  overflow-y: auto;
}
```

Keep footer controls as non-scrolling siblings and add a short-height fallback so wrapped chrome remains reachable on constrained windows:

```css
.pq-extract__ref {
  flex: 0 1 auto;
  max-height: 160px;
  overflow-y: auto;
}

.pq-card--extract .pq-actions,
.pq-card--extract .pq-keys {
  flex: none;
}

@media (max-height: 760px) {
  .pq-center--extract {
    overflow-y: auto;
  }

  .pq-card--extract {
    min-height: min-content;
  }
}
```

## Why This Works

The fix creates one continuous height chain:

```txt
process center -> extract card -> extract workbench -> editor -> reader
```

Each shrinking parent uses flex sizing with `min-height: 0`, so the reader can shrink and scroll instead of forcing ancestors to overflow. The extract center no longer vertically centers the card, so the card can occupy nearly all available work-area height.

Controls stay visible because metadata, tools, actions, and keyboard hints remain normal-flow siblings with fixed flex behavior. Only `.pq-extract__editor .reader` owns unbounded vertical scrolling in normal desktop-height layouts; source lineage can use bounded internal scrolling so a long reference does not push the editor tools out of view.

The short-height media fallback deliberately relaxes the no-outer-scroll preference only when fixed chrome would otherwise become unreachable. Reachability wins over a strict single-scroll-owner rule on constrained windows.

## Prevention

- Use explicit state-derived layout modifiers for materially different process item layouts; avoid inferring major layout from shared width classes.
- For nested vertical app layouts, preserve the full flex chain with `min-height: 0` at every shrinking ancestor.
- Keep fixed controls as siblings of the scroll region, not children of it.
- When using `overflow: hidden` to enforce one scroll owner, add a constrained-height fallback for reachability.
- Add browser/Electron geometry coverage when the user-visible bug is about real viewport height, not just class names.

Regression coverage added:

- Component test verifies extract items get `pq-center--extract` and `pq-card--extract`.
- Component test verifies source workbenches use `pq-card--workbench` but not extract-only classes.
- CSS contract test verifies the old `46vh` cap is gone and the reader remains the only scrollable prose region.
- Component test verifies loading panels stay centered during mode reload even if the stale cursor was an extract.
- Electron test creates a long extract, opens `/process`, scrolls the reader, and asserts the final paragraph and bottom actions remain visible inside the center viewport.

## Related Issues

- [extract-distillation-scroll-contained-editor.md](extract-distillation-scroll-contained-editor.md) is the primary predecessor. It covers the earlier overlap failure where long prose collided with controls; this fix covers the separate height/allocation failure where the bounded card did not use enough available space.
- [source-reader-scroll-extents-rich-source-rendering.md](source-reader-scroll-extents-rich-source-rendering.md) is the broader scroll-owner precedent for route shell vs inner reader scrolling.
- [large-selection-toolbar-visible-viewport-anchoring.md](large-selection-toolbar-visible-viewport-anchoring.md) is the viewport-geometry guardrail: do not compensate for inner scrolling by adding scroll offsets to fixed overlay coordinates.
- [compact-card-quality-check-disclosure.md](../design-patterns/compact-card-quality-check-disclosure.md) is adjacent because expanding the extract editor must not regress embedded card-builder density in Process Queue.
