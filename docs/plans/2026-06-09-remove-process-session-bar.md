---
title: Remove Process Session Bar
status: completed
date: 2026-06-09
origin: user request
execution: code
---

# Remove Process Session Bar

## Problem

The `/process` route still dedicates a full-width horizontal header bar to session
progress, mode steering, and the end-session action. Recent source-reader work has
made the process source workbench more immersive, so this extra bar reads as
competing chrome above the actual work.

## Scope

- Remove the dedicated `.pq-head` top bar from `/process`.
- Preserve the useful controls: end session, processed/remaining progress, progress
  fill, and mode switching.
- Keep existing process keyboard shortcuts and queue actions unchanged.
- Do not change queue ordering, scheduling, source reading, extract distillation,
  card review behavior, or desktop IPC contracts.

## Implementation Unit

### U1: Inline Process Session Controls

Files:
- Modify: `apps/web/src/pages/queue/ProcessQueue.tsx`
- Modify: `apps/web/src/pages/queue/process-queue.css`
- Modify: `apps/web/src/pages/queue/ProcessQueue.test.tsx`
- Modify: `apps/web/src/pages/queue/process-queue-css.test.ts`

Approach:
- Extract the existing end/progress/mode markup into a small process controls
  component that can render inside normal route content instead of as a full-width
  header bar.
- Render those controls above loading/done states and inside `ProcessCard` for live
  items so source mode remains unframed and no separate top bar is reserved.
- Restyle the controls as compact inline chrome with token-driven spacing; remove
  `.pq-head` as a layout/header surface.
- Keep `useProcessShortcuts` and all mutation callbacks unchanged.

Test Scenarios:
- `/process` no longer renders a `process-header`/`.pq-head` container.
- The progress readout and progress fill still render and update from cursor/total.
- Mode buttons still call the existing mode-change path.
- End session still navigates back to `/queue` with `asOf` preserved.
- Source workbench tests continue to prove the reader rail owns only the read-point
  progress bar and that no persistent extraction CTA returns.

Verification:
- `pnpm --filter @interleave/web test -- ProcessQueue process-queue-css`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- Relevant Electron e2e if local Electron startup is available.

## Risks

- Moving the controls into live item chrome could make source/extract layouts
  shorter if spacing is too heavy. Keep the controls compact and outside the
  source reader rail.
- Tests currently target `process-progress` directly; preserve the test id and
  behavior so this remains a layout-only change.
