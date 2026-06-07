---
title: "Renderer buttons need a global cursor baseline"
date: "2026-06-07"
category: "docs/solutions/ui-bugs/"
module: "apps/web global styles"
problem_type: "ui_bug"
component: "frontend_stimulus"
severity: "low"
symptoms:
  - "Some enabled renderer buttons showed the default arrow cursor instead of a pointer cursor."
  - "Button hover affordance depended on each local class remembering `cursor-pointer`."
  - "Accessible `[role=\"button\"]` controls needed the same enabled/disabled cursor contract as native buttons."
root_cause: "incomplete_setup"
resolution_type: "code_fix"
related_components:
  - "apps/web/src/styles.css"
  - "apps/web/src/styles-css.test.ts"
  - "docs/plans/2026-06-07-button-cursor-hover-plan.md"
tags:
  - "button-cursor"
  - "renderer-styles"
  - "global-css"
  - "tailwind-base"
  - "disabled-state"
  - "role-button"
  - "css-regression-test"
  - "pointer-affordance"
---

# Renderer buttons need a global cursor baseline

## Problem

Enabled renderer buttons had inconsistent hover cursors because many button
classes relied on Chromium's native `button` default, which is the arrow cursor.
Fixing individual surfaces would duplicate a global interaction rule and leave
future buttons vulnerable to the same omission.

## Symptoms

- Enabled buttons could look non-interactive on hover.
- Tailwind-only button clusters in settings, inbox, home, optimization, and
  balance surfaces needed `cursor-pointer` unless a local class remembered it.
- Accessible non-native controls using `role="button"` needed the same cursor
  affordance as native buttons.
- Disabled and `aria-disabled` controls still needed to avoid looking clickable.

## What Didn't Work

- Adding `cursor-pointer` one component at a time is brittle across shell,
  reader, queue, review, settings, maintenance, and import surfaces.
- A broad `button { cursor: pointer; }` rule would make disabled buttons look
  clickable.
- A raw `button:not(:disabled)` selector is still risky when declared after
  Tailwind utilities, because unlayered CSS can outrank utility-layer cursor
  classes.

## Solution

Put the renderer-wide cursor contract in `apps/web/src/styles.css` as a
Tailwind base-layer baseline:

```css
@layer base {
  :where(button:not(:disabled):not([aria-disabled="true"])) {
    cursor: pointer;
  }

  :where([role="button"]:not([aria-disabled="true"])) {
    cursor: pointer;
  }

  :where(button:disabled) {
    cursor: not-allowed;
  }

  :where(button[aria-disabled="true"]) {
    cursor: not-allowed;
  }

  :where([role="button"][aria-disabled="true"]) {
    cursor: not-allowed;
  }
}
```

Pin both the source contract and runtime behavior in `apps/web/src/styles-css.test.ts`:

- the selectors live inside `@layer base`;
- enabled native buttons compute to `cursor: pointer`;
- enabled `role="button"` controls compute to `cursor: pointer`;
- disabled native buttons, native `aria-disabled` buttons, and disabled
  role-buttons compute to `cursor: not-allowed`.

## Why This Works

`:where(...)` keeps selector specificity at zero, and `@layer base` makes the
rule a baseline instead of a component override. Native buttons and accessible
role-button controls now get the expected pointer affordance by default, while
disabled states are explicitly guarded.

The base layer also preserves future local cursor decisions. Component classes
and Tailwind cursor utilities can still express intentional exceptions such as
modal backdrops, text-like editor controls, PDF region interactions, and local
disabled-state styling.

## Prevention

- Keep renderer-wide interaction primitives in `apps/web/src/styles.css`.
- Use `@layer base` plus low-specificity selectors for global affordance
  baselines that utility classes should still override.
- Do not scatter `cursor-pointer` across every button to compensate for a
  missing baseline.
- When adding non-native clickable controls, use `role="button"` and set
  `aria-disabled="true"` when inactive.
- Preserve both regression-test styles: source-level assertions for layer and
  selector shape, plus computed-style assertions for observable cursor states.

## Related Issues

- [Compact card quality check disclosure](../design-patterns/compact-card-quality-check-disclosure.md) - related guidance on real button semantics and local CSS for dense UI surfaces.
- [Public static sites should reuse design tokens without crossing desktop boundaries](../architecture-patterns/public-static-site-design-boundary.md) - related guidance on styling drift prevention with focused CSS contract tests.
- [Battle-testing matrix and test-hardening execution for core app surfaces](../architecture-patterns/test-audit-driven-battle-testing.md) - related testing guidance for tokenized styling and UI-surface regression coverage.
