---
title: Reader Session Metadata And Dividers
status: active
date: 2026-06-09
origin: user screenshot annotation
---

# Reader Session Metadata And Dividers

## Problem Frame

The process-session source reader still shows document progress as rail-local chrome:
the block progress label appears above the article body, and the word count appears
at the bottom of the narrow reader rail. In the screenshot, both should live in the
top source metadata row under the source title. The header and footer separator
lines should read as full-width session dividers, not narrow article-column rules.

## Requirements

- R1. In `apps/web/src/pages/queue/ProcessQueue.tsx`, move the block progress
  counter into the source metadata row beside author, URL, priority, status, and
  scheduler chips.
- R2. Move the source word count into the same metadata row.
- R3. Remove the narrow rail-only progress label and narrow word-count footer from
  the process source reader.
- R4. Keep the source read-point progress bar in the reader rail, because it is a
  visual measure of reading position.
- R5. In `apps/web/src/pages/queue/process-queue.css`, keep the source header
  separator spanning the full available source workbench width.
- R6. Make the bottom action/footer divider span the full available process pane
  width instead of matching the article rail width.

## Scope Boundaries

- Do not change source scheduling, queue actions, extraction behavior, read-point
  persistence, or `window.appApi` contracts.
- Do not redesign the standalone source route unless a shared CSS selector makes
  that necessary.
- Do not alter PDF/video specialized-reader behavior beyond preserving existing
  fallback metadata.

## Existing Patterns

- `apps/web/src/pages/queue/ProcessQueue.tsx` owns the embedded source workbench
  through `ProcessSourceWorkbench`.
- `apps/web/src/pages/queue/process-queue.css` already has source-specific classes
  `.pq-source`, `.pq-source__header`, `.pq-source__metarow`, `.pq-source__rail`,
  `.pq-source__railhead`, and `.pq-source__foot`.
- `apps/web/src/pages/queue/ProcessQueue.test.tsx` verifies the source workbench
  structure and progress label behavior.
- `apps/web/src/pages/queue/process-queue-css.test.ts` is the existing CSS contract
  test for source workbench layout.

## Implementation Units

### U1. Source Metadata Row Counts

- **Goal:** Render block progress and word count as metadata-row items in
  `ProcessSourceWorkbench`.
- **Modify:** `apps/web/src/pages/queue/ProcessQueue.tsx`
- **Test:** `apps/web/src/pages/queue/ProcessQueue.test.tsx`
- **Approach:** Add compact metadata spans with stable test ids for progress and
  word count after the scheduler/format metadata, separated by `SourceMetaDot`.
  Remove the railhead progress label and bottom word-count foot markup for normal
  text sources.
- **Test scenarios:** A source workbench shows `block 1 of 4` and the word count
  inside `process-source-header`; `process-source-rail` contains the progress bar
  but not the moved progress counter; the removed footer is absent.
- **Verification:** Targeted ProcessQueue test passes.

### U2. Full-Width Source Dividers

- **Goal:** Keep source header and bottom action separators full-width across the
  process source workbench.
- **Modify:** `apps/web/src/pages/queue/process-queue.css`
- **Test:** `apps/web/src/pages/queue/process-queue-css.test.ts`
- **Approach:** Preserve `border-bottom` on `.pq-source__header` and add/verify a
  source-specific full-width bottom divider on the process action bar path, not on
  the narrow `.pq-source__rail`.
- **Test scenarios:** CSS contract confirms `.pq-source__header` owns the full-width
  top separator, `.pq-source__rail` is still constrained to
  `--reader-text-measure`, and source-mode bottom divider is owned by the full-width
  process layout rather than `.pq-source__foot`.
- **Verification:** Targeted CSS contract test passes.

## Verification

- `pnpm --filter @interleave/web test -- ProcessQueue process-queue-css`
- `pnpm typecheck`
- `pnpm test`
