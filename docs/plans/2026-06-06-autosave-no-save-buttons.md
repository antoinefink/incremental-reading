---
title: Autosave Text Surfaces and Remove Redundant Save Buttons
type: refactor
status: completed
date: 2026-06-06
---

# Autosave Text Surfaces and Remove Redundant Save Buttons

## Summary

Editable reading, distillation, and review text should persist without a user-facing Save button.
This plan removes redundant Save controls from text-editing surfaces that already autosave or should
autosave, while keeping semantic actions such as import, capture, create, and triage decisions.

## Problem Frame

Manual Save buttons make incremental reading feel like a form workflow. The app's core editing
surfaces are durable working material: source bodies, extract bodies, synthesis notes, card repairs,
and remediation notes. Users should be able to edit, navigate away, restart, and trust that the
latest text landed in the local SQLite document or card tables.

## Requirements

- R1. Source, extract, synthesis, review-repair, and remediation text edits persist through
  debounced autosave or flush-on-close behavior without a visible Save button.
- R2. Removing Save controls must not remove semantic commands that create, import, capture,
  dismiss, test credentials, trim, advance stages, convert cards, or confirm destructive actions.
- R3. Existing lineage-preserving document save paths must remain intact: text saves continue to
  update `documents`, `document_blocks`, and `operation_log` through typed app APIs.
- R4. Card text edits that were previously confirmed through Save must have an explicit autosave
  trigger that persists the latest prompt, answer, cloze, or context body before the editor closes.
- R5. Help copy and tests must stop teaching users that manual Save is required for extract editing.
- R6. Autosave should not add visible "Saving..." / "Saved" chips; autosave is the baseline
  behavior, not a separate UI state.

## Key Technical Decisions

- **Save removal is scoped to edit confirmation:** Buttons that say Save but commit ordinary text
  edits are redundant. Buttons whose product meaning is "capture this page", "create this item",
  "save for later", or "save and test a credential" are semantic and stay.
- **Reuse existing mutation commands:** The change should not add IPC channels or schema. Existing
  commands already cover `documents.save`, `extracts.rewrite`, `cards.update`, and remediation
  mutations.
- **Autosave on settled edits, flush on exit:** Long-form editors use debounced persistence; compact
  repair/remediation forms can persist on field blur, editor close, or action transition so the
  last edit cannot be lost.

## Implementation Units

### U1. Extract Distillation Save Removal

- **Goal:** Remove Save from full extract and inline process extract toolbars, preserving autosave
  and Trim.
- **Files:** `apps/web/src/reader/ExtractView.tsx`,
  `apps/web/src/reader/ExtractView.test.tsx`, `apps/web/src/pages/queue/ProcessQueue.tsx`,
  `apps/web/src/pages/queue/ProcessQueue.test.tsx`, `apps/web/src/pages/queue/process-queue.css`.
- **Patterns:** Keep using `useDocument.save` for debounced body persistence and `extracts.rewrite`
  only for explicit Trim cleanup.
- **Test scenarios:** Extract surfaces no longer render Save; editing still calls the debounced
  document save path; Trim still rewrites cleaned text.

### U2. Compact Card Repair and Remediation Autosave

- **Goal:** Replace Save buttons in card repair/remediation edit forms with autosave/flush behavior
  that persists field changes without requiring a button click.
- **Files:** `apps/web/src/review/ReviewRepairBar.tsx`,
  `apps/web/src/review/ReviewRepairBar.test.tsx`,
  `apps/web/src/maintenance/LeechRemediation.tsx`,
  `apps/web/src/maintenance/LeechRemediation.test.tsx`.
- **Patterns:** Keep the existing typed mutations; trigger them from blur/close/action transitions
  and guard against empty or unchanged writes.
- **Test scenarios:** Editing prompt/answer/cloze/context persists without clicking Save; unchanged
  forms do not write; existing cancel/close behavior remains predictable.

### U3. Help Copy and Regression Search

- **Goal:** Remove user-facing instructions that imply extract edits need manual Save.
- **Files:** `apps/web/src/help/help-bodies.ts`, relevant tests under `apps/web/src`.
- **Patterns:** Update text to say edits autosave and Trim saves cleaned output.
- **Test scenarios:** Searches for extract-edit Save UI find no redundant buttons; semantic Save
  strings remain for triage/import/capture/settings where the word is part of the action.

## Scope Boundaries

In scope:

- Text/body editing surfaces used during incremental reading and review.
- Tests that prove autosave/no-Save behavior for those surfaces.
- Help copy that directly describes the removed buttons.
- Autosave/saved status chips on text-editing and settings surfaces.

Out of scope:

- Renaming semantic commands such as "Save for later", "Save page", "Save selection", or
  credential "Save & test" flows.
- Schema, migrations, IPC additions, or database path changes.
- A visible "Saving..." or "Saved" status replacement.

## Verification

- Run targeted Vitest suites for changed surfaces.
- Run `pnpm typecheck`.
- Run `pnpm test` if targeted suites and typecheck are green.

Completed:

- `pnpm typecheck`
- `pnpm test`
- `pnpm lint` (passes with existing non-null assertion warnings outside this change)
- `git diff --check`
- Follow-up removal of autosave status chips committed separately after the initial edit-surface
  Save-button removal.

Blocked:

- Relevant Electron E2E was attempted, but the sandbox rejected the local dev server port bind
  escalation needed for `pnpm e2e`. The rejected follow-up suite covered process queue, extract
  review, source reader, review edit, settings, synthesis notes, and media clip.
