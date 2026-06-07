---
title: "Fix Card Quality Check Density"
type: fix
status: completed
date: 2026-06-07
---

# Fix Card Quality Check Density

## Summary

Card quality checks in the card builder should become a compact guardrail instead of a full-height checklist. The UI should keep blockers and warnings visible, hide passed checks by default, and preserve the existing quality heuristics, blocker semantics, and typed card-creation path.

## Problem Frame

The T035/T086 quality report has grown from a few rows into a long checklist. `CardBuilder` currently renders every `ok`, `warn`, and `block` row as a full-width stacked row, so Q&A and cloze authoring lose vertical space in the right builder column and in the embedded queue builder.

## Requirements

- R1. The builder shows a one-line quality summary that communicates ready, warning, or blocked state without consuming the space of every passed check.
- R2. `block` and `warn` rows remain visible by default; actual `ok` rows from `quality.checks` are unmounted until an accessible "Show passed" control is expanded.
- R3. Existing check IDs, messages, severities, and `data-testid="cb-qc-<id>"` hooks remain available when a row is visible.
- R4. Create remains disabled only for `block` checks; warnings remain advisory and never block creation.
- R5. The UI uses existing design tokens, lucide icons through `Icon`, and the builder/`qc` visual language rather than hard-coded colors or a new component palette.
- R6. The compact design works in both `/extract/$id` card builder and the process-queue embedded builder without changing card creation, source lineage, scheduler behavior, IPC, or domain heuristics.

## Key Technical Decisions

- **Filter by severity for default density:** Render actionable `block` and `warn` rows by default, and move passed rows into an explicit "Show passed" disclosure so the user can inspect the full report without paying the space cost on every edit.
- **Keep heuristics in `@interleave/core`:** `CardBuilder` continues to render `evaluateCardQuality` and `detectInterference` output; React should not duplicate or reinterpret quality rules.
- **Use a summary-first section:** Add a compact summary row with severity icon, counts, and `aria-live="polite"` so the disabled/create state is understandable before the row details.
- **Preserve row class contracts:** Keep `.qc`, `.qc--ok`, `.qc--warn`, and `.qc--block` for visible rows so existing styling and selection tests remain valid.
- **Do not synthesize absent checks:** Optional rows such as `similar-answer` stay absent when the heuristic does not return them, even when passed checks are expanded.

## Implementation Units

### U1. Compact Quality Rendering

- **Goal:** Replace the always-expanded checklist with a summary row, actionable row list, and passed-check disclosure.
- **Files:** Modify `apps/web/src/reader/CardBuilder.tsx`.
- **Patterns:** Follow the current quality memo in `CardBuilder`, the `HelpLink` usage in the quality section, and the design-kit `.qc` row contract. Treat `apps/web/src/reader/AiAssist.tsx` as a severity-filtering precedent only, not a styling or test-hook pattern.
- **Disclosure Contract:** Use a real button with `data-testid="cb-quality-toggle-passed"`, `aria-expanded`, and `aria-controls="cb-quality-passed"`. Collapsed passed rows are unmounted. Tab changes may keep the disclosure state, but the rows must always be recomputed from the current tab's actual `quality.checks`.
- **Test Scenarios:** Empty Q&A shows a blocked summary and visible `cb-qc-empty`; a warning-only draft shows warning count and visible warning rows while Create stays enabled; a clean source-backed draft hides `ok` rows until "Show passed" is activated; expanding passed checks still does not render absent optional checks such as `cb-qc-similar-answer` when no interference exists.
- **Verification:** `pnpm --filter @interleave/web test -- CardBuilder.test.tsx`.

### U2. Dense Builder Styling

- **Goal:** Style the summary and compact rows to match the existing professional builder surface and reduce row height.
- **Files:** Modify `apps/web/src/reader/extract-view.css`; verify `apps/web/src/pages/queue/process-queue.css` embedded-builder overrides still keep quality, schedule, and create controls in the constrained queue card.
- **Patterns:** Use `--ok`, `--warn`, `--danger`, `--surface`, `--surface-2`, `--border`, existing font scale, and the existing `.qc` severity classes.
- **Test Scenarios:** The quality section header, summary, visible rows, and passed disclosure fit without creating nested cards or one-off colors in both normal and queue builders. The queue embedded builder keeps the quality section compact under its existing height cap.
- **Verification:** Component tests plus direct inspection of `/extract/$id` and process-queue builder layout when running the renderer or Electron app.

### U3. Focused Regression Coverage

- **Goal:** Update tests from "all rows always visible" to the new default-visible contract.
- **Files:** Modify `apps/web/src/reader/CardBuilder.test.tsx`; inspect `tests/electron/cards.spec.ts` expectations for compatibility.
- **Patterns:** Keep assertions behavior-focused: severity, Create gating, warning advisory behavior, and disclosure visibility.
- **Test Scenarios:** Passed rows are absent before expanding and present afterward; warning/block rows remain directly queryable by their existing test IDs; tab changes recompute the summary and rows correctly.
- **Verification:** `pnpm --filter @interleave/web test -- CardBuilder.test.tsx`; `pnpm typecheck`; `pnpm test`. Inspect `tests/electron/cards.spec.ts` for stale always-visible `ok` assumptions and run targeted Electron coverage only if its assertions need updating.

## Scope Boundaries

- Do not change `packages/core/src/card-quality.ts` thresholds, check ordering, severity rules, or messages.
- Do not change `appApi.createCard`, `appApi.siblingCardAnswers`, Electron IPC, repositories, SQLite schema, or operation-log behavior.
- Do not redesign the full card builder, preview, priority chips, scheduler chip, audio cards, or image occlusion editor.
- Do not move quality checks into the review session or any global maintenance workflow.

## Sources / Research

- `apps/web/src/reader/CardBuilder.tsx` renders the live quality report and gates Create with `quality.hasBlocker`.
- `apps/web/src/reader/extract-view.css` defines the current full-height `.cb-quality__rows` and `.qc` rows.
- `apps/web/src/pages/queue/ProcessQueue.tsx` embeds the same `CardBuilder`, so the compact UI must not rely on route-specific layout.
- `packages/core/src/card-quality.ts` owns quality semantics; only hollow-card checks block.
- `docs/design-system.md` names `qc`, `cardprev`, priority chips, and FSRS scheduler chips as part of the builder visual language.
