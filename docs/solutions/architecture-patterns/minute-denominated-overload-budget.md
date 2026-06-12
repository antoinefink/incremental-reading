---
title: "Minute-denominated overload budgets should price the full due universe"
date: 2026-06-12
category: architecture-patterns
module: queue-overload
problem_type: architecture_pattern
component: service_object
severity: medium
applies_when:
  - "A daily workload budget must compare heterogeneous due work by estimated effort"
  - "A mutation planner needs time estimates while count-based callers still exist"
  - "A queue surface filters due work but planner decisions must stay backend-owned"
related_components:
  - database
  - testing_framework
  - frontend_stimulus
tags: [queue, budget, time-estimates, auto-postpone, settings, ipc]
---

# Minute-denominated overload budgets should price the full due universe

## Context

T116 moved the overload budget from item count to estimated minutes. The old count budget made a short cloze, a source-reading pass, and a long PDF session all cost one unit, so queue gauges and auto-postpone could look balanced while the real day was overloaded.

T115 had already introduced a trusted queue time-cost read model. The T116 pattern is to make minute budgeting consume that read model without breaking legacy count-only consumers during the compatibility window.

## Guidance

Keep the canonical user-facing workload setting minute-denominated, but preserve explicit compatibility for count-only readers while they still exist.

```ts
export interface AppSettings {
  readonly dailyBudgetMinutes: number;
  readonly dailyReviewBudget: number;
}
```

When reading settings, derive the minute budget from the legacy persisted count only when the new key is absent. When writing either key, mirror the other key through its own bounds so rollback and older callers continue to receive valid values.

Keep response contracts honest by exposing count and minute budgets as separate fields:

```ts
type QueueListResult = {
  budget: { used: number; target: number };
  minuteBudget?: {
    usedMinutes: number;
    targetMinutes: number;
    confidence: "learned" | "default";
  };
};
```

The count `budget` remains a compatibility surface. New queue and home overload UI should request time estimates and read `minuteBudget`; badges and old count-only consumers can keep the lean count field.

For mutation planners such as auto-postpone, price the full filtered due universe, not the visible rows and not the unfiltered global queue. The planner should receive per-item minutes and trim against raw minute math:

```ts
const candidates = queue.autoPostponeCandidates({ asOf, filters, mode });
const estimate = timeCost.estimateQueue(candidates.timeCostSummary, {
  asOf,
  visibleItems: candidates.items.map(({ id, type, stage }) => ({ id, type, stage })),
});
```

Forward the same durable queue filters into preview and apply. Type, status, concept, clock, and session mode all affect either membership or victim ranking, so the plan shown in the banner must match the plan applied by the command. Client-only pseudo-filters should not be sent as if they were backend filters.

The planner should stop at a reserve target below the configured budget, not exactly at the budget line. That leaves space for late-day reviews or imports without immediately re-entering overload:

```ts
const reserveTargetMinutes = targetMinutes * 0.9;
if (remainingMinutes <= reserveTargetMinutes) break;
```

Do not let minute math weaken the existing protection policy. Auto-postpone can report protected overflow when fragile or high-priority work keeps the day above budget, but it should not sacrifice protected rows just to make the gauge green.

## Why This Matters

Minute budgets only help if every participant uses the same unit. A minute-rendering gauge backed by count-based over-budget detection would still suggest the wrong action. A minute-based planner that prices only visible rows would undercut virtualized or capped queues. A planner that ignores filters would postpone work outside the user's current overload context.

Separating `budget` from `minuteBudget` makes the migration auditable. Readers can be migrated one by one without overloading a count-shaped field with minute semantics, and tests can prove which surfaces remain intentionally count-denominated.

Keeping the pricing and planning main-side also preserves Interleave's trust boundary: React formats the budget and asks for preview/apply, while local-db and scheduler code own queue eligibility, T115 pricing, victim ranking, and durable mutations.

## When to Apply

- A workload limit compares cards, sources, extracts, topics, or other heterogeneous work.
- A UI preview and a backend apply command must agree on filtered due membership.
- Legacy count fields must remain available during a settings or contract migration.
- A planner has protected work that may make a minute target unreachable.
- The time estimate has learned/default confidence that should be visible to the user.

Do not apply this pattern by renaming a count field to minutes in place. If old consumers still exist, keep a separate compatibility field until they are migrated or deleted.

## Examples

Tests should pin both the migration and the planner boundary:

- Settings tests cover deriving `dailyBudgetMinutes` from legacy stored data, new-key precedence, low legacy values, and write-through in both directions.
- Queue backend tests cover `minuteBudget` only when `includeTimeEstimate` is requested.
- Auto-postpone service tests cover filtered full-universe pricing and preview/apply fields for `targetMinutes`, `usedMinutes`, `overBudgetMinutes`, and `remainingMinutesAfter`.
- Scheduler tests cover mixed-cost victims, reserve behavior, fractional minutes, and unreachable protected overflow.
- Renderer and Electron tests cover minute labels, presets, overload preview, and apply behavior in the native app.

The UI should present default-derived estimates as approximate:

```tsx
<BudgetMeter
  used={result.minuteBudget.usedMinutes}
  target={result.minuteBudget.targetMinutes}
  confidence={result.minuteBudget.confidence}
/>
```

The auto-postpone banner should pass backend-owned filters, but skip pseudo-filters that only exist in React:

```ts
filters={{
  ...(activeTypes ? { types: activeTypes } : {}),
  ...(activeStatuses ? { statuses: activeStatuses } : {}),
  ...(concept ? { concept } : {}),
}}
```

## Related

- [Model queue time cost as an opt-in trusted read model](./queue-time-cost-read-model.md)
- [Queue eligibility must be canonical across inventory, actions, and undo](../logic-errors/queue-eligibility-inventory-scheduler-state.md)
- [Chronic postpone reckoning from operation-log reset markers](./chronic-postpone-reckoning-from-operation-log-reset-markers.md)
- [Trusted schedule reasons come from governing reschedule operations](./trusted-schedule-reasons-from-governing-reschedule-ops.md)
