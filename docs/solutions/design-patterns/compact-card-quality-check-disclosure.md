---
title: "Compact card quality check disclosure"
date: "2026-06-07"
category: "docs/solutions/design-patterns/"
module: "apps/web reader CardBuilder and process queue quality checks"
problem_type: "design_pattern"
component: "frontend_stimulus"
severity: "medium"
applies_when:
  - "Compacting Q&A and cloze card quality checks in dense card-building flows"
  - "Quality checks need visible blockers, visible warnings, passed-check disclosure, and contextual help"
related_components:
  - "apps/web/src/reader/CardBuilder.tsx"
  - "apps/web/src/reader/CardBuilder.test.tsx"
  - "apps/web/src/reader/extract-view.css"
  - "apps/web/src/pages/queue/ProcessQueue.test.tsx"
  - "apps/web/src/help/help-bodies.ts"
  - "tests/electron/process-queue.spec.ts"
tags:
  - "card-builder"
  - "card-quality"
  - "quality-checks"
  - "cloze-cards"
  - "qa-cards"
  - "process-queue"
  - "contextual-help"
  - "electron-tests"
---

# Compact card quality check disclosure

## Context

The card-quality checklist had grown large enough to crowd Q&A and cloze authoring, especially inside the embedded process-queue builder. The fix needed to make the panel denser without weakening the guardrails that prevent hollow cards and warn about weak drafts.

The important boundary is that quality semantics still belong to `@interleave/core`. `CardBuilder` should present `evaluateCardQuality` and `detectInterference` results; it should not duplicate thresholds, messages, ordering, or card-creation rules.

## Guidance

Use a summary-first quality panel:

```tsx
const actionable = quality.checks.filter((check) => check.severity !== "ok");
const passed = quality.checks.filter((check) => check.severity === "ok");
```

Render a compact status summary first, then keep `block` and `warn` rows visible by default. Put actual `ok` rows from `quality.checks` behind an explicit disclosure button.

Preserve row contracts when rows are visible:

- `.qc`, `.qc--ok`, `.qc--warn`, and `.qc--block`
- `data-testid="cb-qc-<id>"`
- `data-severity="<severity>"`

Keep the disclosure accessible and honest:

- Use a real button with `aria-expanded` and `aria-controls`.
- Unmount passed rows while collapsed so the compact state really reduces reading and tab-stop noise.
- Recompute rows from the current tab's actual `quality.checks`.
- Do not synthesize absent optional checks just to fill the disclosure. For example, `similar-answer` stays absent when interference detection returns nothing, even after passed checks are expanded.

The create gate should continue to read from `quality.hasBlocker`. Blockers disable creation, warnings remain advisory, and passed rows are inspectable when the user needs the full report.

Style the compact surface locally with existing design tokens and existing severity colors. The builder can tighten `.qc` rows inside `.cb-quality`, but it should not introduce a new palette or global row style that changes unrelated quality-check surfaces.

Update contextual help in the same change. When the visible contract changes from "all rows are always shown" to "summary plus actionable rows, with passed rows disclosed," help text is part of the UI contract.

## Why This Matters

This keeps the authoring surface focused on writing the card while preserving the safety model. Users still see what blocks creation and what needs attention, but successful checks stop taking most of the vertical space during normal drafting.

The pattern also avoids domain drift. The renderer only partitions returned rows for display; the core quality evaluator remains the source of truth for severities, blocker semantics, and optional interference checks.

## When to Apply

- A validation or quality panel has many successful checks that are useful for auditability but noisy during routine editing.
- A compact authoring surface embeds the same validation UI in more than one context, such as `/extract/$id` and `/process`.
- The panel mixes hard blockers with advisory warnings and successful checks.
- Contextual help sits next to the panel and needs to explain the current interaction model.

## Examples

Before, every quality row rendered as a full stacked checklist item:

```tsx
{quality.checks.map((check) => (
  <div className={`qc qc--${check.severity}`} data-testid={`cb-qc-${check.id}`}>
    <Icon name={iconName} />
    <span>{check.message}</span>
  </div>
))}
```

After, the default state is a summary plus actionable rows:

```tsx
<div
  id="cb-quality-summary"
  role="status"
  aria-live="polite"
  data-severity={qualitySummary.severity}
>
  <Icon name={qualitySummary.icon} />
  <strong>{qualitySummary.label}</strong>
  <span>{qualitySummary.meta}</span>
</div>

{actionable.map(renderQualityRow)}

{passed.length > 0 ? (
  <>
    <button
      type="button"
      data-testid="cb-quality-toggle-passed"
      aria-expanded={showPassedChecks}
      aria-controls="cb-quality-passed"
      onClick={() => setShowPassedChecks((value) => !value)}
    >
      {showPassedChecks ? "Hide passed" : `Show ${passed.length} passed`}
    </button>
    {showPassedChecks ? <div id="cb-quality-passed">{passed.map(renderQualityRow)}</div> : null}
  </>
) : null}
```

Tests should cover display density as well as quality semantics:

- Standalone `CardBuilder` tests for blocked, warning-only, clean, and mixed blocker-plus-warning states.
- Assertions that passed rows are unmounted until disclosure expansion.
- Embedded process-queue component coverage so route-specific layout does not regress.
- Electron coverage for the process-queue card builder when the user creates a card from an extract.

## Related

- [Embedded active card detail in extract workspace](../ui-bugs/embedded-active-card-detail-in-extract-workspace.md) - direct adjacent guidance for shared card surfaces inside extract workflows.
- [Active card rows should open a protected card detail surface](../ui-bugs/active-card-rows-open-card-detail-surface.md) - predecessor for targeted card surfaces and reveal/source-context safety.
- [Battle-testing matrix and test-hardening execution for core app surfaces](../architecture-patterns/test-audit-driven-battle-testing.md) - testing guidance for help surfaces and cross-context regression coverage.
- [Test operation-log and IPC invariants for extract->card mutation paths](../architecture-patterns/extract-card-ipc-invariant-test-hardening.md) - relevant when a card-builder change touches card creation, source lineage, IPC, or persistence semantics.
