---
title: Fix button hover cursors across the renderer
type: fix
status: completed
date: 2026-06-07
---

# Fix button hover cursors across the renderer

## Summary

Several renderer buttons rely on the browser default cursor because their local
classes do not set `cursor: pointer`. The fix should establish a renderer-wide
interactive cursor baseline for enabled buttons and accessible role-button
controls, while preserving disabled cursor behavior.

---

## Problem Frame

The app has many one-off button classes across shell, reader, queue, review,
settings, maintenance, and import surfaces. Some classes already declare
`cursor: pointer`; others do not. Fixing each instance individually would keep
the app vulnerable to future omissions and would duplicate a design-system
baseline that belongs in the global renderer stylesheet.

---

## Requirements

- R1. Enabled native `button` elements in the Electron renderer show the pointer
  cursor without each component needing a local `cursor-pointer` class.
- R2. Native disabled buttons keep a disabled cursor instead of inheriting the
  enabled pointer baseline.
- R3. Accessible non-native controls with `role="button"` also show the pointer
  cursor unless explicitly marked `aria-disabled="true"`.
- R4. Existing component-level cursor rules for deliberately non-interactive or
  disabled states remain valid.
- R5. The fix is covered by a focused CSS regression test so future global-style
  changes cannot silently remove the baseline.

---

## Key Technical Decisions

- **Centralize in `apps/web/src/styles.css`:** The renderer already imports
  design tokens and Tailwind once in this file, and the missing cursor behavior
  is a global interaction baseline rather than a component-specific visual
  treatment.
- **Use low-specificity selectors that distinguish enabled from disabled
  controls:** A global `button { cursor: pointer; }` rule would make disabled
  buttons look clickable and could overpower intentional component cursors.
  `:where(...)` selectors inside Tailwind's `base` layer provide the baseline
  while preserving local overrides and utility classes.
- **Cover `role="button"` because the app has SVG graph nodes:** The shared
  concept map uses keyboard-accessible SVG groups with `role="button"`, so the
  baseline should apply to that accessible interactive role too.

---

## Implementation Units

### U1. Add the renderer cursor baseline

- **Goal:** Add global cursor rules for enabled native buttons and role-button
  controls, with disabled and `aria-disabled` states explicitly guarded.
- **Files:**
  - Modify: `apps/web/src/styles.css`
- **Patterns to follow:** Keep the rule near existing native-control global
  fixes in `apps/web/src/styles.css`.
- **Test scenarios:**
  - Enabled native button selector contains `cursor: pointer`.
  - Cursor baseline selectors are declared in Tailwind's `base` layer.
  - Native `aria-disabled="true"` button selector contains a disabled cursor.
  - Disabled native button selector contains a disabled cursor.
  - Enabled `[role="button"]` selector contains `cursor: pointer`.
  - `[role="button"][aria-disabled="true"]` selector contains a disabled cursor.
- **Verification:** `pnpm --filter @interleave/web test src/styles-css.test.ts`

### U2. Pin the global-style regression test

- **Goal:** Extend the existing global stylesheet test to assert the cursor
  baseline and disabled-state guards.
- **Files:**
  - Modify: `apps/web/src/styles-css.test.ts`
- **Patterns to follow:** Reuse the existing `cssBlock` helper and string-level
  assertions used for date-picker and shell-scroll CSS checks.
- **Test scenarios:**
  - CSS selectors are present in the global stylesheet.
  - Each selector carries the expected cursor declaration.
- **Verification:** `pnpm test` and `pnpm typecheck`

---

## Scope Boundaries

- Do not refactor per-surface button classes unless a local rule conflicts with
  the global baseline.
- Do not change button layout, spacing, colors, disabled opacity, or hover
  visuals.
- Do not touch the immutable design kit; it already has pointer cursor rules and
  is only a reference.

---

## Sources / Research

- `apps/web/src/styles.css` owns renderer-wide tokens, Tailwind, and native
  control fixes.
- `apps/web/src/styles-css.test.ts` already validates global CSS invariants.
- `apps/web/src/components/ConceptGraph.tsx` contains the renderer's discovered
  `role="button"` control.
