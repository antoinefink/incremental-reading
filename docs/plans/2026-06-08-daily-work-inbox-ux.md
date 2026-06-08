---
title: "Daily Work Inbox UX"
type: fix
status: completed
date: 2026-06-08
execution: code
---

# Daily Work Inbox UX

## Problem Frame

Fresh imported articles are correctly persisted as inbox `source` elements with
`dueAt: null`. The due queue is also correct: `/queue` and `/process` only show
scheduled work that is due now. The UX problem is that Home and Daily Queue expose
an unconditional "Start session" path into `/process`, so an inbox-only day looks
like a completed day: "Queue clear" and "You processed 0 items."

The product should route the user through the pipeline stage that actually has
work: due queue first, inbox triage second, then resumable unscheduled reading,
and only then a true clear state.

## Scope Boundaries

- Do not auto-schedule fresh imports into today's queue.
- Do not include inbox sources or unscheduled active sources in `queue.list`.
- Preserve the FSRS-vs-attention split: cards remain FSRS-scheduled via
  `review_states.due_at`; sources/extracts remain attention-scheduled via
  `elements.due_at`.
- Keep all queue/inbox/resume predicates main-side or local-db-side; React renders
  typed results and does not duplicate SQL.
- Keep mutations on existing command-shaped paths (`inbox.triage`,
  `queue.schedule`, `queue.act`, `elements.setPriority`) with existing operation-log
  behavior.
- Avoid a broad Inbox redesign. A full one-at-a-time inbox triage loop is deferred
  unless the implementation can add it without expanding the route/model surface.

## Requirements

- R1. Expose a typed daily-work read model with `dueQueueItems`, `inboxSources`,
  optional active-unscheduled source information, and a `recommendedAction`.
- R2. Home's primary action starts `/process` only when due queue work exists.
  Inbox-only days route to Inbox triage instead.
- R3. Queue does not present an empty due queue as a completed session opportunity.
  Inbox-only days expose an inbox triage action.
- R4. `/process` distinguishes zero-load from real completion. When no due items
  load before anything is processed, it shows "No due items today" and next-step
  actions; when a session processed items, it keeps the completion state.
- R5. Reader exit actions for active unscheduled sources are concrete and working:
  schedule return, mark done, lower priority, and delete.
- R6. Tests cover inbox-only, due-work, direct `/process`, reader exit actions,
  and typed IPC contract behavior.

## Key Decisions

- Add a new read model rather than widening `queue.list`. Queue membership stays
  semantically pure and due-only.
- Reuse `QueueRepository.dueCardCount`, `QueueRepository.dueAttentionCount`, and
  `QueueRepository.inboxCount("source")` for the core counts.
- Add active-unscheduled resume as a read-only, best-effort source candidate:
  live `source`, `status = active`, `dueAt IS NULL`, not deleted. Prefer candidates
  with unresolved block-processing work and recent user activity when available.
- Use the daily-work read for core CTA routing. `balance.get` remains an advisory
  imbalance surface and should not become the primary workflow gate.
- Keep Inbox list as the triage destination for this change. The daily entry point
  should not require the user to browse the queue list when queue work is empty.

## Implementation Units

### U1. Daily Work Read Model

Goal: Add a read-only daily workflow snapshot behind typed IPC.

Modify:
- `packages/local-db/src/daily-work-query.ts`
- `packages/local-db/src/index.ts`
- `apps/desktop/src/shared/channels.ts`
- `apps/desktop/src/shared/contract.ts`
- `apps/desktop/src/main/db-service.ts`
- `apps/desktop/src/main/ipc.ts`
- `apps/desktop/src/preload/index.ts`
- `apps/web/src/lib/appApi.ts`

Tests:
- `packages/local-db/src/daily-work-query.test.ts`
- `apps/desktop/src/shared/contract.test.ts`
- `apps/desktop/src/main/db-service.test.ts`
- `apps/desktop/src/preload/index.test.ts`
- `apps/web/src/lib/appApi.test.ts`

Test scenarios:
- due queue work wins over inbox and resume candidates.
- inbox sources win when due queue is empty.
- active unscheduled source wins when due queue and inbox are empty.
- clear is returned only when all counts/candidates are empty.
- request `asOf` is validated and passed through.

### U2. Home And Queue CTA Routing

Goal: Make primary entry actions route to the actionable pipeline stage.

Modify:
- `apps/web/src/pages/home/HomeScreen.tsx`
- `apps/web/src/pages/queue/QueueScreen.tsx`

Tests:
- `apps/web/src/pages/home/HomeScreen.test.tsx`
- `apps/web/src/pages/queue/QueueScreen.test.tsx`

Test scenarios:
- Home starts `/process` when daily work recommends due queue.
- Home routes to `/inbox` and labels the primary action as triage when there is
  inbox-only work.
- Queue empty state with inbox work shows inbox triage, not a misleading session
  start.
- Queue direct due-empty/no-inbox state remains a true clear state.

### U3. Process Zero-Load State

Goal: Separate no-due-work-at-start from completed sessions.

Modify:
- `apps/web/src/pages/queue/ProcessQueue.tsx`
- `apps/web/src/pages/queue/process-queue.css` if needed

Tests:
- `apps/web/src/pages/queue/ProcessQueue.test.tsx`

Test scenarios:
- empty initial load shows "No due items today" and not "processed 0".
- inbox work in the daily summary shows a primary `Triage inbox` action.
- resume candidate in the daily summary shows a primary `Resume source` action.
- a real session that processed items still shows the existing completion copy.

### U4. Reader Exit Actions

Goal: Repair stale/disabled reader controls that matter for active unscheduled sources.

Modify:
- `apps/web/src/pages/source/SourceReader.tsx`
- `apps/web/src/pages/source/reader.css` if needed

Tests:
- `apps/web/src/pages/source/SourceReader.test.tsx`

Test scenarios:
- `Postpone` / schedule return opens the existing schedule menu and calls
  `appApi.scheduleQueueItem`.
- `Lower priority` calls `appApi.setElementPriority({ action: { kind: "lower" } })`.
- `Mark done` keeps the unresolved-block confirmation gate and uses `queue.act`.
- `Delete` remains soft-delete via `queue.act`.

## Verification

- `pnpm test -- --run apps/desktop/src/main/ipc.test.ts apps/web/src/pages/home/HomeScreen.test.tsx apps/web/src/pages/queue/QueueScreen.test.tsx apps/web/src/pages/queue/ProcessQueue.test.tsx apps/web/src/pages/source/SourceReader.test.tsx`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`

## Deferred

- A dedicated one-at-a-time inbox triage route.
- Auto-navigation after queue completion. Completion panels should show next-step
  actions but not move the user without a click.
