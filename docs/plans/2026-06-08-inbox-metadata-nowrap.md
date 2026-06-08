---
title: "Inbox row metadata stays one line"
date: "2026-06-08"
status: completed
execution: code
---

# Inbox row metadata stays one line

## Problem Frame

Inbox source rows currently let the metadata line wrap when a row has a long source label, author,
or full character count. The screenshot shows the count splitting onto two lines (`20,971` then
`ch`), which makes a dense triage list visually unstable.

Scope is the inbox list row presentation only. Do not change persistence, bridge payloads,
source import behavior, or the preview metadata rail.

## Requirements

- The source label, author, and size in an inbox row must each render as a single-line item.
- Long labels/authors should truncate with ellipsis rather than wrapping.
- Size should be compact enough for dense rows, using thousands as `k` where appropriate.
- The row title remains a single truncated line.
- The implementation stays renderer-only and uses existing design tokens/Tailwind utilities.

## Existing Patterns

- `apps/web/src/pages/inbox/InboxScreen.tsx` owns `InboxRow` and already uses `truncate` for the row title.
- `apps/web/src/pages/inbox/InboxScreen.test.tsx` is the focused regression target for inbox UI contracts.
- Prior UI baseline learning: `docs/solutions/ui-bugs/renderer-button-cursor-baseline.md` uses focused renderer tests to pin styling/interaction contracts.

## Implementation Units

### U1: Compact inbox metadata formatting

Goal: Make `InboxRow` format and render source type, author, and character count as non-wrapping inline metadata.

Files:

- Modify: `apps/web/src/pages/inbox/InboxScreen.tsx`

Approach:

- Add a small pure formatter near `InboxRow` for character counts:
  - values under 1,000 remain exact, e.g. `456 ch`;
  - values at or above 1,000 use one decimal only when useful, e.g. `1.2k ch`, `21k ch`.
- Use non-wrapping flex children for the source label and size.
- Let the author occupy the flexible middle slot with `min-w-0`, `truncate`, and `whitespace-nowrap`.
- Keep the whole metadata line `min-w-0`, `overflow-hidden`, and `whitespace-nowrap`.

Test scenarios:

- `456` formats as `456 ch`.
- `1,234` formats as `1.2k ch`.
- `20,971` formats as `21k ch`.
- A long label, long author, and large size row renders metadata spans with nowrap/truncate classes so none of those fields can wrap.

Verification:

- Focused Vitest for `InboxScreen` passes.
- `pnpm typecheck` passes.
- `pnpm test -- apps/web/src/pages/inbox/InboxScreen.test.tsx` passes.

## Risks

- Over-compressing small counts can reduce precision; keep exact counts below 1,000.
- CSS class regressions are easy to miss in jsdom; pin the specific classes that enforce single-line behavior.
