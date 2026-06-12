---
title: "feat: T109 maturity surfaces"
type: "feat"
date: "2026-06-12"
---

# feat: T109 maturity surfaces

## Summary

T109 turns the T108 topic knowledge-state receipt into visible surfaces: concept drill-ins, topic inspectors, analytics concept retention, and Home graduation lines. The renderer uses `appApi.getTopicKnowledgeState`, backed by `window.appApi.analytics.topicKnowledgeState`, and T096 targeted review modes; it does not add new analytics tables or renderer-side maturity math.

---

## Problem Frame

Part III needs receipts before automation. T108 can already compute funnel ratios, stability buckets, retention-vs-target, staleness flags, and current graduation candidates, but users cannot see those receipts where they make decisions. T109 closes that display gap without changing how maturity is computed.

---

## Requirements

- R1. Selecting a concept in `/concepts` shows its knowledge-state panel next to the existing member drill-in and retention editor.
- R2. Inspecting a topic element shows its topic knowledge-state panel in the Inspector, which is the current topic detail surface.
- R3. `/analytics` shows a concept-level retention and maturity view, sorted toward concepts needing attention, and the old deferred concept-retention comment is removed.
- R4. Home shows quiet graduation receipt lines for current newly visible graduation events, with links to the corresponding concept or topic panel.
- R5. Graduation lines do not repeat indefinitely; an explicit acknowledgement path records observed per-subject graduation status so Home emits a receipt when a subject transitions from not-graduated to graduated.
- R6. Weak or near-graduation subjects offer a T096 subset review entry using existing review-mode selectors, with no new review session type.
- R7. Every surface renders loading, empty, insufficient-evidence, error, graduated, and needs-attention states without hiding unrelated daily or analytics data, and loading states stay isolated to the maturity or receipt region.
- R8. Renderer code only formats and routes already-computed data; maturity aggregation, event filtering, and settings persistence stay behind typed desktop/local-db seams.
- R9. New maturity and receipt controls remain keyboard-operable, screen-reader labeled, and responsive within the desktop shell.

---

## Key Technical Decisions

- **Use the existing receipt as the source of truth:** `TopicKnowledgeStateQuery` remains the only maturity calculator. React components may format percentages and choose copy, but must not recompute funnel ratios, retention deltas, graduation status, or review subsets.
- **Treat the Inspector as the topic page:** the current router has no `/topic/$id` route, and topic elements already surface through selection plus the Inspector. Adding a route would broaden T109 beyond display wiring.
- **Make concept selection URL-addressable:** `/concepts` should accept a loose `conceptId` search param so Home graduation links can open the matching concept panel without inventing another concept detail route.
- **Suppress current-state graduation receipts through explicit acknowledgement:** T108 emits deterministic current candidates, not historical crossing rows. `dailyWork.summary` stays side-effect-free and returns unacknowledged observed transitions; Home acknowledges only the event IDs it rendered through a narrow typed command. The observed setting stores subject id, subject type, last observed status, threshold version, and timestamp so re-graduation after regression can surface again.
- **Use existing review modes for action:** concept subjects use `{ kind: "concept", conceptId }`; topic subjects use `{ kind: "branch", rootId: topicId }`. `ReviewModeButton` already hides empty or failed subsets.

---

## Scope Boundaries

- T109 does not change maturity thresholds, graduation math, retention target resolution, or concept/topic aggregation semantics from T108.
- T109 does not create stored graduation history, notification tables, new review session types, or new scheduler behavior.
- T109 does not build the weekly ledger or integrity session; T110 composes these receipts into a scheduled ritual.

---

## High-Level Technical Design

```mermaid
flowchart TB
  T108[TopicKnowledgeStateQuery] --> Bridge[window.appApi.analytics.topicKnowledgeState]
  Bridge --> Panel[KnowledgeStatePanel]
  Panel --> Concepts[/concepts selected concept]
  Panel --> Inspector[topic Inspector]
  Bridge --> Analytics[/analytics concept retention]
  T108 --> DailyComposer[daily graduation composer]
  Settings[settings observed graduation state] --> DailyComposer
  DailyComposer --> Summary[dailyWork.summary]
  Summary --> Home[Home graduation receipts]
  Home --> Ack[dailyWork.ackGraduationEvents]
  Ack --> Settings
  Panel --> ReviewMode[T096 ReviewModeButton]
```

The reusable panel is presentational. The new trusted-side behavior is an observed-transition receipt filter for current graduation candidates. Summary reads do not write; only Home acknowledgement updates the settings-backed observed state.

---

## Implementation Units

### U1. Shared maturity panel

- **Goal:** Build a reusable renderer component for one T108 subject.
- **Requirements:** R1, R2, R3, R6, R7, R8, R9.
- **Dependencies:** none.
- **Files:** create `apps/web/src/analytics/KnowledgeStatePanel.tsx`; create `apps/web/src/analytics/KnowledgeStatePanel.test.tsx`; modify `apps/web/src/analytics/analytics.css`.
- **Approach:** Render funnel ratios, stability buckets, measured retention vs target, direct concept target where present, staleness/reverify flags, and graduation state from `TopicKnowledgeStateSubject`. Keep copy calm and compact. Add an optional review CTA prop that maps concept subjects to concept review and topic subjects to branch review. Primary metrics are funnel status, retention delta, and graduation state; secondary buckets wrap or collapse below them in narrow panels.
- **Patterns to follow:** `apps/web/src/analytics/PriorityIntegrityPanel.tsx`; `apps/web/src/review/ReviewModeButton.tsx`; `apps/web/src/components/inspector/primitives.tsx`.
- **Test scenarios:** graduated concept renders ratios, mature bucket, retention target, and no weak CTA; weak concept renders attention flags and a concept `ReviewModeButton`; insufficient-evidence subject renders a calm empty state; topic subject maps the review CTA to a branch selector; loading reserves stable panel space without replacing surrounding content; metric groups have accessible labels.
- **Verification:** The component has no `appApi` calls, no scheduler math, and all values come from props.

### U2. Concept and topic surface wiring

- **Goal:** Put the maturity panel where users inspect concepts and topics.
- **Requirements:** R1, R2, R6, R7, R8, R9.
- **Dependencies:** U1.
- **Files:** modify `apps/web/src/concepts/ConceptsScreen.tsx`; modify `apps/web/src/concepts/ConceptsScreen.test.tsx`; modify `apps/web/src/concepts/concepts.css`; modify `apps/web/src/components/inspector/Inspector.tsx`; modify `apps/web/src/components/inspector/Inspector.test.tsx`; modify `apps/web/src/router.tsx` only if a search-param validation helper is required.
- **Approach:** Fetch `appApi.getTopicKnowledgeState({ subjectType: "concept", subjectId })` when a concept is selected and render the first returned subject below the existing retention editor before the member list so it stacks predictably in the center column. Read and write a `conceptId` search param so external links can select a concept; wait for the concept list, select only known IDs, and replace unknown IDs with the normal no-selection state. For topic elements, fetch `subjectType: "topic"` from the Inspector and render below topic rest controls.
- **Patterns to follow:** `ConceptRetentionEditor` refresh behavior; Inspector topic fallow section; `ReviewModeButton` count-owned hiding.
- **Test scenarios:** selecting a concept fetches subject-specific state and renders the panel; `/concepts?conceptId=...` preselects and loads the panel; unknown `conceptId` clears to the no-selection state without fetching maturity; selecting a topic in the Inspector renders topic maturity; maturity read failure shows an isolated error without clearing members or inspector properties; keyboard focus remains on the selected concept or topic region after panel load.
- **Verification:** No concept/topic maturity data is derived from member lists or Inspector data.

### U3. Analytics concept retention view

- **Goal:** Replace the deferred concept-retention stub with a concept maturity panel list.
- **Requirements:** R3, R7, R8, R9.
- **Dependencies:** U1.
- **Files:** modify `apps/web/src/analytics/AnalyticsScreen.tsx`; modify `apps/web/src/analytics/AnalyticsScreen.test.tsx`; modify `apps/web/src/analytics/analytics.css`.
- **Approach:** Extend the trusted T108 read to support an attention-first concept ordering that computes status and retention delta before applying the display cap. Load `appApi.getTopicKnowledgeState({ subjectType: "concept", limit: 12, order: "needs_attention" })` alongside existing analytics reads with isolated error state. Render compact concept rows using shared panel formatting.
- **Patterns to follow:** `PriorityIntegrityPanel` error isolation and `ReviewActivityHeatmap` stale request guard.
- **Test scenarios:** analytics requests concept maturity with attention-first ordering and displays concept retention rows; a rejected maturity read leaves the main analytics metrics and priority integrity panel visible; loading is confined to the concept-retention panel; the deferred comment is gone.
- **Verification:** Analytics still degrades gracefully outside desktop and does not block `appApi.getAnalytics()`.

### U4. Daily graduation observed-transition receipts

- **Goal:** Surface observed graduation crossings in the daily summary without repeating a stable current-state candidate forever.
- **Requirements:** R4, R5, R7, R8, R9.
- **Dependencies:** none.
- **Files:** modify `packages/local-db/src/daily-work-query.ts`; modify `packages/local-db/src/daily-work-query.test.ts`; modify `packages/local-db/src/settings-repository.ts` only if a helper keeps observed-state parsing local; modify `apps/desktop/src/shared/contract.ts`; modify `apps/desktop/src/shared/contract.test.ts`; modify `apps/desktop/src/main/db-service.ts`; modify `apps/desktop/src/main/ipc.ts`; modify `apps/desktop/src/main/ipc.test.ts`; modify `apps/desktop/src/preload/index.ts`; modify `apps/desktop/src/preload/index.test.ts`; modify `apps/web/src/lib/appApi.ts`; modify `apps/web/src/lib/appApi.test.ts`; modify `apps/web/src/pages/queue/QueueScreen.test.tsx`; modify `apps/web/src/pages/queue/ProcessQueue.test.tsx`.
- **Approach:** Compose T108 graduation candidates in the trusted daily summary path and compare them to a settings-backed observed state such as `ui.observedGraduationState`. Return at most a small capped list whose previous observed state was not graduated. Add `dailyWork.ackGraduationEvents({ eventIds })` to record only IDs Home actually rendered. Keep settings writes outside `operation_log`, matching existing settings behavior.
- **Patterns to follow:** `SettingsRepository` typed JSON settings; daily-work query shape; appApi fallback behavior for non-desktop mode.
- **Test scenarios:** daily summary returns unacknowledged graduation events without writing; Queue and ProcessQueue reads do not acknowledge events; Home acknowledgement suppresses the same current event on later reads; graduated-to-needs_attention-to-graduated can surface again after observed state changes; acknowledgement failure leaves the receipt visible on next read; all existing `DailyWorkSummaryResult` fixtures include an empty `graduationEvents` list unless testing receipts; malformed contract payloads are rejected.
- **Verification:** Summary reads are side-effect-free, no renderer localStorage is used, and acknowledgement is a narrow typed settings update.

### U5. Home graduation lines and link-through

- **Goal:** Render quiet daily graduation receipts and route to the relevant maturity panel.
- **Requirements:** R4, R5, R7, R9.
- **Dependencies:** U2, U4.
- **Files:** modify `apps/web/src/pages/home/HomeScreen.tsx`; modify `apps/web/src/pages/home/HomeScreen.test.tsx`; modify `apps/web/src/pages/home/home.css`.
- **Approach:** Render a compact receipt section when `dailyWork.graduationEvents` is non-empty. Concept events navigate to `/concepts?conceptId=<id>`. Topic events select the topic and open the existing host route with a URL-owned selected element when available; if no durable topic host exists, topic graduation events render without a destructive link and the limitation is documented for T110. Call `dailyWork.ackGraduationEvents` only after the receipt section has rendered.
- **Patterns to follow:** Home partial-read handling, quick-nav tile styling, and non-gamified maintenance nudges.
- **Test scenarios:** zero events hide the section; one event renders a calm line; clicking a concept event navigates to selected `/concepts`; acknowledgement happens after render and failures are non-blocking; read errors do not disable queue/session controls; receipt links and buttons have accessible names.
- **Verification:** Copy stays receipt-like and contains no streaks, confetti, or gamified badges.

### U6. Electron end-to-end coverage

- **Goal:** Prove the T109 surfaces work through the real desktop bridge.
- **Requirements:** R1, R2, R3, R4, R6, R7, R8, R9.
- **Dependencies:** U1, U2, U3, U4, U5.
- **Files:** modify `tests/electron/analytics.spec.ts`; modify `tests/electron/home.spec.ts`; modify `tests/electron/review-modes.spec.ts` only if existing review-mode coverage does not exercise the new weak-subject CTA.
- **Approach:** Seed or create a deterministic concept/topic with enough T108 state to render a panel and a current graduation receipt. Verify `/analytics` shows concept maturity, `/concepts?conceptId=...` opens the panel, the topic Inspector shows topic maturity, Home shows and then suppresses the receipt after acknowledgement, and a weak subject CTA reaches `/review?mode=...`.
- **Patterns to follow:** existing analytics T108 bridge smoke in `tests/electron/analytics.spec.ts`; Home fixed-clock `asOf` pattern; T096 review-mode URL assertions.
- **Test scenarios:** seeded graduated concept appears in analytics, concept drill-in, topic Inspector, and Home; Home click-through opens the selected concept panel; repeated Home load suppresses the same graduation line only after acknowledgement; weak concept review CTA starts targeted review through existing review mode.
- **Verification:** The E2E confirms `window.appApi.analytics.topicKnowledgeState` exists and no generic DB API is exposed.

---

## Risks & Dependencies

- T108 events are current-state candidates, so suppression must not pretend to be historical graduation tracking. T110 can later decide whether weekly ledgers need richer receipt history.
- The Inspector-hosted topic panel is pragmatic but not a full topic route. If later roadmap work adds topic pages, this panel should move or be reused there.
- E2E fixtures may need direct trusted-side seeding because demo data is not guaranteed to include a graduated subject.

---

## Sources & Research

- `docs/tasks/M22-receipts.md` defines T109 deliverables and the M22 read-model constraints.
- `docs/solutions/architecture-patterns/topic-knowledge-state-read-model.md` defines T108 aggregation semantics and warns against stored maturity history.
- `docs/solutions/architecture-patterns/review-activity-heatmap-read-model.md` and `docs/solutions/architecture-patterns/priority-integrity-read-model.md` provide analytics panel and async-read patterns.
- `docs/solutions/ui-bugs/daily-work-read-model-inbox-only-routing.md` keeps daily action routing backend-owned and separate from advisory receipts.
- `apps/web/src/analytics/PriorityIntegrityPanel.tsx`, `apps/web/src/concepts/ConceptsScreen.tsx`, `apps/web/src/components/inspector/Inspector.tsx`, and `apps/web/src/review/ReviewModeButton.tsx` are the main local patterns to follow.
