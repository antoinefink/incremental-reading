---
title: "Source Reader Scroll Extents and Rich Source Rendering"
date: "2026-06-08"
category: "docs/solutions/ui-bugs/"
module: "apps/web source reader"
problem_type: "ui_bug"
component: "frontend_stimulus"
symptoms:
  - "Source reader could not reliably scroll fully back to the first article content."
  - "Reader scroll ownership was ambiguous between the shell route scroller and the article body scroller."
  - "Bottom reachability needed explicit regression coverage so final article content remained reachable above surrounding chrome."
  - "Imported rich source bodies needed verified paragraph, bold text, and local article image rendering."
  - "Source quote blocks in lineage/context surfaces felt visually cramped against preceding text."
root_cause: "scope_issue"
resolution_type: "code_fix"
severity: "medium"
related_components:
  - "apps/web shell layout"
  - "apps/web reader CSS"
  - "apps/web inspector and RefBlock source quotes"
  - "Electron source reader E2E"
tags:
  - "source-reader"
  - "scroll"
  - "rich-source"
  - "prosemirror"
  - "article-images"
  - "css-layout"
---

# Source Reader Scroll Extents and Rich Source Rendering

## Problem

Source reader routes had ambiguous vertical scroll ownership: the shell route scroller and the article body scroller could both participate. That made it possible for the reader to fail reaching the true first article content, while the same surface also needed clearer rich article rendering and a modest source-quote spacing fix.

## Symptoms

- The reader could get stuck away from the first paragraph instead of reaching the true top of the article body.
- Bottom reachability was not explicitly covered, so a fix for the top could still leave final content hidden behind surrounding chrome.
- Full source quotes in lineage/context surfaces felt visually cramped against the text above them.
- Imported rich HTML needed reader-route coverage proving paragraphs, bold text, and local article images survived into the source body.

## What Didn't Work

- Changing read-point resume behavior is the wrong target. Resuming near a saved read-point is intentional; the visual bug was that scroll ownership made the article body's extents unreliable.
- Rendering imported HTML directly would solve the wrong problem and weaken the security boundary. Rich source bodies should continue through the constrained ProseMirror `SourceEditor` path, with local `article-image://` URLs for article images.
- A broad shell selector such as `.shell-page:has(.reader-screen)` is too coupled to shared reader chrome because extract views also use `reader-screen`.

## Solution

Scope shell scroll suppression to a source-reader route marker, and keep the article body as the only vertical scroller:

```css
.shell-page:has(.source-reader-screen) {
  overflow-y: hidden;
}
```

Every `SourceReader` route branch gets the source-specific marker:

```tsx
<div className="reader-screen source-reader-screen" data-testid="route-source">
```

The reader body keeps ownership of vertical movement:

```css
.reader-page {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}

.reader-rail {
  --reader-bottom-breathing-room: calc(var(--s-8) * 5);
  padding: var(--s-7) 0 var(--reader-bottom-breathing-room);
}
```

Rich article images are constrained inside the reading column on the same paragraph rhythm:

```css
.reader img {
  display: block;
  max-width: 100%;
  max-height: min(72vh, 720px);
  height: auto;
  margin: 0 auto var(--s-5);
  object-fit: contain;
  border-radius: var(--r-md);
}
```

The quote gap stays contextual and modest:

```css
.insp-quote {
  margin: var(--s-2, 6px) 0 0;
}

.refblock__quote {
  display: block;
  margin-top: var(--s-2, 6px);
}
```

## Why This Works

The source reader now has one scroll owner. The shell can no longer preserve or steal a route scroll position for source-reader routes, while `.reader-page` remains the article body scroller. The source-specific marker keeps the override from leaking into extract views or future surfaces that reuse reader chrome.

The bottom breathing room stays with the article rail, so the last paragraph can be scrolled into the visible reader viewport. Electron coverage should assert bounding rectangles for the first and last content nodes, not just DOM text presence, because offscreen text can still exist in the ProseMirror document.

Rich source rendering remains on the existing constrained renderer. Paragraphs and marks come from stored ProseMirror JSON, and article images render from local `article-image://<source>/<asset>` references rather than remote URLs or filesystem paths.

## Prevention

- Keep CSS contract tests for scroll ownership and reader body scroller declarations.
- Keep Electron reachability coverage that programmatically scrolls to both extremes and asserts the first and last article blocks are inside `.reader-page`'s visible rectangle.
- Keep rich import E2E coverage that opens the source reader after importing loopback HTML with multiple paragraphs, a bold mark, and an image; assert `article-image://` image URLs and reject `http:`, `file:`, and `data:` sources.
- Keep editor-level rich-render coverage for paragraph/block order, bold marks, and image nodes so regressions in `SourceEditor` are caught before route-level tests.
- Keep quote spacing tokenized and contextual to source quote surfaces instead of adding broad typography margins that inflate compact metadata UI.

## Related Issues

- [rich-extractions-preserve-paragraphs-and-images](../logic-errors/rich-extractions-preserve-paragraphs-and-images.md) covers preserving rich content when creating extracts, a related but distinct reconstruction problem.
- [url-imported-articles-inbox-processing](url-imported-articles-inbox-processing.md) covers routing and formatted preview behavior for imported article sources.
- [url-import-article-images-asset-vault-protocol](../architecture-patterns/url-import-article-images-asset-vault-protocol.md) covers article image import, vault storage, and `article-image://` delivery.
