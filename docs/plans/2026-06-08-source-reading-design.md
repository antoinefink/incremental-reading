---
title: Source Reading Design Alignment
date: 2026-06-08
status: completed
origin: /private/tmp/interleave-source-design-bundle/interleave-3/project/Improved Source Reading.html
execution: code
---

# Source Reading Design Alignment

## Problem

The process-queue source reading surface still looks like a compact session card: it repeats the
source title inside the body, keeps progress in a cramped top strip, and makes the page feel unlike
the library source reader. The fetched Claude Design bundle asks for that source-reading surface to
match the library reader more closely, without adding features.

## Scope

Implement the design for the inline source workbench in `apps/web/src/pages/queue/ProcessQueue.tsx`.
Use the standalone source reader in `apps/web/src/pages/source/SourceReader.tsx` and the design
bundle as the visual reference. Preserve session chrome and all existing actions.

Out of scope:

- New extraction, scheduling, IPC, persistence, or keyboard behavior.
- Removing `/source/$id` breadcrumbs, filters, processed-span controls, or workflow actions.
- Adding library-only features to the process-loop reader.

## Implementation Unit

### U1: Align Process Source Workbench

Files:

- Modify: `apps/web/src/pages/queue/ProcessQueue.tsx`
- Modify: `apps/web/src/pages/queue/process-queue.css`
- Modify: `apps/web/src/pages/queue/ProcessQueue.test.tsx`
- Modify: `apps/web/src/pages/queue/process-queue-css.test.ts`

Approach:

- Replace the inline source workbench's top strip with a library-style header stack:
  title, metarow, and a compact read-point action.
- Move read progress into a centered rail above the editor body, with a full-width progress bar
  constrained to `--reader-text-measure`.
- Keep the process session header and bottom action bar unchanged.
- Keep the same read-point button, editor, selection toolbar, read-point decorations, and tests IDs
  where possible.

Test scenarios:

- Rendering a source item shows one workbench title and keeps the read-point action available.
- Progress label and bar still reflect read-point progress, now in the rail.
- CSS keeps the source workbench full-height and unframed, with the progress bar no longer capped
  to the old narrow width.
- Existing process-loop action tests still pass.

Verification:

- `pnpm vitest apps/web/src/pages/queue/ProcessQueue.test.tsx apps/web/src/pages/queue/process-queue-css.test.ts`
- `pnpm typecheck`
- `pnpm test`
