# M17 — Quality & maintenance (T085–T086)

Detailed, buildable specs for the **quality & maintenance** half of M17. This file covers
**T085 (leech remediation workflow)** and **T086 (minimum-information-principle checks)** — the
two card-quality tasks. T083 (source-yield analytics) and T084 (extract-stagnation analytics)
are the *analytics* half of M17 and are specified in their own milestone spec file (generate
`tasks/M17-analytics.md` for them when their turn comes); they are referenced here only where
T085/T086 read the same substrate.

M17's quality work is almost entirely **queries + pure heuristics over EXISTING tables**, not new
schema. T085 composes the leech detection (T040) and the in-review repair actions (T038) into a
dedicated **remediation screen** for repeatedly-failing cards; the new compositions (split,
add-context, back-to-extract, lower-priority) are transactional, append `operation_log`, and keep
lineage intact. T086 extends the **existing** pure `evaluateCardQuality` (T035) with more
minimum-information-principle checks, surfaced as advisory warnings in the card builder before
activation.

The architecture is unchanged and non-negotiable (see [`../../CLAUDE.md`](../../CLAUDE.md) and the
roadmap header):

> The React **renderer** (`apps/web`) never touches SQLite, Node, or the filesystem. Every
> mutation flows React UI → typed client wrapper (`apps/web/src/lib/appApi.ts`) → preload bridge
> (`apps/desktop/src/preload/index.ts`) → validated IPC (Zod) on the main side
> (`apps/desktop/src/main/ipc.ts`) → the `DbService` (`apps/desktop/src/main/db-service.ts`) →
> `packages/local-db` repositories + `packages/scheduler`/`packages/core` domain → SQLite. Every
> meaningful mutation runs in **one transaction** and appends an **`operation_log`** row; deletes
> are soft (`deleted_at`). **Card-quality heuristics are pure functions in `packages/core`**, never
> SQL or React logic. **FSRS scheduling applies to cards only**; leech is a *card* concern, extract
> stagnation is an *attention* concern — the two-scheduler split holds.

> **The FSRS-vs-attention split (load-bearing — read before touching either task).** A **leech**
> is a CARD quality attribute, derived from `review_states.lapses` (the FSRS half). A card's
> remediation either fixes the card (rewrite/split/add-context) or removes it from FSRS rotation
> (suspend/delete) or sends the user *back up the lineage* to the originating extract (an
> ATTENTION item) to re-distill it. **T085 never reschedules a card through the attention
> heuristic, and never schedules an extract through FSRS.** A "back-to-extract" action operates on
> the parent extract via the attention scheduler; a "lower-priority" action is the universal
> priority write (T027), unchanged.

> **Operation-log discipline.** `OPERATION_TYPES` (`packages/core/src/operation-log.ts`) is a
> **closed, fixed set** ("a rename is a migration"). T085's compositions map onto the EXISTING ops,
> **no new op types**: a card body edit / split → `update_element` (+ `create_element`/
> `create_card`/`add_relation` for the new sibling); add-context → `update_element`; lower-priority
> → `update_element` (the existing `ElementRepository.setPriority` path); suspend / mark-leech /
> un-leech → `update_element`; delete → `soft_delete_element`; a back-to-extract reschedule →
> `update_element` + `reschedule_element` (the existing `ExtractService` attention path). **T086
> is read-only** — a pure heuristic, no mutation, no op.

Read first:
- [`../scheduling-and-priority.md`](../scheduling-and-priority.md) — the **two-scheduler split**
  (FSRS for cards; attention for sources/topics/extracts); lapses → leech; priority is first-class;
  high-priority fragile memory is protected.
- [`../../CLAUDE.md`](../../CLAUDE.md) — **"Card-quality rules"** (the full minimum-information
  list T086 implements: multiple facts, long lists/sets, ambiguous pronouns, missing source, giant
  cloze, list/set too large, similar/interfering card, time-sensitive claim with no date/version),
  **"Review rules"** (mark leech / suspend / delete / add context / open source), and the
  **architectural rule** that card-quality heuristics live in `packages/core`, not React.
- [`../domain-model.md`](../domain-model.md) — card lineage `card → source location → source` and
  `card.parentId → extract` (the originating extract); stage vs status; soft-delete.
- [`../design-system.md`](../design-system.md) — `screen-review` repair row + leech `Banner`;
  `Status` (`leech`/`suspended`); the `qc` quality checklist (`design/kit/app/screen-builder.jsx`
  `QualityCheck`); the maintenance/analytics surface.

### What already exists (inspect before building — do not duplicate)

T040 (leech) and T035 (card-quality) + T038 (in-review repair) already built most of the substrate
M17's quality tasks compose. **Inspect these first.**

- **Leech detection + persistence (T040) — complete:**
  - `packages/scheduler/src/leech.ts`: `LEECH_LAPSE_THRESHOLD = 4` and
    `isLeech(state: Pick<ReviewState,"lapses">, threshold?): boolean` — the SINGLE source of the
    leech rule. Pure, reused by the live grade path + the cleanup reads.
  - `packages/db/src/schema/cards.ts`: the durable `cards.is_leech` boolean flag
    (`integer("is_leech", { mode: "boolean" }).notNull().default(false)`) + `cards_is_leech_idx`.
    Set in the SAME transaction as a lapsing grade by `ReviewRepository.recordReview` (which
    consults `isLeech`), gated on "added a lapse" so a manual un-leech is respected.
  - `packages/local-db/src/review-repository.ts`:
    `listLeechCards(): LeechCard[]` (joins `cards.is_leech = 1` to live `card` elements + their
    `review_states` lapse/reps/lastReviewedAt, most-lapsed first, soft-deleted excluded,
    suspended INCLUDED), `isCardLeech(id)`, and `setCardLeech(id, leech)` (the durable flip,
    logging `update_element`). `LeechCard = { element, card, lapses, reps, lastReviewedAt }`.
- **In-review repair (T038) — complete and is the action substrate T085 reuses:**
  - `packages/local-db/src/card-edit-service.ts` `CardEditService`: `updateBody(id, patch)`
    (edit prompt/answer/cloze, `update_element`, never touches `review_states`/lineage),
    `suspend(id)` (status `suspended`, `update_element`), `delete(id)` (soft-delete,
    `soft_delete_element`), `flag(id, flagged, reason?)` / `flagState(id)` / `isFlagged(id)`
    (op-log-derived flag, no column).
  - `apps/web/src/review/ReviewRepairBar.tsx`: the in-review repair row + inline editor + context
    drawer, wired to `appApi.updateCard` / `suspendCard` / `deleteCard` / `flagCard` /
    `markLeechCard` / `retireCard`. T085's screen reuses the same `appApi.*` calls (no second
    mutation path).
  - `apps/web/src/maintenance/LeechCleanup.tsx` + `leech-cleanup.css`: the **minimal** T040 cleanup
    view (rewrite/suspend/delete/un-leech), backed by `appApi.reviewLeeches()`
    (`review:leeches` → `ReviewLeechesResult { cards: LeechSummary[] }`). **T085 promotes this into
    the full remediation workflow** (adds split / add-context / open-source / back-to-extract /
    lower-priority) — extend it in place rather than building a second screen.
- **The `cards.*` / `review.*` typed seam — complete:** channels (`apps/desktop/src/shared/`
  `channels.ts`): `cardsUpdate`, `cardsSuspend`, `cardsDelete`, `cardsFlag`, `cardsMarkLeech`,
  `cardsRetire`/`cardsUnretire`/`cardsRetired`, `reviewLeeches`. Contract
  (`apps/desktop/src/shared/contract.ts`): the request schemas + result types
  (`CardsUpdateRequest`/`Result`, `LeechSummary`, `ReviewLeechesResult`, …) +
  `contract.test.ts`. The universal priority write `elements:setPriority`
  (`ElementsSetPriorityRequestSchema`, T027) is the lower-priority path. Renderer mirror in
  `apps/web/src/lib/appApi.ts` (`updateCard`/`suspendCard`/`deleteCard`/`flagCard`/`markLeechCard`/
  `setPriority`/`reviewLeeches`).
- **Card lineage to the extract — present:** `ReviewRepository.createCard`/`createCardWithin`
  stores `parentId` = "the extract this card was distilled from" (and `sourceLocationId` for the
  source paragraph). T085's **back-to-extract** resolves `card.parentId` (the originating extract,
  an attention item).
- **Extract attention actions (T024) — present:** `packages/local-db/src/extract-service.ts`
  `ExtractService`: `advanceStage`/`setStage`, `rewrite`/`trim`, `postpone` (records a postpone
  marker, `reschedule_element`), `delete`. **None of these reschedule to due-now** — `setStage`
  reschedules to a FUTURE stage-interval (`:161`) and `postpone` pushes further out (`:206`). T085's
  back-to-extract **reactivates** the parent extract to **due-now** through the EXISTING generic
  attention reschedule seam `ElementRepository.reschedule`/`rescheduleWithin` (`:267`/`:285`, logs
  `reschedule_element` with a pre-image) — it does NOT invent extract rescheduling.
- **Card-quality heuristics (T035) — complete and DESIGNED TO GROW:**
  `packages/core/src/card-quality.ts` `evaluateCardQuality(input: CardQualityInput):
  CardQualityReport`. Pure, DB-free, framework-agnostic. Existing check ids (`CardQualityCheckId`):
  `empty` (block), `prompt-too-long`, `answer-too-long`, `multiple-clozes`, `ambiguous-pronoun`,
  `missing-source` (+ T072 `code-too-long`, T075 `long-audio-clip`). Thresholds are named consts
  (`PROMPT_MAX_CHARS=110`, `ANSWER_MAX_CHARS=90`, `CLOZE_MAX_WORDS=40`, `MAX_CLOZE_DELETIONS=1`).
  Severity contract: `ok` < `warn` < `block`; **only truly hollow cards `block`**, everything else
  is advisory `warn`. `CardQualityReport = { checks, hasBlocker, hasWarning }`.
  `packages/core/src/card-quality.test.ts` (372 lines) is the test pattern T086 extends
  (`reportFor(...).checks.find(c => c.id === id)`).
  `apps/web/src/reader/CardBuilder.tsx` runs `evaluateCardQuality` live on every edit and renders
  the ordered rows as the `qc` checklist (`data-testid` `cb-qc-<id>`); `canCreate =
  !quality.hasBlocker`. **T086's new checks appear automatically once added to the report** — the
  builder needs no structural change, only the new rows render.

### What M17 quality must add (the gaps)

- **No full remediation screen.** Today `LeechCleanup.tsx` offers only rewrite/suspend/delete/
  un-leech. T085 adds **split**, **add-context**, **open-source**, **back-to-extract**, and
  **lower-priority** — the roadmap's full repair set — plus a per-card lapse/source/lineage summary.
- **No card-splitting composition.** There is `CardService.createFromExtract` (authoring a fresh
  card from an extract) and `ReviewRepository.createCard`/`createCardWithin` (with
  `parentId`/`sourceLocationId`), but **no "split this failing card into two sibling cards"**
  composition. T085 adds one (a transactional service method) that preserves lineage + groups the
  results as siblings — reusing `ReviewRepository.createCardWithin` + the existing
  `sibling_group` relation / `siblingGroupId` path (the actual reuse target).
- **No add-context composition.** `CardEditService.flag` records markers in the op payload, but
  there is no durable per-card *context note* append. T085 adds an **add-context** action
  (append a clarifying note to the card body / a context field) that is op-log-derived or a body
  edit — **no new column** (mirror the `flag` op-payload pattern).
- **The minimum-information checks are incomplete.** T035 ships 6 prose checks; CLAUDE.md's
  card-quality list also wants: **multiple facts in one card**, **long lists/sets**, **vague
  pronouns** (beyond leading-pronoun), **unsupported claims**, **similar/interfering answers**,
  **no/outdated source**, and **oversized clozes**. T086 adds the missing ones as pure checks.

Build order: T086 (pure, isolated) and T085 (composition + UI) are independent and may land in
either order. T085's split/add-context build on T038's `cards.*` seam; T086 builds on T035's
`evaluateCardQuality`. Neither needs the T083/T084 analytics half.

---

## T085 — Leech remediation workflow

- **Status:** `[ ]`  · **Depends on:** T040
- **Roadmap line:** Done when: a repair screen offers split/add-context/open-source/
  back-to-extract/lower-priority/suspend/delete for repeated failures.

### Goal

A dedicated **leech remediation screen** turns the minimal T040 cleanup view into the full repair
workflow for repeatedly-failing cards. For each leech the user can: **split** it into two atomic
sibling cards (when it crams multiple facts), **add context** (a clarifying note so the prompt is
answerable), **open source** (jump to the originating paragraph), **go back to the extract** (send
the parent extract back into the attention queue to re-distill it), **lower its priority** (so a
weak card stops costing protected review time), **suspend** it (out of rotation, recoverable), or
**delete** it (soft, recoverable). Every action is one transaction + the correct existing
`operation_log` op, preserves `card → source location → source` and `card → extract` lineage, and
never destroys the card's `review_logs` history. The new compositions (split, add-context,
back-to-extract) are the only new domain logic; open-source, lower-priority, suspend, delete reuse
existing paths.

### Context to load first

- Reference: `CLAUDE.md` "Review rules" (mark leech / suspend / delete / add context / open
  source) + "Card-quality rules" (split a multi-fact card); `scheduling-and-priority.md`
  (two-scheduler split; protect high-priority fragile memory — a leech is the opposite, a
  *low-value time sink*); `domain-model.md` (`card → extract` lineage via `parentId`;
  `sibling_group`; soft-delete).
- Existing code to inspect:
  - `apps/web/src/maintenance/LeechCleanup.tsx` (+ `leech-cleanup.css`) — **extend this in place**
    into the remediation screen; `apps/web/src/review/ReviewRepairBar.tsx` (the same action set to
    mirror, including the inline editor + context drawer).
  - `packages/local-db/src/review-repository.ts` (`listLeechCards`, `setCardLeech`, `createCard`/
    `createCardWithin` with `parentId`/`sourceLocationId`, `LeechCard`); `packages/local-db/src/`
    `card-edit-service.ts` (`updateBody`/`suspend`/`delete`/`flag`); `packages/local-db/src/`
    `card-service.ts` (`CardService.createFromExtract` + `siblingGroupId` grouping — the split
    reuses `ReviewRepository.createCardWithin` + this `sibling_group` grouping path);
    `packages/local-db/src/extract-service.ts` (`ExtractService.postpone`/`setStage`/
    `advanceStage` — existing attention actions, but note none reschedule to due-now) +
    `packages/local-db/src/element-repository.ts` (`reschedule`/`rescheduleWithin` `:267`/`:285` —
    the actual due-now reactivation seam the back-to-extract path uses on the ATTENTION scheduler);
    `packages/scheduler/src/leech.ts` (`LEECH_LAPSE_THRESHOLD`, `isLeech`).
  - The typed seam: `apps/desktop/src/shared/channels.ts` (`cardsUpdate`/`cardsSuspend`/
    `cardsDelete`/`cardsMarkLeech`/`elementsSetPriority`/`reviewLeeches` — and the new channels
    below), `apps/desktop/src/shared/contract.ts` (`LeechSummary`, `ReviewLeechesResult`,
    `ElementsSetPriorityRequestSchema`, the `cards.*` request/result types), `…/preload/index.ts`,
    `…/main/ipc.ts`, `…/main/db-service.ts`, `apps/web/src/lib/appApi.ts` (`reviewLeeches`,
    `updateCard`, `suspendCard`, `deleteCard`, `markLeechCard`, `setPriority`); the T022
    jump-to-source is the renderer hook `useNavigateToLocation`
    (`apps/web/src/reader/navigateToLocation.ts`) — NOT an `appApi` method.
- Invariants in play: leech actions are card-side (FSRS) except back-to-extract (attention side);
  split preserves lineage + groups siblings; add-context never destroys the body; lower-priority is
  the universal `elements.setPriority` (T027); all one transaction + the correct EXISTING op; the
  card's `review_logs` are never destroyed; the renderer holds only UI state — no SQL, no FSRS
  math, no lineage logic.

### Deliverables

- [ ] **Split composition** — a transactional `splitLeechCard`. **Placement note:** the split must
      validate each authored part with the SAME per-kind non-empty rule `CardEditService` uses, but
      `CardEditService.nextBodyForKind` is **private** (`card-edit-service.ts:199`) — so pick one of two
      shapes: (a) add `split` as a **method on `CardEditService`** (so it can call the private
      `nextBodyForKind` directly), or (b) put it on a small new
      `packages/local-db/src/card-remediation-service.ts` AND first **extract `nextBodyForKind` (or its
      non-empty-per-kind validation) into a shared exported pure helper** both services import — do not
      duplicate the rule. (Either way the validation logic stays single-sourced.)
      `split(cardId, parts: { prompt?; answer?; cloze? }[]) → { cards: CardWithElement[] }`.
      Given a failing card and 2+ authored atomic parts, it **creates one new card per part** with
      the SAME lineage as the original (`parentId` = the original's `parentId` extract,
      `sourceLocationId` = the original's source location, inherited priority + concepts/tags),
      groups all the resulting cards as **siblings** (mint/reuse a `siblingGroupId` via the
      existing `card-service.ts`/`element_relations.sibling_group` path so they don't appear
      back-to-back, T039), and **soft-deletes or suspends the original** (the user's choice;
      default: soft-delete the original — its `review_logs` history is preserved, recoverable from
      trash). All in ONE transaction; logs `create_element`/`create_card` for each new card,
      `add_relation` (`sibling_group`) for the grouping, and `soft_delete_element` (or
      `update_element` for suspend) for the original. Each new card starts a fresh
      `review_states` row (a split card is a NEW card to learn) — **never** copy the original's
      FSRS memory state. Validate each part is non-empty for its kind via the SAME `nextBodyForKind`
      non-empty-per-kind rule (per the placement note above: call the private method directly if
      `split` lives on `CardEditService`, else extract it to a shared exported helper first — never
      re-implement it).
- [ ] **Add-context composition** — `addContext(cardId, note: string) → { card }` (on the same
      remediation service): append a clarifying **context note** to the card so the prompt becomes
      answerable, WITHOUT a new column. Two acceptable storages (pick one, document it):
      (a) append the note to the card body's answer (a `update_element` body edit — visible on the
      card face), or (b) record it as a durable op-payload marker (`{ context: note }`) read back
      via an op-log scan (mirror `CardEditService.flagState`). Prefer (b) for a Q&A card whose
      answer must stay atomic, surfaced as a separate "context" line in review/inspector; document
      the choice. Logs `update_element`; never touches `review_states`/lineage. The card stays in
      rotation (context is a fix, not an exit) and may be un-leeched after the fix.
- [ ] **Back-to-extract composition** — `backToExtract(cardId) → { extract: Element | null }`
      (same service): resolve the card's `parentId` (the originating **extract**, an attention
      item). Send that extract **back into the attention queue** for re-distillation by rescheduling
      it to **due-now** via `ElementRepository.reschedule`/`rescheduleWithin`
      (`element-repository.ts:267`/`:285`, which logs `reschedule_element` with a pre-image for undo)
      using a `now`-ISO `dueAt` (status `scheduled`) — optionally wrapped in a thin new
      `ExtractService.reactivate` helper. **Note:** no existing `ExtractService` method reschedules to
      due-now — `setStage` (`extract-service.ts:161`) reschedules to a FUTURE stage-interval and
      `postpone` (`:206`) pushes further out — so do **not** reach for a `setStage(due-now)` path;
      go through `reschedule`/`rescheduleWithin` (attention op `reschedule_element`, NOT FSRS).
      Optionally suspend or soft-delete the leech card in the same transaction (the card
      is being replaced by re-distilled material) — default: **suspend** the card (recoverable). If
      the card has no live `parentId` extract (e.g. an Anki-imported card), return
      `{ extract: null }` and the screen disables the action. **This is the only T085 action that
      touches the attention scheduler** — it must never write `review_states` for the extract.
- [ ] **Extend `LeechSummary` with TWO additive read-only fields** — the current `LeechSummary`
      (`apps/desktop/src/shared/contract.ts:3028–3051`) carries `sourceTitle` + `sourceLocationLabel`
      but **neither `sourceLocationId` NOR `parentExtractId`**, so both are required adds (no schema
      change — both are resolved in `reviewLeeches`):
      - `parentExtractId: string | null` — resolved from the card's `parentId` **filtered to a live
        `extract` element** (null when the parent is missing/soft-deleted/not an extract, e.g. an
        Anki-imported card). The screen uses this purely to enable/disable the **Back to extract**
        action (`extractAvailable = parentExtractId != null`); the authoritative `{ extract: null }`
        guard still lives main-side in `backToExtract`.
      - `sourceLocationId: string | null` — the card's `sourceLocationId` (the **Open source** action
        below needs the id, not just the existing `sourceLocationLabel`); null when the card has no
        source location.
      Update `reviewLeeches` to resolve **both** (in `review-repository.ts`/`listLeechCards`) and
      update `contract.ts` + `contract.test.ts` for the two new fields.
- [ ] **Lower-priority** — reuse the EXISTING universal `elements.setPriority` (T027,
      `ElementsSetPriorityRequestSchema`) from the screen; no new command. Lowering a leech's
      priority (e.g. A→C) means the overload/sort logic (T076/T077) sacrifices it first — the
      intended outcome for a low-value time sink. Logs `update_element` (the existing path).
- [ ] **Open-source** — reuse the EXISTING T022 jump-to-source renderer hook
      `useNavigateToLocation` (`apps/web/src/reader/navigateToLocation.ts`) from the card's
      `sourceLocationId` (the **new** `LeechSummary.sourceLocationId` field added above — `LeechSummary`
      carries only `sourceLocationLabel`/`sourceTitle` today, so the id is one of the two required adds).
      No new mutation — it is renderer navigation.
- [ ] **Suspend / delete / un-leech** — reuse the EXISTING `cards.suspend`/`cards.delete`/
      `cards.markLeech` (already wired). The screen keeps these from the T040 view.
- [ ] **Typed seam for the new compositions** — add minimal channels + contract for the three new
      compositions only (split / add-context / back-to-extract), Zod-validated, following the
      `cards.*` pattern exactly:
      - channels (`channels.ts`): `cardsSplit` (`cards:split`), `cardsAddContext`
        (`cards:addContext`), `cardsBackToExtract` (`cards:backToExtract`).
      - contract (`contract.ts` + `contract.test.ts`): `cards.split({ cardId, parts:
        Array<{ kind: "qa"|"cloze"; prompt?; answer?; cloze? }>, originalDisposition?:
        "delete"|"suspend" }) → { cards: CardSummary[] }`; `cards.addContext({ cardId, note })
        → { card: CardSummary }`; `cards.backToExtract({ cardId, cardDisposition?:
        "suspend"|"delete"|"keep" }) → { extract: ElementSummary | null }`. Validate non-empty
        parts/note main-side.
      - preload (`preload/index.ts`): the new `cards` methods; IPC handlers (`ipc.ts`); `DbService`
        methods composing the remediation service; renderer client (`appApi.ts`):
        `splitCard`/`addCardContext`/`backToExtractCard`.
- [ ] **Promote `LeechCleanup.tsx` into the remediation screen** (rename to
      `LeechRemediation.tsx` or extend in place; keep the `/maintenance/leeches` route + nav entry
      + `data-testid="route-leech-cleanup"` stable, or add a redirect): per leech, show the lapse
      count + source + originating-extract lineage, and the full action row — **Rewrite** (inline
      editor, existing), **Split** (a small multi-part editor that authors 2 atomic cards from the
      original, then calls `splitCard`), **Add context** (a note field → `addCardContext`),
      **Open source** (existing jump), **Back to extract** (`backToExtractCard`, disabled when no
      live parent extract), **Lower priority** (an A/B/C/D control → `setPriority`), **Suspend**,
      **Delete**, **Not a leech** (un-leech, existing). Match the kit's repair-row styling
      (`rv-repair__btn`, `badge--leech`). Reuse `apps/web/src/review/ReviewRepairBar.tsx`'s editor/
      drawer markup where practical (one styling source).
- [ ] **Tests (Vitest, `packages/local-db`):**
      - `split`: a 2-part split creates 2 new cards each with the original's `parentId`/
        `sourceLocationId`/priority, grouped as siblings (`element_relations.sibling_group` /
        shared `siblingGroupId`), each with a FRESH `review_states` row (not the original's FSRS
        state), and soft-deletes (default) the original; logs `create_card` ×2 + `add_relation` +
        `soft_delete_element`; the original's `review_logs` survive; rejects an empty part.
      - `addContext`: appends/records the note (assert the chosen storage), logs `update_element`,
        leaves `review_states`/lineage untouched, and the card stays live.
      - `backToExtract`: reschedules the parent extract on the ATTENTION scheduler
        (`reschedule_element`, due-now, no `review_states` written for the extract), applies the
        chosen card disposition (default suspend), and returns the extract; returns
        `{ extract: null }` (and mutates nothing destructive) when the card has no live parent.
      - regression: `setPriority` on a leech lowers its numeric priority + logs `update_element`
        (the existing path still works from this screen).
- [ ] **Tests (Vitest, renderer component):** `LeechRemediation` renders the leeches from a mocked
      `reviewLeeches` payload with the full action row; Split opens the multi-part editor and calls
      `splitCard` with the authored parts; Add context calls `addCardContext`; Back to extract is
      disabled when the leech's `parentExtractId` is `null` (`extractAvailable === false`) and calls
      `backToExtractCard` otherwise; Lower priority calls `setPriority`; Suspend/Delete/Un-leech
      still work and refresh the list. Mock `window.appApi`.
- [ ] **Playwright E2E** (`tests/electron/leech-remediation.spec.ts`): seed (or grade to) a leech
      card with a parent extract + source location → open `/maintenance/leeches` → the card shows
      with its lapse count + the full action row → **split** it into two atomic cards → the two new
      sibling cards exist and the original is gone from the list → **back to extract** on a second
      leech sends its extract into the due queue and suspends the card → **lower priority** on a
      third → **restart the Electron app** → the split cards, the rescheduled extract, the lowered
      priority, and the suspensions all persist (computed from durable tables).

### Done when

- The leech remediation screen offers **split / add-context / open-source / back-to-extract /
  lower-priority / suspend / delete** (plus rewrite + un-leech) for repeatedly-failing cards; each
  action is one transaction + the correct EXISTING `operation_log` op; split + back-to-extract
  preserve `card → source location → source` and `card → extract` lineage; no action destroys the
  card's `review_logs`; suspend/delete/back-to-extract remove the card from the live deck; all
  survive **app restart**.
- The split/add-context/back-to-extract domain logic lives in `packages/local-db`
  (+ `packages/scheduler`/`packages/core` for any rule), **not** React; the renderer reaches it only
  through validated `cards.*` IPC. The two-scheduler split holds: only back-to-extract touches the
  attention scheduler, and it never writes `review_states` for the extract.
- `pnpm typecheck`, `pnpm test`, `pnpm lint`, and the remediation Playwright spec pass.

### Notes / risks

- **No new card-attribute migration if avoidable.** `is_leech` already exists (T040); split reuses
  `createCard`/`siblingGroupId`; add-context prefers the op-payload pattern (like
  `CardEditService.flagState`) over a new column. Only add a migration if add-context genuinely
  needs a durable `context` column — document the decision; prefer schema-churn-free.
- **A split card is a NEW card.** Never copy the original's `review_states` (stability/difficulty/
  reps/lapses) onto a split-out card — the user is re-learning re-formulated material. Fresh FSRS
  state via `createCard`'s normal path.
- **Back-to-extract is the only attention-side action** — it reactivates the *parent extract* (an
  attention item) via the EXISTING `ExtractService` reschedule path. Do not invent extract
  scheduling, and never give the extract a `review_states`/FSRS row (that would break the split).
- **Reuse, don't fork.** Open-source = T022 `navigateToLocation`; lower-priority = T027
  `elements.setPriority`; suspend/delete/rewrite/un-leech = T038/T040 `cards.*`. Only split,
  add-context, and back-to-extract are new compositions. Keep the screen a thin caller.
- The full automatic-suspend-on-leech behavior stays off (T040's "flag + warn" MVP); remediation is
  user-driven. Sibling burying (T039) already applies to the split-out cards via the shared
  `siblingGroupId` — no extra work.

---

## T086 — Minimum-information-principle checks

- **Status:** `[ ]`  · **Depends on:** T035
- **Roadmap line:** Done when: quality warnings extend to multiple facts, long lists, vague
  pronouns, unsupported claims, similar answers, no/outdated source, and oversized clozes.

### Goal

Extend the **existing** pure `evaluateCardQuality` (T035) with the remaining
minimum-information-principle heuristics so the card builder warns (advisory, never a hard block
unless the card is truly hollow) when a card violates "one fact per card, short and atomic, traced
to a current source": **multiple facts in one card**, **long lists/sets** (an answer that is a long
enumeration), **vague pronouns** (beyond the existing leading-pronoun check), **unsupported claims**
(an assertion with no source), **similar/interfering answers** (two cards whose answers are nearly
identical — likely to interfere), **no/outdated source** (a time-sensitive claim with no
date/version, or an explicitly stale source), and **oversized clozes** (a cloze body or per-deletion
span that asks for too much). All as **pure, DB-free functions in `packages/core`** — added to the
same `CardQualityReport` so the builder surfaces them automatically.

### Context to load first

- Reference: `CLAUDE.md` "Card-quality rules" (the authoritative list this task implements — copy
  the intent verbatim into the check messages); `concept.md`/`scheduling-and-priority.md`
  (minimum-information principle; time-sensitive claims rot — M18/T090 handles expiry, T086 only
  *warns* at authoring time).
- Existing code to inspect:
  - `packages/core/src/card-quality.ts` — **extend this file**: the `CardQualityCheckId` union, the
    `CardQualityInput` discriminated shape (`QaQualityInput`/`ClozeQualityInput` + the shared
    `AudioQualitySignals`), the named threshold consts (`ANSWER_MAX_CHARS`, `CLOZE_MAX_WORDS`, …),
    the `evaluateQa`/`evaluateCloze` helpers, `parseCloze`, `wordCount`/`leadingWord`/
    `leadsWithAmbiguousPronoun`, and the severity contract (`ok`/`warn`/`block`).
  - `packages/core/src/card-quality.test.ts` — the test pattern to extend
    (`reportFor(...).checks.find(c => c.id === id)`); each new check needs a fires/doesn't-fire pair.
  - `apps/web/src/reader/CardBuilder.tsx` — runs `evaluateCardQuality` live and renders every check
    row as `qc` (`data-testid` `cb-qc-<id>`); `canCreate = !quality.hasBlocker`. The new rows
    render with NO structural change.
- Invariants in play: the heuristics are PURE + deterministic (no NLP model, no DB, no network) so
  they run on every keystroke; they live in `packages/core`, never React; new checks are
  **advisory `warn`** (the minimum-information principle "informs; the user can still proceed") —
  they do NOT add a `block` (the only blocker stays the hollow-card check); the report shape only
  grows (new `CardQualityCheckId`s, no breaking changes to existing ids/messages).

### Deliverables

- [ ] **Extend `CardQualityCheckId`** with the new ids:
      `multiple-facts`, `long-list`, `vague-pronoun`, `unsupported-claim`, `similar-answer`,
      `outdated-source`, `oversized-cloze`. (Keep the existing ids/messages stable — T035's tests
      and the builder `data-testid`s depend on them.)
- [ ] **New named thresholds** (documented consts, beside the existing ones), e.g.:
      `MAX_FACTS_HINT` (multiple-facts: the answer contains ≥2 sentence-terminators or coordinating
      conjunctions joining independent clauses — a documented heuristic, not a parser),
      `LIST_ITEM_WARN_COUNT` (long-list: an answer that is a delimiter-separated enumeration of more
      than N items — e.g. `> 5` comma/semicolon/newline-separated items), `CLOZE_DELETION_MAX_WORDS`
      (oversized-cloze: any single `{{…}}` deletion span longer than N words asks too much, distinct
      from the whole-body `CLOZE_MAX_WORDS`), and a small `TIME_SENSITIVE_TERMS` /
      `STALE_SOURCE_TERMS` list for the source checks. Tune to avoid over-warning (false positives
      are acceptable for `warn`, but keep them rare on clean cards).
- [ ] **Multiple-facts check** (Q&A + cloze): warn when the answer/cloze-body plausibly holds more
      than one fact — e.g. multiple independent sentences, or clauses joined by "and/but/;" that
      each carry a distinct assertion. Reuse / generalize the existing `answer-too-long` signal but
      target *fact count*, not length (a short two-fact answer should still warn). Message echoes
      the rule: "Holds multiple facts — split into one card per fact."
- [ ] **Long-list / list-too-large check** (Q&A answer + cloze body): warn when the answer is a long
      enumeration (`> LIST_ITEM_WARN_COUNT` delimiter-separated items). The minimum-information rule
      "list/set too large" — a 9-item list is better as several cards or an overlapping-cloze set.
- [ ] **Vague-pronoun check** (broaden the existing `ambiguous-pronoun`, keep that id stable): the
      current check only fires on a *leading* bare pronoun. Add a `vague-pronoun` warn for a bare
      demonstrative/pronoun used mid-prompt with no nearby antecedent within the SAME face (a
      documented heuristic — e.g. the prompt references "this/that/it" but names no noun). Keep it
      conservative (advisory). Do not regress the existing `ambiguous-pronoun` behavior/tests.
- [ ] **Unsupported-claim check**: warn when the card states a strong factual assertion
      (`hasSource === false`) — i.e. a sourceless card that makes a claim. This is stricter than the
      existing `missing-source` advisory (which fires on any sourceless card): `unsupported-claim`
      escalates the message for a *claim-shaped* answer ("X causes Y", a number, a definitive
      statement). Reuse the existing `hasSource` input; do NOT add a network/lookup. (If it is
      simplest to fold this into the `missing-source` message wording, do so and document — but the
      roadmap names it, so prefer a distinct `unsupported-claim` row gated on claim-shape +
      `!hasSource`.)
- [ ] **Outdated-source / time-sensitive check**: warn when a card makes a **time-sensitive claim
      with no date/version** — the prompt/answer mentions a version, year, "current", "latest",
      "as of", a software version pattern (`v1.2`, `Node 18`), etc., AND the card carries no
      date/version metadata. Add an OPTIONAL input to `CardQualityInput` (backward-compatible, like
      `AudioQualitySignals`): `sourceDate?: string | null` and/or `sourceIsStale?: boolean` (a
      caller-supplied signal). Warn when time-sensitive-language is detected without a `sourceDate`,
      or when `sourceIsStale === true`. (Full fact-expiry/`valid_until` is M18/T090 — T086 only
      *warns at authoring*. Document the deferral.)
- [ ] **Oversized-cloze check** (cloze): warn when ANY single cloze deletion span exceeds
      `CLOZE_DELETION_MAX_WORDS` (distinct from the existing whole-body `CLOZE_MAX_WORDS` →
      `answer-too-long`). A `{{c1::a very long phrase that is basically a sentence}}` asks the user
      to recall too much in one blank. Use the existing `parseCloze` model to inspect each
      deletion's word count.
- [ ] **Similar/interfering-answer check** — the ONE check needing more than the single card's text.
      Keep `evaluateCardQuality` pure (no DB): add a SEPARATE pure function
      `detectInterference(candidate: CardQualityInput, siblings: { id; answer? ; cloze? }[]):
      CardQualityCheck | null` in `packages/core/src/card-quality.ts` that warns when the
      candidate's answer is near-identical (a normalized string-similarity over a documented
      threshold, e.g. Levenshtein/Jaccard ≥ 0.85) to an existing card's answer. The **caller**
      (`CardBuilder.tsx`) supplies the comparison set — sibling cards under the same extract/concept
      **with their answer bodies**. **Note:** `CardBuilder` does NOT hold sibling answer bodies today —
      it receives only `extractId` + `extractPriority` + a locally-minted `siblingGroupId`, and the
      inspector/lineage payload exposes children as lightweight `LineageItem` summaries, **not** card
      prompt/answer text. So populating real candidates needs a **small read**: either a new `appApi`
      call returning the sibling cards' answers under this extract/concept, or extend the existing
      extract/inspector read to include them. Keep that read **cheap and outside the per-keystroke
      report** (fetch once when the builder opens / the extract changes — never on every edit); if no
      candidate set is readily available, the check is simply **absent** (it degrades gracefully).
      `evaluateCardQuality` stays single-card-pure; `detectInterference` is opt-in and the builder
      merges its row into the rendered `qc` list. Document: this is a *heuristic interference warn*,
      not semantic dedup (semantic similarity is M18/T088).
- [ ] **Wire into `CardBuilder.tsx`**: the new single-card checks appear automatically (they are
      part of the report). Add the optional inputs the builder can supply (`sourceDate`/
      `sourceIsStale` from the extract's source metadata; the sibling answers for
      `detectInterference` — see the interference deliverable: these are NOT in the builder's current
      props, so load them via a cheap one-shot read when the builder opens / the extract changes, not
      on every keystroke, and pass an empty set when none are available) and render the interference
      row alongside the report rows (same `qc` styling + `data-testid` `cb-qc-<id>`). All new rows are
      `warn` — `canCreate` is unchanged (still `!quality.hasBlocker`). No new blocker.
- [ ] **Tests (Vitest, `packages/core/src/card-quality.test.ts`):** a fires / does-not-fire pair for
      EACH new check — `multiple-facts` (a two-sentence answer warns; a single atomic answer is ok),
      `long-list` (a 9-item list warns; a 3-item list is ok), `vague-pronoun` (a mid-prompt bare
      "this" with no antecedent warns; a clear sentence is ok; the existing `ambiguous-pronoun`
      cases still pass), `unsupported-claim` (a sourceless claim-shaped answer warns; a sourced one
      is ok), `outdated-source` (time-sensitive language with no `sourceDate` warns; with a
      `sourceDate` it is ok; `sourceIsStale` warns), `oversized-cloze` (a 12-word single deletion
      warns; a 3-word deletion is ok — independent of the whole-body word count), and
      `detectInterference` (two near-identical answers warn; distinct answers / empty candidate set
      do not). Assert no NEW `block` is ever produced (only the hollow-card `empty` blocks), and
      that the existing T035/T072/T075 tests still pass unchanged.
- [ ] **Tests (Vitest, renderer component):** `CardBuilder` renders the new check rows from a card
      that triggers them (e.g. a multi-fact + oversized-cloze draft) and still allows Create
      (warnings don't block); the interference row appears when sibling answers are supplied.

### Done when

- `evaluateCardQuality` produces advisory warnings for **multiple facts, long lists/sets, vague
  pronouns, unsupported claims, similar/interfering answers, no/outdated source, and oversized
  clozes**, in addition to the T035 checks; every new check is a pure `packages/core` function with
  a fires/does-not-fire unit test; the card builder surfaces them in the `qc` checklist and they
  **never hard-block** activation (only a hollow card blocks); the existing T035/T072/T075 checks
  and tests are unchanged.
- The heuristics live in `packages/core`, **not** React; the similar-answer check stays pure
  (caller-supplied candidates, no DB in the heuristic).
- `pnpm typecheck`, `pnpm test`, `pnpm lint` pass.

### Notes / risks

- **Advisory, not blocking.** Every new check is `warn`. The card-quality rule is "warn or prevent
  *when possible*", but the only justified hard `block` is a hollow card (already T035). Adding a
  blocker here would silently prevent legitimate authoring — do not.
- **Keep it pure + cheap.** No NLP model, no network, no DB inside `evaluateCardQuality` — it runs
  on every keystroke in the builder. The heuristics are small documented string/regex rules; false
  positives are acceptable for a `warn`, but tune `LIST_ITEM_WARN_COUNT`/`MAX_FACTS_HINT` so a
  clean atomic card stays all-`ok`.
- **`detectInterference` is the seam, not semantic dedup.** The heuristic is pure (no DB); the
  CALLER supplies the candidate set of sibling/concept answers. The builder does **not** hold those
  answer bodies today (it has only `extractId`/`extractPriority`/`siblingGroupId`; the lineage
  payload is lightweight `LineageItem` summaries), so a **small one-shot read** populates them when
  the builder opens / the extract changes — keep it out of the per-keystroke path, and pass an empty
  set (check absent) when none are available. True semantic similarity + duplicate detection is
  M18/T088; note the deferral and do not pull embeddings into `packages/core`.
- **Outdated-source only WARNS at authoring.** Real fact expiry (`valid_from`/`valid_until`/
  `review_by`/staleness scheduling) is M18/T090 — T086 supplies the authoring-time warning and the
  optional `sourceDate`/`sourceIsStale` inputs the later task can feed; do not build expiry here.
- **Backward-compatible inputs.** Add `sourceDate`/`sourceIsStale` as OPTIONAL fields (like the
  T075 `AudioQualitySignals`) so every existing caller and test keeps working without change.
- Coordinate the broadened pronoun check with the existing `ambiguous-pronoun` id: keep the leading-
  pronoun id/behavior intact and add the broader case under the new `vague-pronoun` id, so no T035
  test regresses.

---

## Exit criteria for M17 (quality half: T085 + T086)

- T085 and T086 are `[x]` in [`../roadmap.md`](../roadmap.md).
- **Leech remediation works end to end** in the Electron desktop app: a repeatedly-failing card can
  be **split** into atomic siblings, given **added context**, taken back **to its extract**, have
  its **priority lowered**, opened at its **source**, **suspended**, or **deleted** — each one
  transaction + the correct EXISTING `operation_log` op, preserving `card → source location →
  source` and `card → extract` lineage and the append-only `review_logs` history, and all surviving
  **app restart**. The two-scheduler split holds: only back-to-extract touches the attention
  scheduler, and no extract ever gets a `review_states`/FSRS row.
- **The minimum-information-principle checks are complete**: `evaluateCardQuality` (pure,
  `packages/core`) warns on multiple facts, long lists/sets, vague pronouns, unsupported claims,
  similar/interfering answers, no/outdated source, and oversized clozes — advisory, never a new
  hard block — and the card builder surfaces them in the `qc` checklist; the existing T035/T072/T075
  checks are unchanged.
- All new capabilities reach the renderer **only** through typed `window.appApi` commands
  (`cards.split`/`cards.addContext`/`cards.backToExtract` + the reused `cards.*`/`elements.setPriority`/
  `review.leeches`) with Zod-validated IPC; **no raw DB/filesystem access is exposed to the
  renderer**, and no generic `db.query`.
- `pnpm typecheck`, `pnpm test`, `pnpm lint`, and the M17 quality Playwright spec(s) (leech
  remediation → split/back-to-extract/lower-priority → restart) are green.

When the M17 quality half is complete, ensure the analytics half (T083/T084) is generated/built
(`tasks/M17-analytics.md`), then proceed to M18 per the roadmap.
