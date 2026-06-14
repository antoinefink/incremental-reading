---
title: "Scope ported design-kit CSS under the page root"
date: "2026-06-14"
category: "docs/solutions/design-patterns/"
module: "apps/web weekly-review screen (WeeklyReviewScreen.tsx + weekly-review.css)"
problem_type: "design_pattern"
component: "frontend_stimulus"
severity: "medium"
applies_when:
  - "Porting a Claude Design handoff into a new per-screen stylesheet that imports generic design-kit class names (.btn, .banner, .prio-dot, .dot-sep, .mono, .truncate)"
  - "Vite bundles each screen's imported CSS globally, so any unscoped selector leaks app-wide and silently restyles matching elements on other routes"
  - "A handoff is authored against the repo's own token vocabulary, making it a near-verbatim CSS lift plus markup rebuild rather than a from-scratch component"
  - "A mockup hand-rolls UI the app already has canonical primitives for (Prio/TypeIcon/ConceptTag) or fakes a derived metric the read model could earn (week-over-week deltas)"
  - "Scoping a descendant kit selector raises its specificity and trips Biome noDescendingSpecificity against later component-layer rules"
root_cause: "scope_issue"
resolution_type: "code_fix"
related_components:
  - "apps/web/src/weekly/WeeklyReviewScreen.tsx"
  - "apps/web/src/weekly/weekly-review.css"
  - "apps/web/src/components/inspector/primitives.tsx"
  - "packages/local-db/src/weekly-review-query.ts"
  - "apps/web/src/help/help.css"
---

# Scope ported design-kit CSS under the page root

## Context

The Weekly Review redesign ported a Claude Design handoff bundle into a new screen. The handoff used generic design-kit classes (`.btn`, `.banner`, `.prio-dot`, `.dot-sep`, `.mono`, `.truncate`) that the markup needs but that the shared `inspector.css` does not already provide, so they were copied into the screen's own stylesheet, `apps/web/src/weekly/weekly-review.css`, and pulled in with `import "./weekly-review.css"`.

The trap: in this Vite renderer **a per-screen `import "./screen.css"` is not component-scoped** — it appends every rule to the single global stylesheet for the whole app. A bare selector like `.btn { … }` in `weekly-review.css` is therefore a *global* `.btn` rule. It restyles the `Btn` components on completely unrelated routes — most sharply the help center and onboarding, whose authors had already hit this exact hazard and deliberately scoped *their* generic primitives under the page roots in `apps/web/src/help/help.css`:

```css
/* Generic class names (.btn, .pipeline) are scoped under the help/
   onboarding roots so they never leak into the rest of the app. */
:where(.hc, .coach, .welcome, .tour-rail) .btn { … }
```

The redesign re-introduced the leak that the help layer's `:where()` scoping was written to prevent. This is the spine of the learning: a token-faithful CSS port can still be *scope*-wrong.

## Guidance

### Primary — `import "./screen.css"` is global; scope every ported generic class under the screen's page-root class

CSS imported by a component is **not** scoped to that component. There is one global bundle; whichever selector wins the cascade wins app-wide. So any *generic* kit class you port into a per-screen stylesheet must be prefixed with the screen's root class so it can only match inside that screen.

Weekly Review follows the help-layer convention, anchored on its page-root `.wk` (every render path — body, loading, and error states — is wrapped in `<div className="wk">`):

```css
/* Ported kit classes (token-for-token from design/kit/styles/app.css) */
.wk .btn { … }
.wk .btn--primary { … }
.wk .prio-dot--a { background: var(--prio-a); }
.wk .banner--info { … }
.wk .dot-sep { … }
.wk .mono { font-family: var(--font-mono); }
.wk .truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
```

`.wk .btn` cannot match a button outside the `.wk` page column, so the help-center `.btn`, the queue's `.btn`, and every other `.btn` in the app are untouched.

The `.wk-*` *component* classes (`.wk-funnel`, `.wk-stage`, `.wk-sec`) are already uniquely named, so they don't need the prefix — only the **generic, collision-prone** names do. Note that the CSS-contract test (`weekly-review-css.test.ts`) pins the *bare* class names (`.btn`, `.prio-dot`, `.banner`) as present, but it checks the substring exists; it does **not** check scoping, so it passes even when a rule leaks. Scoping is a discipline the test does not enforce — the global-leak guard is the page-root prefix, not the test.

### Supporting 1 — when scoping a descendant rule raises specificity, order it AFTER the component layer (the `noDescendingSpecificity` gotcha)

Scoping is not free. Prefixing a *descendant* rule raises its specificity:

- `.btn svg` is `(0,1,1)`.
- `.wk .btn svg` is `(0,2,1)`.

Biome's `noDescendingSpecificity` fires when a higher-specificity rule for a key (`svg`) appears in the source **above** a later lower-specificity rule for the same key. The screen's component layer has `.wk-stage__lbl svg`, `.wk-arrow svg`, etc. If the ported `.wk .btn svg` block sits at the top, those later `.wk-* svg` rules "descend" in specificity and trip the lint.

The fix is purely ordering: place the entire ported-kit block **after** the `.wk-*` component layer (it now lives at the bottom of `weekly-review.css` under a `Ported kit classes` banner, with the component layer above it). Same-key (`svg`) rules then appear in ascending-specificity source order and the lint stays green. **Scope first, then order the ported block last — reorder, don't unscope.** Unscoping to silence the lint reintroduces the global leak; that is the wrong fix.

### Supporting 2 — earn UI metrics from the data layer; never fabricate them

The funnel renders week-over-week deltas. Those deltas are real because a symmetric prior-window count was added in `packages/local-db/src/weekly-review-query.ts`, not faked in the renderer:

- The current window counts the closed interval `[start, end]` (`endInclusive: true`).
- The prior window is half-open `[start − days, start)` (`endInclusive: false`), so the shared boundary `start` is attributed to **exactly one** window — no double-count.

```ts
interface CountWindow { start: IsoTimestamp; end: IsoTimestamp; endInclusive: boolean; }

function upperBound(column: AnyColumn, window: CountWindow) {
  return window.endInclusive ? lte(column, window.end) : lt(column, window.end);
}

function previousWindow(window: WeeklyReviewWindow): CountWindow {
  const priorStart = new Date(window.start);
  priorStart.setDate(priorStart.getDate() - window.days);
  return { start: priorStart.toISOString() as IsoTimestamp, end: window.start, endInclusive: false };
}
```

The prior counts surface as **optional** `*Prev` fields on `WeeklyReviewLedger` (`sourcesPrev?`, `extractsPrev?`, `cardsPrev?`, `maturedCardsPrev?`). Optional, so the renderer draws the delta only when the field is present — graceful degradation rather than a fabricated zero. Both window counts run through the *same* count helper, so the delta's two sides are computed identically — the only way a delta is trustworthy.

## Why This Matters

- A leaked generic class is a silent cross-route regression: a "Weekly Review styling" change quietly restyles buttons in help, onboarding, and any other screen that uses `.btn`. The breakage shows up on a route nobody touched, so it is expensive to trace back to the screen that caused it.
- The codebase already paid this tuition once — the `:where()` scoping in `help.css` exists *because* of this leak. Re-learning it per screen is wasted effort; the convention is "scope generic kit classes under the page root," full stop.
- Getting the specificity ordering wrong turns a correct scoping fix into a failing lint, which tempts the next person to *unscope* (the wrong fix) instead of *reorder* (the right one).
- Fabricated UI metrics erode trust in the whole surface. A delta earned from a half-open prior window is correct by construction and degrades gracefully when data is absent.

## When to Apply

- Any time you `import "./screen.css"` and the stylesheet contains a class name that is **not** unique to that screen — anything from the design kit (`.btn`, `.banner`, `.prio-dot`, `.mono`, `.truncate`, `.dot-sep`). Scope it under the screen's page-root class.
- When porting a Claude Design handoff bundle: reuse the real shared primitives (`TypeIcon`/`ConceptTag`/`Prio` from `apps/web/src/components/inspector/primitives.tsx` — `Prio` takes a **numeric** `priority`, not a letter) and `import "../components/inspector/inspector.css"` rather than re-porting them. Preserve every `data-testid`, visible label, and `appApi` call so the existing test contract stays green, and bind to **real server state** (server-persisted `progress`, reversible commands) — do not port the mock's `localStorage` / undo-snackbar / Reopen lifecycle flourishes the backend does not support.
- When Biome `noDescendingSpecificity` fires after you scope a descendant rule — reorder the ported block below the component layer, don't unscope.
- Whenever a UI shows a derived number (delta, percentage, trend): compute it in the data/query layer and pass it through as optional, never hard-code it in the component.

## Examples

### Before — bare generic selector leaks app-wide

```css
/* weekly-review.css — imported globally; this is now THE global `.btn` */
.btn { … }
.btn--primary { … }
.banner--info { … }
.mono { font-family: var(--font-mono); }
```

Effect: the help center's `Btn` (scoped author-side under `:where(.hc,.coach,.welcome,.tour-rail)`, which `:where()` keeps at zero specificity) now competes with — and on equal-or-higher specificity loses to — this leaked global rule on every route.

### After — scoped under the `.wk` page root

```css
.wk .btn { … }
.wk .btn--primary { … }
.wk .banner--info { … }
.wk .mono { font-family: var(--font-mono); }
```

`.wk .btn` only matches inside the Weekly Review column. Mirrors `help.css`'s `:where(.hc,.coach,.welcome,.tour-rail) .btn` precedent.

### Specificity-ordering gotcha — source order matters

```css
/* WRONG ORDER — `.wk .btn svg` (0,2,1) sits ABOVE later `.wk-stage__lbl svg`
   → Biome noDescendingSpecificity fires */
.wk .btn svg { width: 14px; height: 14px; }   /* (0,2,1) */
/* … component layer below … */
.wk-stage__lbl svg { width: 13px; }            /* (0,1,1) — now "descends" */

/* RIGHT ORDER — component (.wk-*) layer first, ported-kit block last */
.wk-stage__lbl svg { width: 13px; }            /* component layer */
.wk-arrow svg { width: 16px; }
/* … then the ported-kit block, all higher/equal specificity, ascending … */
.wk .btn svg { width: 14px; height: 14px; }    /* (0,2,1) at the bottom */
```

## Related

- [Three-zone scroll-owned review card surface](three-zone-scroll-owned-review-card-surface.md) — the same Claude Design handoff → token-only-CSS port recipe and the `*-css.test.ts` contract discipline; that doc generalizes *scroll ownership* as the port's failure mode, this one adds *global CSS-scope leakage* as a second, equally generic one.
- [Fold a floating diagnostics surface into the native Settings vocabulary](folding-floating-diagnostics-into-settings-section.md) — the handoff port recipe: preserve testids/labels, reuse token vocabulary, bind to real bridge state.
- [Renderer buttons need a global cursor baseline](../ui-bugs/renderer-button-cursor-baseline.md) — the `:where()` zero-specificity scoping and cascade-ordering precedent. This is its inverse: an *intended* global baseline there, vs. *preventing unintended* global leakage here.
- [Source Reader shared text measure](../ui-bugs/source-reader-shared-text-measure.md) — token-only CSS / shared-token-over-hardcoded-value convention.
- `apps/web/src/help/help.css` — the original in-repo instance of this learning (the `:where(.hc, …)` page-root scoping).
