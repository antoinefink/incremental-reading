---
title: Fix Reader Scroll and Rich Source Display
type: fix
status: completed
date: 2026-06-08
---

# Fix Reader Scroll and Rich Source Display

## Summary

Fix the source reading surfaces so the reader uses one vertical scroll container, can reach both the first and last body content, gives source quotes a little more breathing room, and renders rich source content with the existing constrained ProseMirror renderer.

## Problem Frame

The source reader nests its own `.reader-page` scroller inside the shell route scroller. That makes scroll position ownership ambiguous and can trap the view away from the true top. The article/source quote in lineage surfaces is visually tight against the text above it. Rich source bodies are already stored and rendered by the editor path, but the UI needs to consistently use that path and style rich article nodes such as images.

## Requirements

- R1. Source reader routes must use a single vertical scroller for the article body so the user can scroll fully to the top.
- R2. The source reader must retain enough bottom scroll padding for the final article content to clear surrounding chrome.
- R3. The full source quote shown in lineage/context surfaces must have a modest top gap from the label or source text above it.
- R4. Source body previews and reader bodies must render valid ProseMirror JSON through `SourceEditor`, preserving paragraphs, bold/strong marks, blockquotes, and article images.
- R5. Rich source image nodes must be visually constrained inside the reading column without exposing raw filesystem paths or remote URLs.
- R6. The fix must stay in renderer/editor presentation code and preserve the typed IPC boundary.

## Key Technical Decisions

- **Single reader scroller:** Disable the outer `.shell-page` scroller when it contains the source-reader route marker, keeping `.reader-page` as the only vertical body scroller. This is the narrowest change because source reader layout already owns header/action bars and bottom padding.
- **Keep read-point resume behavior:** Do not remove the intentional `jumpToReadPoint` call. The bug is about unreachable scroll extents, not the existing product behavior of reopening near the saved read-point.
- **Use the existing rich renderer:** Keep the inbox preview and reader on `SourceEditor` for valid ProseMirror docs rather than adding HTML rendering or unsafe `dangerouslySetInnerHTML`.
- **Style article images in reader CSS:** Images are constrained by CSS on the `.reader` surface so all rich-reader usages benefit without changing the document schema or IPC contract.
- **Quote spacing is contextual:** Add the quote gap on the lineage/context quote blocks, not as broad global spacing that would inflate unrelated compact UI.

## Implementation Units

### U1. Reader Scroll Ownership

- **Goal:** Ensure the source reader has one vertical scroll owner and can reach both scroll extremes.
- **Files:** Modify `apps/web/src/shell/shell.css`; extend `apps/web/src/shell/shell-css.test.ts` or `apps/web/src/pages/source/reader-css.test.ts`.
- **Patterns:** Follow the existing CSS contract tests in `apps/web/src/pages/source/reader-css.test.ts` and `apps/web/src/shell/shell-css.test.ts`.
- **Test Scenarios:** Shell page hides overflow when a source-reader screen is present; reader page remains the vertical scroller; reader rail keeps bottom padding.
- **Verification:** Focused web CSS tests plus Electron source-reader scroll checks.

### U2. Rich Reader Styling

- **Goal:** Make rich article body content visibly correct in source reader and inbox preview bodies.
- **Files:** Modify `apps/web/src/pages/source/reader.css`; extend `apps/web/src/reader/SourceEditorRichRender.test.tsx` and `apps/web/src/pages/source/reader-css.test.ts`.
- **Patterns:** Reuse `SourceEditor` and the existing article-image node path from `packages/editor/src/nodes/article-image.ts`.
- **Test Scenarios:** A valid rich doc renders bold text and a local article image; reader CSS constrains images to the reading column and preserves paragraph/list/blockquote styling.
- **Verification:** Focused web rich-render and CSS tests.

### U3. Quote Spacing

- **Goal:** Give the full source quote a modest top gap without bloating compact metadata sections.
- **Files:** Modify `apps/web/src/components/inspector/inspector.css`, `apps/web/src/components/ref-block.css` or context-specific extract CSS; extend relevant CSS tests.
- **Patterns:** Follow inspector CSS token usage in `apps/web/src/components/inspector/inspector.css` and `RefBlock` presentation in `apps/web/src/components/RefBlock.tsx`.
- **Test Scenarios:** Source lineage quote has `margin-top`; extract/source context refblock receives a small top gap when following its section label.
- **Verification:** Focused inspector/refblock CSS tests.

## Scope Boundaries

- Do not change source-location, document, or asset schemas.
- Do not add renderer access to raw HTML, filesystem paths, SQLite, or generic IPC.
- Do not remove read-point resume or jump-to-source behavior.
- Do not widen quote snippets into rich editable documents; source body richness belongs to the body renderer.

## Risks & Dependencies

- `:has(.source-reader-screen)` is supported by the Electron Chromium runtime, but the selector should stay route-scoped and covered by CSS tests.
- Hiding the shell route scroller for reader routes must not affect non-reader pages.
- The renderer can only display rich content that was imported or stored as valid constrained ProseMirror JSON; malformed docs still correctly fall back to plain text in inbox preview.

## Sources

- `apps/web/src/pages/source/SourceReader.tsx` owns the source reader layout and renders `SourceEditor`.
- `apps/web/src/pages/source/reader.css` defines `.reader-page`, `.reader-rail`, and rich reader body styles.
- `apps/web/src/shell/shell.css` defines the outer `.shell-page` scroller.
- `apps/web/src/pages/inbox/InboxScreen.tsx` already renders valid inbox `bodyDoc` values through `SourceEditor`.
- `packages/editor/src/SourceEditor.tsx` is the constrained rich ProseMirror renderer.
- `packages/importers/src/html-to-prosemirror.ts` and `apps/desktop/src/main/url-import-service.ts` already convert sanitized HTML imports to rich ProseMirror JSON.
