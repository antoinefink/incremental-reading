---
title: Fix Balance Warning Empty Queue
type: fix
status: completed
date: 2026-06-07
execution: code
---

# Fix Balance Warning Empty Queue

## Summary

Fix the import/process balance warning so it only routes users to currently actionable work. The weekly import/process ratio still comes from the domain layer, but the warning now knows whether there is anything in the inbox or due queue before showing queue-facing actions.

## Problem Frame

Fresh imports are stored as `source` elements with `status: "inbox"` and `dueAt: null`. The balance banner counts those recent sources as imports, but `/queue` only displays due items with a non-null due date. A new user can therefore see "You're importing faster than you process," click "Open queue," and land on an empty queue even though the app's intended next step is inbox triage.

## Requirements

- R1. Preserve the existing weekly headline counts: sources imported, extracts created, cards created, and reviews due this week.
- R2. Add current actionable counts to the balance snapshot so the renderer can distinguish due queue work from inbox triage work.
- R3. Do not show a queue action when the due queue is empty.
- R4. Keep the returned `imbalanced` / `severity` judgment truthful to the weekly ratio, but do not render the banner when there is no current inbox or due-queue work to act on.
- R5. Keep all balance math and current-work counts behind the Electron/IPC boundary; React only renders the returned snapshot.
- R6. Cover the regression with domain and renderer tests.

## Key Technical Decisions

- **Keep raw import counts unchanged:** `sourcesImported` should still count all recently created source elements so analytics remains a truthful throughput snapshot.
- **Keep analytics and display gating separate:** `AnalyticsService.computeBalance` should return the pure `judgeBalance` result plus live `inboxSources` and `dueQueueItems` counts. The UI banner should render only when the ratio is imbalanced and at least one current action exists.
- **Treat inbox triage and queue processing as separate destinations:** `dueQueueItems > 0` controls the "Open queue" button. `inboxSources > 0` controls the "Triage inbox" button.
- **Mirror `/queue` for `dueQueueItems`:** Count due FSRS cards plus due attention items at `asOf`, using the same exclusions as the queue. Do not use `reviewsDueThisWeek`, because a card due later this week should not make the queue button appear today.
- **No scheduler side effect:** Do not schedule imported or accepted sources as part of this fix. Source activation and attention scheduling remain separate product flows.

## Implementation Units

### U1. Extend Balance Snapshot

- **Goal:** Add `inboxSources` and `dueQueueItems` to the local-db, IPC, and renderer balance result types.
- **Files:** Modify `packages/local-db/src/analytics-query.ts`, `apps/desktop/src/shared/contract.ts`, `apps/desktop/src/main/db-service.ts`, and `apps/web/src/lib/appApi.ts`.
- **Patterns:** Follow the existing `BalanceSummary` / `BalanceGetResult` shape and the queue count methods in `packages/local-db/src/queue-repository.ts`.
- **Test scenarios:** A week with inbox imports and no output warns; a week with active unscheduled imports but no inbox/due queue work still reports the raw imbalance but has zero actionable counts; returned snapshots include the two new counts.
- **Verification:** `packages/local-db/src/balance-query.test.ts` and `apps/desktop/src/main/db-service.test.ts` pass.

### U2. Make Banner Actions Honest

- **Goal:** Render only actions that lead to non-empty work surfaces, and hide the banner when no action exists.
- **Files:** Modify `apps/web/src/components/BalanceBanner.tsx` and `apps/web/src/components/BalanceBanner.test.tsx`.
- **Patterns:** Keep `BalanceBanner` advisory and desktop-only; use the existing router actions and test hooks.
- **Test scenarios:** A snapshot with `dueQueueItems: 0` does not render "Open queue"; a snapshot with `reviewsDueThisWeek > 0` but `dueQueueItems: 0` still hides "Open queue"; a snapshot with inbox work renders "Triage inbox"; a snapshot with no actionable counts renders no banner even when `imbalanced: true`.
- **Verification:** `apps/web/src/components/BalanceBanner.test.tsx` passes.

## Scope Boundaries

- Do not change import creation, inbox triage, or accepted-source scheduling behavior.
- Do not expose raw queue or inbox reads to the renderer beyond the typed balance snapshot.
- Do not add migrations; this is a read aggregation and renderer behavior fix.

## Sources / Research

- `apps/web/src/components/BalanceBanner.tsx` renders "Open queue" unconditionally when `data.imbalanced`.
- `packages/local-db/src/analytics-query.ts` counts all recent source elements by `createdAt`.
- `packages/local-db/src/queue-repository.ts` only returns due items with non-null due dates.
- `apps/desktop/src/main/db-service.ts` imports manual sources into `status: "inbox"` with no due date.
- `docs/solutions/ui-bugs/url-imported-articles-inbox-processing.md` confirms imported articles stay in the inbox until `Read now` accepts them.
