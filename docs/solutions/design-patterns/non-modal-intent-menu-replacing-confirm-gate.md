---
title: "Non-modal intent menu replacing a blocking confirm gate"
date: "2026-06-09"
category: "docs/solutions/design-patterns/"
module: "apps/web queue done-gate (DoneIntentMenu across ProcessQueue, QueueScreen, SourceReader)"
problem_type: "design_pattern"
component: "frontend_stimulus"
severity: "medium"
applies_when:
  - "Replacing a native window.confirm/alert/prompt for an action that has more than one legitimate intent (e.g. finish vs. defer vs. abandon)"
  - "The same destructive/terminal action is reached from 2+ surfaces and you want one shared component, not per-site confirms"
  - "A server-side gate is the real authority and the renderer only needs to collect intent + pass an override flag"
  - "The action has a fast path (no confirmation needed) that resolves WITHOUT opening any surface"
  - "An in-flight/double-submit guard is needed on a component whose popover may never open"
related_components:
  - "apps/web/src/components/queue/DoneIntentMenu.tsx"
  - "apps/web/src/components/queue/done-intent-menu.css"
  - "apps/web/src/pages/queue/doneIntentBreakdown.ts"
  - "apps/web/src/pages/queue/ProcessQueue.tsx"
  - "apps/web/src/pages/queue/QueueScreen.tsx"
  - "apps/web/src/pages/source/SourceReader.tsx"
  - "apps/web/src/components/queue/ScheduleMenu.tsx"
  - "tests/electron/done-intent.spec.ts"
tags:
  - "non-modal"
  - "confirm-gate"
  - "intent-surface"
  - "optimistic-undo"
  - "in-flight-guard"
  - "react"
  - "queue"
---

# Non-modal intent menu replacing a blocking confirm gate

## Context

The queue's "Done" action on a source fired a native `window.confirm("This source still has
N unresolved blocks. Mark it done anyway?")` at three call sites (the in-session ProcessQueue
loop, the QueueScreen list rows, and the standalone SourceReader). For an incremental-reading
app this was wrong twice over: it fired on the *normal* mid-processing state (only 3 of 7 block
states are terminal, so a 1%-read source shows "68/68 unresolved"), and a yes/no can't tell
"I'm finished" from "bring it back later" from "I misclicked." `window.confirm` is also
un-stylable, off-design, and invisible to Electron Playwright e2e.

The replacement is a single shared **non-modal intent surface** (`DoneIntentMenu`) offering the
three real intents — **Return later** (postpone) / **Finished** (mark done) / **Abandon**
(dismiss) — defaulting focus to the safe action, rendering an honest per-state breakdown instead
of a scary count. This doc captures the reusable shape and the one non-obvious gotcha that bit
us during code review.

## Guidance

**1. Make the surface a self-contained component that mirrors the existing anchored-popover
pattern.** In this codebase that is `ScheduleMenu` (anchored popover, `openSignal` prop,
outside-click + Escape close, token-only CSS) plus `BalanceBanner`'s focus management
(focus the default item on open, restore focus to the trigger on Escape). The component owns its
trigger button AND the popover, so each call site just supplies styling + callbacks.

**2. Keep the gate server-authoritative; the renderer only collects intent.** The three intents
map 1:1 to existing typed mutations — no new IPC, no domain logic in React:

```
later    → actOnQueueItem({ kind: "postpone" })
finished → actOnQueueItem({ kind: "markDone", confirmUnresolvedBlocks: true })
abandon  → actOnQueueItem({ kind: "dismiss" })
```

`confirmUnresolvedBlocks` is an *override flag* the server gate still validates; the surface never
re-implements the gate. Agent-native parity falls out for free — anything the surface does, an
agent can do by calling the same typed action.

**3. Centralize the fast path in the component via a `getSummary` callback + a `triggerSignal`
for keyboard.** The component fetches the summary on trigger; if `canMarkDoneWithoutConfirmation`
it resolves immediately with no popover; otherwise it opens. A `triggerSignal` prop (a bumped
counter, exactly like `ScheduleMenu`'s `openSignal`) lets a keyboard shortcut run the identical
click logic. This keeps the fast-path decision in one place instead of re-deriving it at every
site.

**4. Render an honest breakdown, not a raw count, via a pure helper.** `doneIntentBreakdown.ts`
maps `stateCounts` into friendly, ordered, non-terminal segments ("60 unread · 3 deferred · 1
stale after edit"), deriving the non-terminal set from the domain's own
`isTerminalSourceBlockProcessingState` so the copy can't drift. The helper is React-free and
unit-tested in isolation.

**5. CRITICAL — reset the in-flight guard on the host's `busy` settling, not on the popover
open→close transition.** A guard that resets only when `open` changes deadlocks the fast path,
which resolves *without ever opening the popover* (see Why This Matters). Gate the reset on `busy`.

## Why This Matters

The subtle, code-review-caught bug: the in-flight guard (`submittingRef`) was reset by an effect
keyed on `open`:

```ts
// BEFORE — deadlocks the fast path
useEffect(() => {
  if (!open) submittingRef.current = false;
}, [open]);
```

The 0-unresolved **fast path** sets `submittingRef = true` and calls `onResolved("finished")`
but `return`s *without* opening the popover — so `open` never changes, the effect never re-fires,
and the guard stays `true` forever. If the host mutation then fails (or the component otherwise
stays mounted on the same item), every subsequent trigger is silently dropped — the only Done
affordance is permanently dead. Three independent reviewers (correctness, adversarial,
frontend-races) converged on this.

```ts
// AFTER — releases the guard whenever the host action settles
useEffect(() => {
  if (!busy) {
    submittingRef.current = false;
    fetchingRef.current = false;
  }
}, [busy]);
```

`busy` is held true while the host action runs (so a double-submit is still blocked during the
in-flight window) and returns to false on success OR failure — so the control never deadlocks and
a retry stays possible. The lesson generalizes: **a guard's reset condition must cover every path
that sets it, including paths that skip the UI state the reset was keyed on.**

Two more divergence risks worth pinning:
- A non-modal surface lets state go stale (the doc can change while it's open); the server gate is
  the real safeguard, so passing `confirmUnresolvedBlocks: true` is always correct. ProcessQueue
  additionally re-fetches the summary on Finished to avoid forcing the override on a now-clean
  source — a deliberate, optional tightening, not a correctness requirement.
- An async `getSummary` can resolve after the host navigates away (the reader exits on
  Finished/Abandon); guard the post-await body with a `mountedRef` to avoid setState-on-unmounted.

## When to Apply

- Replacing any `window.confirm`/`alert`/`prompt` where the action has more than one legitimate
  outcome — route intent instead of asking yes/no.
- When the same action is invoked from multiple surfaces and you want one shared component with
  per-site callbacks (post-action differs: advance cursor / refresh list / navigate).
- When a destructive action should be optimistic + reversible: prefer a visible Undo snackbar +
  global ⌘Z over a blocking confirm (and remember ⌘⇧Z redo is out of MVP scope here).
- Any component with an in-flight guard AND a branch that resolves without opening its surface —
  audit the reset condition.

## Examples

Per-site wiring is uniform; only the post-action callback differs:

```tsx
<DoneIntentMenu
  getSummary={getDoneSummary}          // () => Promise<summary | null>; drives the fast path
  onResolved={onDoneIntentResolved}    // (intent) => host runs the mutation + post-action + undo
  busy={busy}                          // reactive; releases the in-flight guard on settle
  resumeLabel={resumeLabel}            // "block N of M" or null (gate on an actual read-point)
  triggerSignal={doneIntentSignal}     // bump from the `d` shortcut to run the same click logic
  triggerTestId="reader-mark-done"     // keep the old testid so existing e2e still finds it
/>
```

Post-action per site: ProcessQueue advances the loop cursor and raises a `QueueSnackbar` Undo for
Finished/Abandon; QueueScreen refreshes the list and raises the snackbar; SourceReader navigates
to `/queue` on Finished/Abandon (with a ⌘Z toast) but stays + refreshes the inspector on Return
later (read-point untouched — "where" stays decoupled from "when").

E2e proves the surface appears in-app (no native dialog), each intent persists across restart,
Return later keeps the read-point, and the snackbar Undo restores prior status — see
`tests/electron/done-intent.spec.ts`. The fast-path-retry regression is locked by a unit test in
`DoneIntentMenu.test.tsx`.

## Related

- [Durable source block-processing state](../architecture-patterns/durable-source-block-processing-state.md) — defines terminal vs. unresolved and the server-side done-gate this surface defers to.
- [Queue eligibility, inventory & scheduler state](../logic-errors/queue-eligibility-inventory-scheduler-state.md) — markDone/dismiss clear `due_at` in the same transaction; undo preimages; the snackbar-undo contract reused here.
- [Daily-work read model / inbox-only routing](../ui-bugs/daily-work-read-model-inbox-only-routing.md) — read-point (where) vs. due-date (when) decoupling that "Return later" preserves.
- [Three-zone scroll-owned review card surface](three-zone-scroll-owned-review-card-surface.md) — sibling ProcessQueue-UI design pattern; layout precedent for in-surface panels.
