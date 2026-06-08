---
title: "Inbox row metadata should stay on one line"
date: "2026-06-08"
category: "docs/solutions/ui-bugs/"
module: "inbox"
problem_type: "ui_bug"
component: "frontend_stimulus"
symptoms:
  - "Inbox row metadata wrapped across multiple lines when source labels, authors, or character counts were long."
  - "Large counts could split visually, with the number and ch unit appearing on separate lines."
root_cause: "logic_error"
resolution_type: "code_fix"
severity: "low"
related_components:
  - "apps/web/src/pages/inbox/InboxScreen.tsx"
  - "apps/web/src/pages/inbox/InboxScreen.test.tsx"
tags:
  - "inbox"
  - "metadata"
  - "nowrap"
  - "truncate"
  - "character-count"
  - "dense-list"
---

# Inbox row metadata should stay on one line

## Problem

Inbox source rows are dense triage controls, so their metadata must stay scannable under narrow
desktop widths. Long source labels, authors, and full localized character counts could wrap and
make rows visually unstable.

## Symptoms

- The source label, author, or size metadata could consume more than one physical row.
- Character counts could split between the number and unit, for example `20,971` on one line and
  `ch` below it.
- Long author text competed with fixed row tokens like the source label, separators, count, and
  priority chip.

## What Didn't Work

- Only adding `truncate` to the author is incomplete in a flex row unless the parent and flexible
  child also have `min-w-0`.
- Keeping full localized counts like `20,971 ch` wastes width in a dense row and makes the unit
  easier to orphan.
- Pinning the regression with many internal `data-testid`s made the test noisy and coupled to
  private row markup.
- A default Tailwind width such as `max-w-24` violates the project rule that dimensions come from
  design tokens or token-derived values.

## Solution

Keep the fix renderer-only. Add a small display formatter near the inbox row:

```ts
function formatInboxCharCount(charCount: number): string {
  if (charCount < 1000) return `${charCount} ch`;
  const compact = Math.round((charCount / 1000) * 10) / 10;
  return `${Number.isInteger(compact) ? compact.toFixed(0) : compact.toFixed(1)}k ch`;
}
```

Then make the metadata row a single-line flex contract:

```tsx
<span className="min-w-0 overflow-hidden whitespace-nowrap">
  <span className="max-w-[calc(var(--s-12)+var(--s-10))] shrink-0 truncate whitespace-nowrap">
    {item.srcType}
  </span>
  <span className="min-w-0 flex-1 truncate whitespace-nowrap">{item.author}</span>
  <span className="shrink-0 whitespace-nowrap font-mono">{formatInboxCharCount(item.charCount)}</span>
</span>
```

Protect fixed row pieces with `shrink-0`: source label, separators, compact count, and the trailing
priority chip. Let only the author absorb pressure with `min-w-0 flex-1 truncate`.

The regression test should scope to the existing row (`data-element-id`) and inspect visible text
within that row instead of adding production-only internal test IDs.

## Why This Works

The root issue was a flex-layout contract gap. `whitespace-nowrap` prevents the metadata tokens
from splitting, `min-w-0` lets the flexible middle author actually truncate, and `shrink-0`
prevents atomic pieces from collapsing unpredictably. Compact `k` counts reduce pressure before
CSS truncation has to do any work.

Using a token-derived max width keeps the source label bounded without introducing an off-system
spacing value.

## Prevention

- For compact metadata rows, combine parent `min-w-0 overflow-hidden whitespace-nowrap` with
  `shrink-0` fixed tokens and `min-w-0 flex-1 truncate` variable text.
- Compact large numeric metadata before relying on truncation.
- Use token-derived arbitrary values for one-off widths instead of default Tailwind spacing.
- Test the display output and the layout class contract from an existing stable row boundary; avoid
  adding internal production test IDs just to reach private spans.

## Related Issues

- [Renderer buttons need a global cursor baseline](./renderer-button-cursor-baseline.md) - related
  CSS regression-test practice for renderer UI behavior.
- [URL-imported articles should enter the inbox processing path](./url-imported-articles-inbox-processing.md)
  - same inbox surface, with the opposite detail/list lesson: selected detail should preserve full
  content while list rows stay compact.
- [Compact card quality check disclosure](../design-patterns/compact-card-quality-check-disclosure.md)
  - adjacent dense-surface design pattern using local scoped UI contracts.
