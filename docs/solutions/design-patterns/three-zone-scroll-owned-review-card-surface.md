---
title: "Three-zone scroll-owned review card surface"
date: "2026-06-09"
category: "docs/solutions/design-patterns/"
module: "apps/web in-session review card (ProcessQueue card branch + process-queue.css)"
problem_type: "design_pattern"
component: "frontend_stimulus"
severity: "medium"
applies_when:
  - "Porting a Claude Design HTML/CSS mockup into the real React + token-only-CSS stack"
  - "A card needs a pinned header + single scrolling body + pinned footer so long content can't push action controls off-screen"
  - "A nested flex layout must give exactly one region the scroll, needing min-height:0 on every ancestor"
  - "A mockup hand-rolls UI the app already has a canonical component for (SchedulerChip, RefBlock/formatSourceRef)"
  - "Verifying a layout that jsdom CSS-contract tests can't prove visually (overlap, pinning, reachability)"
related_components:
  - "apps/web/src/pages/queue/ProcessQueue.tsx"
  - "apps/web/src/pages/queue/process-queue.css"
  - "apps/web/src/pages/queue/process-queue-css.test.ts"
  - "apps/web/src/pages/queue/ProcessQueue.test.tsx"
  - "tests/electron/process-queue.spec.ts"
tags:
  - "card-review"
  - "process-queue"
  - "scroll-ownership"
  - "flex-min-height-0"
  - "css-contract-test"
  - "electron-geometry-test"
  - "component-reuse"
  - "design-kit-port"
---

# Three-zone scroll-owned review card surface

## Context

A Claude Design handoff bundle (HTML/CSS mockup) for the in-session review card needed to become
real React + token-only CSS. The old inline card (`ProcessCard`, the `card` branch in
`apps/web/src/pages/queue/ProcessQueue.tsx`) was a **centered, fixed-height single column** —
`.pq-cardface { display:flex; flex-direction:column; align-items:center; text-align:center }`.
Prompt, revealed answer, source `RefBlock`, the four FSRS grade buttons, an FSRS triple-stat box,
and an "Open in review" link all stacked in one non-scrolling column. The moment an answer ran
long or a source excerpt was large, the column grew past the viewport and **pushed the
Again/Hard/Good/Easy grades off-screen** — the primary action became unreachable mid-review. The
mockup also shipped bespoke pills/quote blocks and re-stated FSRS stats the Card inspector already
owned.

This learning captures the reusable recipe for that kind of port (commit restructuring the single
`card` branch into a three-zone card: pinned identity header / single scrolling body / pinned grade
footer), plus the verification approach and a few non-obvious gotchas. No `data-testid` or feature
was dropped; the non-card source/extract workbench branches were untouched.

## Guidance

### (a) The three-zone flex/scroll structure — scroll ownership

The whole recipe is **scroll ownership**: `min-height: 0` on *every* ancestor in the height chain,
and **exactly one** `overflow-y: auto` region. A flex item defaults to `min-height: auto` and
refuses to shrink below its content — so without `min-height: 0` at each level, the inner scroller
never gets a bounded height and the *page* (or an outer container) scrolls instead, pushing the
pinned actions off-screen.

```css
/* work area, review mode: fill height instead of vertically centering */
.pq-center--review { align-items: stretch; justify-content: flex-start; min-height: 0; }

/* borderless full-height layout FRAME — holds session controls + card + action bar */
.pq-card--review { flex: 1 1 0; min-height: 0; border: 0; background: transparent; padding: 0; }

/* centers a short card; bounds + scrolls a tall one */
.pq-rc-center { flex: 1 1 auto; min-height: 0; display: flex; overflow: hidden; }

/* the bordered card box — never exceeds the viewport; the BODY scrolls instead */
.pq-rc {
  max-width: 680px; margin: auto;
  border: 1px solid var(--border); border-radius: var(--r-xl);
  box-shadow: var(--shadow-md);
  display: flex; flex-direction: column;
  min-height: 0; max-height: 100%; overflow: hidden;   /* clip; delegate scroll to body */
}
.pq-rc__head { flex: none; }                                      /* pinned */
.pq-rc__body { flex: 1 1 auto; min-height: 0; overflow-y: auto; } /* the ONLY scroll region */
.pq-rc__foot { flex: none; border-top: 1px solid var(--border); } /* pinned */
```

The footer (grades) is **render-gated** (`{revealed && cardView ? <footer> : null}`), not just
hidden — so a one-line card sizes to content with no footer, and the grades stay absent from the
DOM until reveal (which also keeps an e2e contract that asserts grades count 0 pre-reveal green).

### (b) New bordered class, not the shared base class

The card box is a **new `.pq-rc`**, not the existing `.pq-card`. The base `.pq-card` is pinned
*flat* (border, no `box-shadow`) by a CSS-contract test for attention items, and its padding/gap
model is the wrong shape for a head/body/foot card. So `.pq-card--review` was repurposed as a
borderless *layout frame* and `.pq-rc` is the actual bordered, **shadowed** card box. This delivers
the design difference (the review card is elevated; attention cards are flat) without mutating the
shared base class the contract test pins. When a mockup wants a property a test forbids on a shared
class, branch to a new class rather than fighting the test.

### (c) Reuse canonical components over the mockup's bespoke widgets

The mockup hand-rolled a scheduler pill (`.fsrs-pill`) and a quote block. Drop them for the
codebase's canonical components: `SchedulerChip` (preserves the load-bearing FSRS-vs-attention
scheduler distinction `design/AGENTS.md` requires) and `RefBlock` + the shared `formatSourceRef`
(keeps citation/dedup/reliability behavior). FSRS numbers render via the existing `formatStability`
/ `formatDifficulty` helpers, not re-derived inline. Fidelity to the **design system** beats
fidelity to a mockup's approximation.

### (d) De-duplicate to one canonical owner

- **FSRS stats:** the full triple-stat `FsrsStats` box was removed from the card face — the Card
  inspector already owns it. The face keeps a single compact mono recall line (`.pq-rc__recall`).
- **"Open in review":** the redundant in-card button was removed — the action bar's "Open in full"
  already calls the same `onOpen` handler.
- Header chip and footer recall both read one derived value computed once:
  `const cardSig: SchedulerSignals = cardView ? cardChipSignals(cardView) : chipSignals(item);`
  (graceful fallback to trimmed queue signals while the card view loads). Avoid an inline IIFE that
  recomputes the same adapter twice in one render.

### (e) Verify with a dual jsdom + Electron pair

jsdom can't lay out, so a **CSS-contract test** (`process-queue-css.test.ts`) reads the stylesheet
text and pins the scroll chain property-by-property:

```js
expect(body).toContain("flex: 1 1 auto;");
expect(body).toContain("min-height: 0;");
expect(body).toContain("overflow-y: auto;");   // the single scroll region
expect(head).toContain("flex: none;");
expect(foot).toContain("flex: none;");
expect(source).toContain("overscroll-behavior: contain;");
```

An **Electron geometry test** (`tests/electron/process-queue.spec.ts`) proves what jsdom can't —
that the rules actually *produce* a pinned, reachable footer under forced overflow:

```js
expect(overflow.scrollH).toBeGreaterThan(overflow.clientH + 200); // body really overflows
expect(footBox1.y + footBox1.height).toBeLessThanOrEqual(viewportH + 1); // footer on-screen
// scroll body to bottom → header/footer don't move (pinned):
expect(Math.abs(footBox2.y - footBox1.y)).toBeLessThanOrEqual(1);
// footer is reachable: grading Good writes a durable log:
await page.getByTestId("process-grade-good").click();
await expect.poll(async () => cardLogCount(page, cardId)).toBe(before + 1);
```

### (f) E2E gotchas

- **Force overflow with CSS, not a DOM node.** To make the body overflow regardless of which seeded
  card surfaces, inject a CSS spacer via `addStyleTag`, not an appended child:
  `'[data-testid="process-card-face"] .pq-rc__answer::after { content:""; display:block; height:1200px; }'`.
  A child appended via `page.evaluate` gets **reconciled away by React** on the next async re-render
  (e.g. interval previews loading); a `::after` pseudo-element on a React-owned node is invisible to
  the reconciler, survives re-renders, and leaks nothing into later serial tests.
- **Rebuild before Electron e2e.** The `electron` Playwright project loads the *built* `dist`, so a
  renderer change must be rebuilt (`pnpm build`) before the spec sees it.
- **Attribute an e2e flake to pristine main before "fixing" it.** A long serial Electron spec can
  contain a pre-existing ~50% flake (here an unrelated extract `undo → reload` race) that *appears*
  caused by adding a new test, purely because correlation across a handful of runs is noise at that
  flake rate. The decisive diagnostic: `git stash -u` all changes, `pnpm build`, **grep the built
  `dist` to confirm it actually reverted** (turbo cache can replay a stale build), then run the
  suite on pristine main. If it flakes there too, it is not yours — append the new test (own data
  dir, no shared state) and leave the pre-existing flake as separate follow-up work.

## Why This Matters

The failure mode every design-kit→React port of a scrollable interactive surface hits is **scroll
ownership**. `overflow-y: auto` on the inner region is not enough: a flex/grid child defaults to
`min-height: auto` and refuses to shrink below its content, so the bounded height never propagates
and the outer container scrolls instead — pushing pinned actions off-screen. The fix is mechanical
and worth memorizing: **`min-height: 0` on every ancestor in the height chain + exactly one
`overflow-y: auto` region**, with `max-height: 100%; overflow: hidden` on the clipping box.

Reusing canonical components keeps design-system invariants intact and avoids drift; de-duplicating
to a single owner prevents two sources of truth. And the **dual-test pattern** is the real lesson:
the jsdom test (cheap, fast) pins the *CSS rules* but is blind to layout; the Electron geometry test
proves the rules actually pin and keep the footer reachable under forced overflow. Neither alone is
sufficient — jsdom passes even when the layout visually breaks; the Electron test alone wouldn't
catch a future edit silently dropping an individual contract property.

## When to Apply

Any design-kit → React port of a **dense, interactive card or panel that must scale from one-line to
long content while keeping action controls (grades, submit, primary CTAs) reachable**. Signs you
need the three-zone recipe: the mockup centers content in a fixed column; there is a header/identity
region and a footer/action region that should stay visible; the middle can grow unboundedly (long
answers, large excerpts, lists). Pair it with the jsdom-contract + real-browser-geometry
verification whenever scroll containment is load-bearing.

## Examples

**Before** — centered fixed column; grades scroll away with long content:

```css
.pq-cardface { display:flex; flex-direction:column; align-items:center; text-align:center; }
/* prompt, answer, RefBlock, .grades, FsrsStats box, "Open in review" all stack here, no scroll region */
```

**After** — three zones; grades pinned, only the body scrolls:

```css
.pq-rc       { display:flex; flex-direction:column; min-height:0; max-height:100%; overflow:hidden; box-shadow:var(--shadow-md); }
.pq-rc__head { flex:none; }                                      /* pinned identity */
.pq-rc__body { flex:1 1 auto; min-height:0; overflow-y:auto; }   /* the ONLY scroller */
.pq-rc__foot { flex:none; border-top:1px solid var(--border); }  /* pinned grades + recall line */
.pq-rc__source { max-height:280px; overflow-y:auto; overscroll-behavior:contain; } /* big excerpt scrolls in its own cap */
```

## Related

- [process-queue-extract-card-height-alignment](../ui-bugs/process-queue-extract-card-height-alignment.md)
  — the primary scroll-chain predecessor (the `.pq-card`/`.pq-center` flex chain, `min-height:0` at
  every shrinking ancestor, single overflow owner, `flex:none` siblings, max-height media fallback).
  This doc extends the same recipe to the card branch.
- [extract-distillation-scroll-contained-editor](../ui-bugs/extract-distillation-scroll-contained-editor.md)
  — the scroll-containment origin and the "pair jsdom CSS-contract with an Electron geometry check"
  rule.
- [source-reader-scroll-extents-rich-source-rendering](../ui-bugs/source-reader-scroll-extents-rich-source-rendering.md)
  — the route-shell-vs-inner-scroller precedent.
- [extract-inspector-single-responsibility-lineage-scheduler](../ui-bugs/extract-inspector-single-responsibility-lineage-scheduler.md)
  — the one-canonical-owner / de-duplicate-facts principle (FSRS stats, removed duplicate actions).
- [process-queue-inline-session-controls](../ui-bugs/process-queue-inline-session-controls.md)
  — the stable-testid + `process-queue-css.test.ts` CSS-contract discipline.
- [electron-e2e-stale-build-lock-and-lineage-contract](../test-failures/electron-e2e-stale-build-lock-and-lineage-contract.md)
  — the stale-`dist` / build-staleness predecessor. This doc adds the developer-run **pristine-main
  flake-diagnosis** procedure and the **`page.evaluate` → React-reconciliation `::after`** gotcha,
  neither of which it covers.
- Sibling design-pattern: [compact-card-quality-check-disclosure](./compact-card-quality-check-disclosure.md)
  — same `/process` card surface, "reuse canonical components, don't duplicate" rhyme.
