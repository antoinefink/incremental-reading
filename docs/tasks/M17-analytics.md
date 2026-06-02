# M17 — Analytics, quality & maintenance (T083–T084)

Detailed, buildable specs for the seventeenth milestone. M17 turns the *system-wide*
self-awareness M9 gave us (the `AnalyticsService` snapshot + the import/process balance banner)
into **per-unit, actionable** maintenance: it stops asking only "how is the whole system doing?"
and starts asking "**which** sources are not paying their way", "**which** extracts keep coming
back without ever turning into anything", "**which** leeches need surgery and how do I do it", and
"**which** cards violate the minimum-information principle". Four tasks: **source-yield analytics**
(T083) ranks every source by what it actually produced (read %, extracts/cards/mature-cards,
leeches, time spent) so low-yield material is visible; **extract-stagnation analytics** (T084)
detects extracts that keep *returning without progressing* and surfaces them with concrete
remediation suggestions; a **leech remediation workflow** (T085) gives a real repair screen
(split / add-context / open-source / back-to-extract / lower-priority / suspend / delete);
and **minimum-information-principle checks** (T086) extend the existing card-quality heuristics
(multiple facts, long lists, vague pronouns, unsupported claims, similar answers, no/outdated
source, oversized clozes).

**This file specs only T083 + T084** (the two analytics tasks). T085 (leech remediation) and
T086 (card-quality extension) are specced separately — generate the rest of this file before
starting them.

After T083/T084 the product's north-star promise — *every piece of knowledge knows why it
matters and what action is needed next* — becomes measurable per source and per extract: a user
who has imported too much can see, at a glance, which sources to abandon and which extracts to
finish, rewrite, or drop.

The architecture is unchanged and non-negotiable (see [`../../CLAUDE.md`](../../CLAUDE.md) and
the roadmap header). The React **renderer** (`apps/web`) never touches SQLite, Node, or the
filesystem. Every capability flows React UI → typed client wrapper (`apps/web/src/lib/appApi.ts`)
→ preload bridge (`apps/desktop/src/preload/index.ts`) → validated IPC (Zod) on the main side
(`apps/desktop/src/main/ipc.ts`) → the `DbService` (`apps/desktop/src/main/db-service.ts`) →
`packages/local-db` read queries + `packages/core`/`packages/scheduler` pure heuristics → SQLite.

> **M17 analytics are READ-ONLY aggregate QUERIES — they never mutate (load-bearing).** Exactly
> like the T045 `AnalyticsService`, T083's source-yield rollup and T084's stagnation scan are
> pure reads over the durable tables (`elements`, `read_points`, `document_blocks`,
> `element_relations`/`sourceId`, `review_states`, `review_logs`, `cards`, `operation_log`). They
> **never** write a row, **never** append an `operation_log` entry, and **never** touch a
> schedule — "there is nothing to undo about looking at your stats" (the comment in
> `packages/local-db/src/analytics-query.ts`). The remediation *suggestions* T084 surfaces are
> **labels**, not actions: the actual rewrite/convert/postpone/delete already exist as the T024
> `ExtractService` transactional, op-logged commands (`extracts.*`); T084 only points at them.

> **No new schema is needed — and that is the point (prefer querying existing tables).** The
> latest applied migration is `0020_optimal_zombie` (`packages/db/drizzle/`). T083 and T084 are
> *entirely* queries + pure scoring over tables that already exist:
> - **read %** = `read_points` (block id + offset) vs the source's `document_blocks` (block order)
>   — both built in T016/T017.
> - **extracts/cards/mature-cards per source** = the lineage already persisted by
>   `ExtractionService`/`CardService`: a descendant points at its lineage root via
>   `elements.sourceId`, and the `derived_from` edge is a real `element_relations` row.
>   "Mature card" = a card whose `review_states.stability` crosses the **existing**
>   `CARD_MATURE_STABILITY_DAYS = 21` maturity threshold (already in
>   `packages/scheduler/src/auto-postpone.ts`, from T077) — derivable, no new column, no new constant.
> - **leeches per source** = `cards.is_leech` (T040), joined through `sourceId`.
> - **time spent** = `review_logs.responseMs` summed (the only durable "time" signal we record);
>   reading time is **not** tracked yet — see the T083 note (do not invent a reading timer here).
> - **stagnation** = `elements.stage` (no advance), the `derived_from` child count (no children
>   produced), and the `operation_log` `reschedule_element` postpone markers
>   (`OperationLogRepository.countPostpones`) — all already recorded.
> A schema change is allowed only if a query is genuinely impossible without it; **neither task
> needs one.** If you add an index for performance, ship it as an additive Drizzle migration
> (`pnpm db:generate`, next number `0021`) and nothing else.

> **The two-scheduler split shows up in BOTH tasks (do not collapse it).** A source-yield row mixes
> both schedulers but keeps them labeled: extracts/cards-created and leeches/mature-cards are the
> FSRS-card + attention-extract outputs of a source; the source itself is an *attention* item.
> Extract stagnation is an **attention** concern (stage didn't advance, kept being postponed) —
> it is the mirror image of a card *leech* (an FSRS concern). Never compute extract stagnation
> from FSRS `lapses` (extracts have no `review_states` row), and never call an extract a "leech".

Read first:
- [`../../CLAUDE.md`](../../CLAUDE.md) — **"Scheduling rules"** (the two-scheduler split: FSRS for
  cards, the attention scheduler for sources/topics/extracts; an extract scheduler considers
  priority, stage, last-processed, whether it produced useful children, whether it is **stagnant**,
  whether it has been **postponed repeatedly**), **"Product north star"** (every piece of knowledge
  knows where it came from / why it matters / what stage it is in / when it returns / how important
  / what action is next), **"Architectural rules"** (analytics are domain queries, never React).
- [`../scheduling-and-priority.md`](../scheduling-and-priority.md) — the topic/extract scheduler
  inputs (lines 28–33): *the user's last action; whether the element produced useful children
  (extracts/cards); whether it is **stagnant** (keeps returning without progressing); whether it
  has been **postponed repeatedly***. These four are the T084 stagnation heuristic verbatim.
- [`../domain-model.md`](../domain-model.md) — the distillation stages
  (`raw_extract → clean_extract → atomic_statement`), lineage (`derived_from`, `sourceId`,
  `parentId`), soft-delete.
- [`../design-system.md`](../design-system.md) — the inspector's **attention** `SchedulerChip`
  already promises **stage / priority / last processed / postponed ×N / stagnant? / yield (N
  extracts / M cards)** (lines 82–84) — T083/T084 make those real; the `screen-analytics` row maps
  to "analytics → M9 (T045–T046), **M17**"; `Metric`, `Spark`, `Banner`, `EmptyState`, `TypeIcon`,
  `Status`, `Dot`.
- [`./M9-safety-analytics-backup.md`](./M9-safety-analytics-backup.md) — the **substrate this
  milestone extends**: T045's `AnalyticsService` (`packages/local-db/src/analytics-query.ts`), the
  `analytics.*` IPC surface + `AnalyticsScreen`, and the explicit deferral comments that name
  T083/T084 ("Source-yield analytics … is **M17/T083**"; "FSRS-true retrievability +
  retention-by-concept are a later refinement (M17/T083)"; "concept-level retention + forecast as
  M17 deferrals").
- [`./M4-extraction.md`](./M4-extraction.md) — extracts as independent attention-scheduled
  elements, the stage chain, source locations (T021–T026).
- [`./_TEMPLATE.md`](./_TEMPLATE.md) — the section shape.

### What already exists (inspect before building — do not duplicate)

The M9 + M4–M7 substrate already provides almost everything both tasks read:

- **The T045 analytics service — the pattern + the seam to mirror exactly:**
  - `AnalyticsService` (`packages/local-db/src/analytics-query.ts`): `computeAnalytics(asOf, { windowDays })`
    and `computeBalance(asOf, { windowDays, factor })` — read-only, JS-side local-day bucketing,
    `private countCreatedInWindow(type, start, end)`, composed `QueueRepository` + `ReviewRepository`.
    **T083/T084 add sibling read methods/queries in the same style** (a new `source-yield-query.ts`
    and `extract-stagnation-query.ts`, or new methods on `AnalyticsService` — prefer **new files**,
    one query per task, exported from `packages/local-db/src/index.ts` + added to `Repositories`).
  - The full `window.appApi` analytics seam to copy: channel `analyticsGet` (`analytics:get`) +
    `balanceGet` (`balance:get`) in `apps/desktop/src/shared/channels.ts`; `AnalyticsGetRequestSchema`
    + `AnalyticsGetResult` + `BalanceGetResult` in `apps/desktop/src/shared/contract.ts`
    (+ `contract.test.ts`); the `analytics` preload group (`apps/desktop/src/preload/index.ts`);
    the validated handler (`apps/desktop/src/main/ipc.ts`); `DbService.getAnalytics`/`getBalance`
    (`apps/desktop/src/main/db-service.ts` + `db-service.test.ts`); the renderer client
    `appApi.getAnalytics()` (`apps/web/src/lib/appApi.ts`). **M17 adds T083/T084 the same way:** a
    grouped `window.appApi` surface (preload — `sourceYield.*` / `extractStagnation.*`, analytics-style)
    but a **flat** renderer client method (`appApi.getSourceYield(...)` / `appApi.getExtractStagnation(...)`,
    matching the existing `getAnalytics`/`getBalance`/`reviewLeeches` convention in `appApi.ts`).
  - The `AnalyticsScreen` (`apps/web/src/analytics/AnalyticsScreen.tsx` + `analytics.css`): the
    `Metric` row, the "Reviews per day" `Spark`, the "System health" `Banner`s that link to
    `/maintenance/leeches` / `/trash` / `/maintenance/retired`. **T083 adds a low-yield-sources
    panel/route + a banner here; T084 adds a stagnant-extracts panel/route + a banner here.**
- **Read-points + document blocks (T016/T017) — the read-% source of truth:**
  - `read_points` (`packages/db/src/schema/relations.ts`): one row per source/topic with
    `{ elementId, documentId, blockId, offset, updatedAt }` — the stable block id the user has read
    *up to*. `DocumentRepository.getReadPoint(elementId)` reads it.
  - `document_blocks` (`packages/db/src/schema/documents.ts`): `{ documentId, blockType, order,
    stableBlockId, page?, timestampMs? }`, in document `order`. `DocumentRepository.listBlocks(elementId)`
    returns them in order. **Read % = (0-based index of the read-point's block in `order` + 1) /
    total live blocks** — i.e. the furthest-read block's position counting from 0, plus one, over
    the block count, so block index `0` of `N` reads as `1/N` and the last block (index `N-1`)
    reads as `N/N = 100%` (matches the Deliverables formula `(orderIndex + 1) / blockCount`).
    Document the exact formula; a source with no read-point is 0%, a read-point at/after the last
    block is 100%.
- **Lineage already persisted (T021–T026, T032–T034) — the per-source yield rollup:**
  - Every descendant (extract / sub-extract / card) carries `elements.sourceId = <owning source's
    element id>` (set by `ExtractionService`/`CardService`; `CardService.createFromExtract` sets
    `sourceId = extract.sourceId ?? extractId`). So **all extracts of a source** = live `extract`
    elements with `sourceId = source.id`; **all cards of a source** = live `card` elements with
    `sourceId = source.id`. (The `derived_from` `element_relations` edge agrees with `sourceId` by
    construction — `LineageQuery` notes they're consistent. Use `sourceId` for the rollup; it is a
    single indexed column.)
  - `elements` has `type`/`status`/`stage`/`priority`/`createdAt`/`updatedAt`/`deletedAt`/`dueAt`
    (`packages/db/src/schema/elements.ts`); `listBy*` queries already filter `isNull(deletedAt)`.
- **FSRS card state (T036/T040/T082) — leeches + mature cards per source:**
  - `cards` (`packages/db/src/schema/cards.ts`): `is_leech` (T040), `is_retired` (T082), indexed.
  - `review_states` (`packages/db/src/schema/cards.ts`): `stability`/`difficulty`/`reps`/`lapses`/
    `dueAt`/`fsrsState` — **a card is "mature" when `review_states.stability >= CARD_MATURE_STABILITY_DAYS`**
    (the FSRS maturity convention; the constant already exists — reuse the **existing**
    `CARD_MATURE_STABILITY_DAYS = 21` in `packages/scheduler/src/auto-postpone.ts` (T077), plus its
    `isCardMature(signals)` predicate; **do not** mint a new `MATURE_STABILITY_DAYS` or a parallel
    maturity check). `ReviewRepository` has `findCardById`, `listReviewLogs`, `listLeechCards`,
    `countRetiredCards`.
  - `review_logs`: append-only, `{ elementId, rating, reviewedAt, responseMs, … }`, indexed on
    `reviewedAt` + `elementId` — **`SUM(responseMs)` per source's cards = "time spent" (review
    time)**, the only durable time signal.
- **The attention / postpone signals (T024/T028) — the stagnation inputs:**
  - `ExtractService` (`packages/local-db/src/extract-service.ts`): `advanceStage`/`setStage` move
    `raw_extract → clean_extract → atomic_statement` (logs `update_element` + `reschedule_element`);
    `postpone` records a `{ postpone: true, postponeCount }` marker in the `reschedule_element` op
    payload; `markDone`, `delete` (soft). `countPostpones(id)` delegates to the op log.
  - `OperationLogRepository.countPostpones(elementId)` (`packages/local-db/src/operation-log-repository.ts`):
    the ONE canonical, schema-churn-free postpone counter (scans `reschedule_element` ops for the
    `postpone === true` marker). `listForElement(elementId)` returns an element's whole op history
    newest-first (so the stagnation scan can also read the last *stage change* / last *extract*). The
    `update_element` op payload is `{ id, patch, prev }` (the changed fields nest under `patch`, with a
    `prev` pre-image — see `element-repository.ts:250–256`), so "the last stage change" = the newest
    `update_element` whose `payload.patch.stage` is set (confirm a real advance with
    `payload.prev.stage !== payload.patch.stage`); the create-stamp of a `create_extract` child gives the
    last *extract produced*. **Not every `update_element` op carries this `{ patch, prev }` shape:**
    `CardEditService` logs `{ id, body }`/`{ id, flagged }` (`card-edit-service.ts:106`/`:157`) and
    `setCardLeech` logs `{ id, isLeech }` (`review-repository.ts:569`). The reader **must filter to
    the stage-advance patch shape** (payloads whose `patch` touches `stage`) so those leech/flag/body
    `update_element` ops don't pollute the stagnation signal.
  - `AttentionScheduler` (`packages/scheduler/src/attention-scheduler.ts`): `EXTRACT_STAGES`,
    `nextExtractStage`, `postponeIntervalForPriority(priority, postponeCount)` (the receding
    interval), and the `Schedulable`/`SchedulerAction` model — the same axes the stagnation
    heuristic keys off. **The stagnation predicate is the pure, attention-side mirror of
    `packages/scheduler/src/leech.ts`'s `isLeech` — put it next to it.**

### What M17 (T083/T084) must add (the gaps)

- **No per-source yield rollup + no `sourceYield.*` surface + no low-yield route.** Nothing today
  joins a source to its read %, its descendant extracts/cards/mature-cards, its leeches, and its
  review time, or ranks sources by yield. The T045 snapshot is *system-wide* only; the inspector's
  attention `SchedulerChip` *promises* "yield (N extracts / M cards)" but nothing computes it. T083
  adds the rollup query, the IPC surface, the ranked view, and (cheaply) wires the inspector chip.
- **No stagnation heuristic + no `extractStagnation.*` surface + no stagnant route.** There is no
  pure predicate for "an extract that keeps returning without progressing", nothing scans for it,
  and the suggestions don't exist. T084 adds the pure heuristic (in `@interleave/scheduler`,
  unit-tested), the scan query, the IPC surface, the surfaced list with rewrite/convert/postpone/
  delete suggestions (wired to the existing `extracts.*` actions), and an analytics banner.

Build order is the task order. T083 depends only on T045 (the analytics substrate); T084 depends
on T045 + T024 (the extract stage/postpone signals). They share no code beyond the established
seam and the read-% / lineage helpers, so they may be built in parallel after their deps. This
M17 file is generated ahead per the orchestration loop; **generate the T085/T086 sections of this
file before starting those tasks.**

---

## T083 — Source-yield analytics

- **Status:** `[ ]`  · **Depends on:** T045
- **Roadmap line:** Done when: each source shows read %, extracts/cards/mature-cards created,
  leeches, and time spent; low-yield sources are identifiable.

### Goal

The user can see, per source, **what it actually produced** — and therefore which sources are not
worth more time. For every live `source`, a read-only rollup computes: **read %** (how far the
source has been read, from `read_points` vs `document_blocks`), **extracts created**, **cards
created**, **mature cards** (cards whose FSRS stability crosses the maturity threshold), **leeches**
(failing cards), and **time spent** (summed review response time on its cards) — and a derived
**yield score** that ranks sources so **low-yield sources are identifiable** in a sorted "Source
yield" view. Every number is a domain aggregation over `elements`/`read_points`/`document_blocks`/
`review_states`/`review_logs`/`cards` (via the persisted `sourceId` lineage) — **never** in React —
surfaced as a ranked table plus an inspector "yield" chip and an analytics banner. It is read-only:
no mutation, no `operation_log`, no schedule change.

### Context to load first

- Reference: `CLAUDE.md` "Product north star" (every piece of knowledge knows *why it matters* +
  *what action is next*) + "Scheduling rules" (the two-scheduler split; a source is an attention
  item, its cards are FSRS); `design-system.md` (the attention `SchedulerChip`'s promised
  **yield (N extracts / M cards)** + the `screen-analytics` "yield" mapping to M17);
  `M9-safety-analytics-backup.md` T045 (the deferral to T083 is written there).
- Existing code to inspect:
  - `packages/local-db/src/analytics-query.ts` — the read-only aggregation + seam pattern to mirror
    (the SAME local-day windowing helpers, `Repositories` composition, JS-side bucketing).
  - `packages/db/src/schema/relations.ts` (`read_points` = `{ elementId, documentId, blockId,
    offset }`) + `packages/db/src/schema/documents.ts` (`document_blocks` = `{ documentId, order,
    stableBlockId }`) + `packages/local-db/src/document-repository.ts` (`getReadPoint`, `listBlocks`)
    — the read-% inputs.
  - `packages/db/src/schema/elements.ts` (`type`/`status`/`stage`/`sourceId`/`createdAt`/`deletedAt`)
    + `packages/local-db/src/element-repository.ts` (`listChildren`, `findById`, the `isNull(deletedAt)`
    filter) — the per-source descendant rollup via `sourceId`.
  - `packages/db/src/schema/cards.ts` (`cards.is_leech`/`is_retired`; `review_states.stability`/`lapses`/
    `reps`; `review_logs.responseMs`/`reviewedAt`/`elementId`) + `packages/local-db/src/review-repository.ts`
    (`listLeechCards`, `findCardById`, `listReviewLogs`) — leeches, maturity, time-spent.
  - `packages/scheduler/src/leech.ts` (`LEECH_LAPSE_THRESHOLD`) + `packages/scheduler/src/auto-postpone.ts`
    (`CARD_MATURE_STABILITY_DAYS = 21`, `CARD_MATURE_RETRIEVABILITY = 0.9` — the **existing** T077
    maturity constants; **reuse them**, do not define a new one).
  - `packages/local-db/src/library-query.ts` (`LibraryQuery.browse` — how the live source universe is
    listed; the yield query iterates the same live `source` rows) + `packages/local-db/src/inspector-query.ts`
    (`SchedulerSignals`, the attention branch — where the "yield" chip data attaches).
  - The seam: `apps/desktop/src/shared/{channels,contract}.ts` (+ `contract.test.ts`), `preload/index.ts`,
    `main/ipc.ts`, `main/db-service.ts` (+ `db-service.test.ts`), `apps/web/src/lib/appApi.ts`.
  - The renderer host: `apps/web/src/analytics/AnalyticsScreen.tsx` + `analytics.css`;
    `apps/web/src/router.tsx` + `apps/web/src/shell/nav.ts` (add a `/analytics/sources` sub-route or a
    section on `/analytics`); `apps/web/src/library/` (the source-list row pattern to reuse for the
    ranked table).
- Invariants in play: **read-only** (no mutation, no `operation_log`); aggregation lives in
  `packages/local-db`/`@interleave/scheduler`, **never** React; the FSRS-vs-attention split is kept
  labeled (a source is attention; its leeches/mature-cards are FSRS); lineage is read through the
  persisted `sourceId` (sacred, untouched); the numbers are computed from durable tables so they
  survive **app restart**.

### Deliverables

- [ ] **A `SourceYieldQuery` in `packages/local-db`** (`packages/local-db/src/source-yield-query.ts`,
      exported from `packages/local-db/src/index.ts` + added to `Repositories`/`createRepositories`),
      a read-only aggregation:
      - `listSourceYield(asOf, options?): SourceYieldSummary` — for every **live** `source` element,
        compute a `SourceYieldRow`:
        - `readPct: number` — `[0, 1]`. The read-point's block position over the document's live
          block count: find the read-point block's `order` in `document_blocks` (via
          `getReadPoint` + `listBlocks`); `readPct = (orderIndex + 1) / blockCount`. **0** when there
          is no read-point or no document; **clamped to `[0, 1]`** (a stale read-point past the last
          block reads as 100%). A media/PDF source uses the same block-order math (paginated/media
          blocks are still `document_blocks` rows). Document the formula in the file header.
        - `extractsCreated: number` — live `extract` elements with `sourceId = source.id`.
        - `cardsCreated: number` — live `card` elements with `sourceId = source.id`.
        - `matureCards: number` — those cards whose `review_states.stability >= CARD_MATURE_STABILITY_DAYS`
          (the existing T077 constant — reuse it; require `fsrsState === "review"` too, matching T077's
          `isCardMature(signals)` predicate in `packages/scheduler/src/auto-postpone.ts` — reuse it, do
          not re-implement the maturity check). `retrievability` is **not** a stored column (the `cards`
          row carries `stability`/`difficulty`/`reps`/`lapses`/`fsrsState`/`dueAt`/`lastReviewedAt`;
          retrievability is computed at read-time), so the rollup passes `retrievability: null` to
          `isCardMature`, which short-circuits (`auto-postpone.ts:150`) to the
          `stability >= CARD_MATURE_STABILITY_DAYS && fsrsState === "review"` check — so the builder
          neither re-implements maturity nor pulls `ts-fsrs` into the SQL query.
        - `leeches: number` — those cards with `cards.is_leech = 1`.
        - `timeSpentMs: number` — `SUM(review_logs.responseMs)` over this source's cards' review logs
          (the durable review-time signal; **reading time is NOT tracked** — see Notes).
        - `reviewCount: number` — number of `review_logs` rows on this source's cards (denominator
          context for `timeSpentMs`).
        - `lastActivityAt: IsoTimestamp | null` — the most recent of the source's/descendants'
          `updatedAt` (or the latest descendant review) — for the "stale source" read.
          **Reuse the SAME grouped descendant-by-`sourceId` set** that `timeSpentMs`/`reviewCount`
          already compute (a source has no `review_logs` of its own — `review_logs` is indexed by
          `elementId`, not `sourceId` — only its descendant cards do): take `MAX(reviewed_at)` over
          those descendant cards' logs in the same grouped pass rather than adding a separate
          per-source `review_logs` scan.
        - `yieldScore: number` + `yieldBand: "high" | "medium" | "low"` — the **derived rank** (see
          the next deliverable; the pure scorer in `@interleave/core`/`@interleave/scheduler`).
        - `source`: a small `{ id, title, priority, createdAt, url? }` for the row.
      - The result `SourceYieldSummary = { asOf, rows: SourceYieldRow[], lowYieldCount: number }`,
        with `rows` **sorted by `yieldScore` ascending** (lowest-yield first — the whole point) and
        a `limit`/`offset` (default cap, e.g. 200, like `LibraryQuery`). `lowYieldCount` = rows with
        `yieldBand === "low"`.
      - **One efficient pass:** prefer a small number of grouped queries (one `read_points` join, one
        `document_blocks` count, one descendant-by-`sourceId` group, one `review_logs` sum) over an
        N+1 per-source loop; the indexes already exist (`read_points_element_idx`, the `cards`
        source-location/leech indexes, `review_logs_element_idx`). If a covering index would help,
        add it as additive migration `0021` — otherwise add **no** schema.
- [ ] **A pure yield scorer in `@interleave/core` (or `@interleave/scheduler`)**
      (`packages/core/src/source-yield.ts` — pure, DB-free, unit-tested): `scoreSourceYield(inputs):
      { score: number; band: "high" | "medium" | "low" }` over the rollup signals (extracts, cards,
      mature cards, leeches, read %, time spent). (`CARD_MATURE_STABILITY_DAYS` lives in
      `@interleave/scheduler`; if the scorer needs the maturity threshold, import it rather than
      re-declaring `21`.) **Define the rule explicitly and keep it a pure,
      tunable function** with named constants — e.g. yield rewards mature cards + cards + extracts
      produced, penalizes time-spent-per-mature-card (lots of review time, little maturity) and
      leech ratio, and treats a *read but barren* source (high read %, ~0 extracts/cards) as **low**.
      A source with **no reading and no output** is *neutral* (not yet processed), not "low-yield" —
      do not flag un-started sources (document this so a fresh inbox doesn't light up red). Put the
      constants in one place; the band thresholds are documented defaults.
- [ ] **A `sourceYield.*` `window.appApi` surface** across the established seam, Zod-validated:
      - channel `sourceYieldList` (`sourceYield:list`) in `channels.ts`.
      - contract (`contract.ts` + `contract.test.ts`): `SourceYieldListRequestSchema`
        (`{ asOf?, limit?, offset? }`, all optional — defaults applied main-side) +
        `SourceYieldListResult` (the flat, JSON-serializable `SourceYieldSummary`). Mirror the
        `AnalyticsGetRequestSchema`/`AnalyticsGetResult` shapes.
      - preload (`preload/index.ts`): a `sourceYield` group (grouped `window.appApi`, analytics-style).
      - IPC (`ipc.ts`): the validated handler.
      - `DbService` (`db-service.ts` + `db-service.test.ts`): `listSourceYield` composing the query.
      - renderer client (`apps/web/src/lib/appApi.ts`): a **flat** top-level method
        `appApi.getSourceYield(...)` delegating to `requireAppApi().sourceYield.list(...)` — matching
        the existing flat `getAnalytics`/`getBalance` convention — + the types.
- [ ] **A "Source yield" view in the renderer** — a ranked table, lowest-yield first, rebuilt in the
      analytics aesthetic. Either a new route `/analytics/sources` (preferred — add to `router.tsx`
      + a nav/entry, and a "Low-yield sources" `Banner` on `AnalyticsScreen` linking to it) or a
      panel within `/analytics`. Each row: `TypeIcon` + source title, a read-% bar, the yield numbers
      (extracts / cards / mature / leeches), time spent (formatted from `timeSpentMs`), the
      `yieldBand` as a calm `Status`/`Dot`, and an "Open" action navigating to `/source/$id`. The
      lowest-yield rows are visually distinguishable (a `low` band tint). Empty state when there are
      no sources. **No SQL, no scoring, no read-% math in React** — it renders the already-computed
      `SourceYieldRow`s.
- [ ] **Wire the inspector's promised attention "yield" chip (cheap):** the inspector
      (`packages/local-db/src/inspector-query.ts` attention branch / `apps/web` inspector) already
      promises "yield (N extracts / M cards)" for a source. Surface `extractsCreated`/`cardsCreated`
      (and read %) on a source's inspector from the same rollup (reuse `SourceYieldQuery` for a single
      source, or add a `getSourceYield(id)` convenience). Keep it read-only.
- [ ] **Tests (Vitest, `packages/core`):** `scoreSourceYield` — a productive source (many extracts +
      mature cards, little wasted time) scores **high**; a read-but-barren source (high read %, ~0
      output) scores **low**; a leech-heavy source scores **low**; an un-started source (no reading,
      no output) is **neutral**, not low; boundary cases either side of the band thresholds.
- [ ] **Tests (Vitest, `packages/local-db`):** seed a deterministic fixture (via `packages/testing`
      factories + `test-db.ts`): a source with N `document_blocks` and a `read_point` at block k
      (assert `readPct = (k+1)/N`), M extracts + P cards under it via `sourceId`, some cards with
      `is_leech` and some with high `review_states.stability` (assert `leeches`/`matureCards`), and a
      few `review_logs` with known `responseMs` (assert `timeSpentMs`/`reviewCount`). Assert the rows
      sort lowest-yield first and `lowYieldCount`. Test the no-read-point (0%), no-document, and
      no-cards edges, and that a soft-deleted extract/card is excluded.
- [ ] **Tests (Vitest, `DbService` + renderer component):** the `sourceYield.list` handler
      round-trips the shape; the "Source yield" view renders the ranked rows from a mocked payload,
      the read-% bar reflects `readPct`, and the lowest-yield row carries the `low` band class.
- [ ] **Playwright E2E** (`tests/electron/source-yield.spec.ts`): on the seeded DB, open the source-
      yield view → the rows render with non-placeholder read-% + yield numbers and the lowest-yield
      source sorts first → extract a fragment / create a card from a source in the reader, return to
      the view → that source's extracts/cards count increments and its yield re-ranks → **restart the
      app** → the numbers persist (computed from durable tables).

### Done when

- Each source shows **read % / extracts created / cards created / mature cards / leeches / time
  spent**, all computed by a domain aggregation over `elements`/`read_points`/`document_blocks`/
  `review_states`/`review_logs`/`cards` (via the persisted `sourceId` lineage), and **low-yield
  sources are identifiable** in a ranked, lowest-first view (+ the inspector "yield" chip); the
  numbers are correct (unit-tested) and survive **app restart**.
- The rollup + the pure scorer live in `packages/local-db` + `@interleave/core`/`@interleave/scheduler`,
  **never** React; source-yield is **read-only** (no `operation_log`, no schedule change); the
  FSRS-vs-attention split stays labeled.
- The renderer reads it **only** through the typed `sourceYield.*` `window.appApi` command (Zod IPC);
  no raw DB/filesystem access; no `db.query`.
- `pnpm typecheck`, `pnpm test`, `pnpm lint`, and the source-yield Playwright spec pass.

### Notes / risks

- **Reading time is NOT tracked today — do not invent a reading timer in T083.** The only durable
  "time" signal is `review_logs.responseMs` (card *review* time). `timeSpentMs` is therefore
  *review* time on a source's cards, and the UI labels it as such ("review time"), not total reading
  time. A real reading-time signal (a per-source dwell timer in the reader) is a separate, larger
  feature — note it as a future refinement; **do not** add a timer/mutation here (T083 is read-only).
- **"Mature card" reuses the EXISTING threshold — do not define a new one.**
  `CARD_MATURE_STABILITY_DAYS = 21` (+ `CARD_MATURE_RETRIEVABILITY = 0.9`) already exists in
  `packages/scheduler/src/auto-postpone.ts` (T077's fragile↔mature cutline, the same notion T082's
  retirement uses). Import it; do not scatter a magic `21` across queries or add a second constant.
  Because `retrievability` is not a stored column (computed at read-time), the rollup passes
  `retrievability: null` to `isCardMature`, which degrades to the
  `stability >= CARD_MATURE_STABILITY_DAYS && fsrsState === "review"` check — no `ts-fsrs` in the query.
- **`yieldScore` is a heuristic, kept pure + tunable** with documented band thresholds and named
  constants, so it is unit-testable and a future per-collection setting can tune it. An un-started
  source must read **neutral**, never "low-yield" — newly imported material should not light up red
  (the same "don't let new material dominate" instinct as T046's floor).
- **Prefer grouped queries over N+1.** A naive per-source loop that re-queries blocks/cards/logs for
  each source is O(sources × reads); group by `sourceId`/`elementId` instead. Add a covering index
  via additive migration `0021` **only** if a real query needs it; otherwise ship **no** schema.
- **Concept-level retention + the 7-day forecast panel (the other M17 analytics deferrals named in
  T045) are out of scope for T083** — T083 is the *per-source yield* view only.

---

## T084 — Extract-stagnation analytics

- **Status:** `[ ]`  · **Depends on:** T045, T024
- **Roadmap line:** Done when: extracts that keep returning without progressing are detected and
  surfaced with rewrite/convert/postpone/delete suggestions.

### Goal

Catch the incremental-reading failure mode on the *extract* side: an extract that keeps **coming
back** (attention-due, again and again) but never **progresses** — its stage never advances
(`raw_extract → clean_extract → atomic_statement`), it never produced children (a sub-extract or a
card), and it has been postponed repeatedly — is dead weight in the attention rotation. T084 adds a
pure **stagnation heuristic** (the attention-side mirror of the FSRS leech rule) over the signals
the charter names — *last action; whether it produced useful children; whether it is stagnant
(keeps returning without progressing); whether it has been postponed repeatedly* — scans live
extracts for it, and surfaces the stagnant ones with concrete **remediation suggestions**:
**rewrite** (clean it up), **convert** (turn it into a card now), **postpone** (push it out
deliberately), or **delete** (drop it). The detection is read-only; the suggested actions are the
**existing** T024 `extracts.*` transactional, op-logged commands — T084 only points at them.

### Context to load first

- Reference: `CLAUDE.md` "Scheduling rules" (a topic/extract scheduler considers *priority, stage,
  last processed, user action, whether it produced useful children, whether it is stagnant, whether
  it has been postponed repeatedly*) — the **stagnation inputs verbatim**; `scheduling-and-priority.md`
  lines 28–33 (the same list); `design-system.md` (the attention `SchedulerChip`'s promised
  **stagnant?** + **postponed ×N** flags); `M4-extraction.md` (the extract stage chain + actions).
- Existing code to inspect:
  - `packages/scheduler/src/leech.ts` (`isLeech`, `LEECH_LAPSE_THRESHOLD`) — the pure-predicate
    pattern + co-location target; **the stagnation heuristic is its attention-side mirror — put it in
    a sibling `packages/scheduler/src/stagnation.ts`.**
  - `packages/scheduler/src/attention-scheduler.ts` (`EXTRACT_STAGES`, `nextExtractStage`,
    `postponeIntervalForPriority`, `Schedulable`/`SchedulerAction`) — the stage chain + the receding
    postpone interval the heuristic reasons about.
  - `packages/local-db/src/extract-service.ts` (`advanceStage`/`setStage`, `postpone` with the
    `{ postpone, postponeCount }` op marker, `markDone`, `delete`, `countPostpones`) — the actions
    the suggestions map to; the postpone marker the scan reads. **Its header already names T084: the
    postpone marker exists "so … stagnation analytics (T084) can read the postpone history WITHOUT a
    schema migration".**
  - `packages/local-db/src/operation-log-repository.ts` (`countPostpones(elementId)`,
    `listForElement(elementId)` newest-first) — postpone count + the op history to find the last
    *stage advance* (the newest `update_element` whose `payload.patch.stage` is set — the changed fields
    nest under `patch`, with a `prev` pre-image, so read `payload.patch.stage` and confirm a real change
    via `payload.prev.stage`, not a flat top-level `stage`) and the last *extract* (`create_extract`
    children).
  - `packages/db/src/schema/elements.ts` (an extract's `stage`/`dueAt`/`createdAt`/`updatedAt`/`status`)
    + `packages/local-db/src/element-repository.ts` (`listChildren` — did it produce children?).
  - `packages/local-db/src/analytics-query.ts` — the read-only query + seam pattern to mirror.
  - The seam: `apps/desktop/src/shared/{channels,contract}.ts` (+ `contract.test.ts`), `preload`,
    `main/ipc.ts`, `main/db-service.ts` (+ test), `apps/web/src/lib/appApi.ts`.
  - The renderer host: `apps/web/src/analytics/AnalyticsScreen.tsx` (a stagnant-extracts banner) +
    `apps/web/src/maintenance/LeechCleanup.tsx` (the maintenance-list pattern + how it drives
    repair actions through the typed API — **mirror it** for a "stagnant extracts" maintenance view);
    `apps/web/src/router.tsx` + `apps/web/src/shell/nav.ts` (add `/maintenance/stagnant`).
- Invariants in play: **detection is read-only** (no mutation, no `operation_log`); the suggestions
  are *labels* that invoke the **existing** `extracts.*` commands (each transactional + op-logged);
  the heuristic is pure (in `@interleave/scheduler`, unit-tested, deterministic with `now` passed
  in); **stagnation is an ATTENTION concern** — computed from stage/children/postpones, **never**
  from FSRS `lapses` (extracts have no `review_states`); an extract is never called a "leech".

### Deliverables

- [ ] **A pure stagnation heuristic in `@interleave/scheduler`** (`packages/scheduler/src/stagnation.ts`,
      pure / DB-free / `now`-injected / unit-tested), the attention mirror of `leech.ts`:
      - An `ExtractStagnationSignals` input — the minimal DB-free snapshot the SERVICE reads off the
        extract + its op log: `{ stage, priority, createdAt, lastProcessedAt, dueAt, postponeCount,
        childCount, lastStageAdvanceAt }` (and `lastAction?` if cheap). All `IsoTimestamp`/numbers.
      - `isStagnant(signals, now, options?): StagnationVerdict` where
        `StagnationVerdict = { stagnant: boolean; reasons: StagnationReason[]; suggestion:
        StagnationSuggestion }`. **The rule (define explicitly, named constants):** an extract is
        stagnant when it has been **postponed ≥ `STAGNATION_POSTPONE_THRESHOLD`** times
        (default e.g. 3) **AND has not progressed** — i.e. it is still at `raw_extract`/`clean_extract`
        (not `atomic_statement`), produced **no children** (`childCount === 0`), and its stage has not
        advanced for at least `STAGNATION_STALE_DAYS` (default e.g. 30) since `createdAt`/
        `lastStageAdvanceAt`. (Keep it a small, documented predicate; false positives are acceptable
        advisory flags, like `isLeech`.) `reasons` is the human-readable subset that fired
        (`"postponed-repeatedly"`, `"no-progress"`, `"no-children"`, `"stale"`).
      - `suggestion: "rewrite" | "convert" | "postpone" | "delete"` — the **recommended** remediation,
        a pure function of the signals: e.g. a `clean_extract` with no children → **convert** (it is
        close to card-ready); a `raw_extract` that is short/already clean → **rewrite**; a deeply
        stale, low-priority, heavily-postponed one → **delete**; otherwise → **postpone** (deliberate
        deferral). Document the mapping; this is advisory.
      - Named exported constants (`STAGNATION_POSTPONE_THRESHOLD`, `STAGNATION_STALE_DAYS`) so a future
        setting can tune them; never hard-code the numbers in the query.
- [ ] **An `ExtractStagnationQuery` in `packages/local-db`**
      (`packages/local-db/src/extract-stagnation-query.ts`, exported + added to `Repositories`):
      `listStagnantExtracts(asOf, options?): ExtractStagnationSummary`:
      - Iterate **live** `extract` elements; for each, read its signals — `stage`/`priority`/
        `createdAt`/`updatedAt`/`dueAt` from the row, `childCount` from `ElementRepository.listChildren`,
        `postponeCount` + `lastStageAdvanceAt` from `OperationLogRepository` (`countPostpones` + the
        newest `update_element` whose `payload.patch.stage` is set — read `payload.patch.stage`, not a
        flat `stage` key, and confirm a real advance via `payload.prev.stage`). **Filter to the
        stage-advance patch shape:** leech/flag/body `update_element` ops carry different payload shapes
        (`{ id, isLeech }`, `{ id, flagged }`, `{ id, body }` — no `patch`), so requiring `payload.patch`
        to touch `stage` keeps them from polluting the signal. Then call `isStagnant(signals, asOf)`.
      - Return `ExtractStagnationSummary = { asOf, rows: StagnantExtractRow[], stagnantCount }` where a
        `StagnantExtractRow` = `{ extract: { id, title, stage, priority, dueAt, createdAt },
        postponeCount, childCount, daysSinceProgress, reasons, suggestion }`, **only** the rows where
        `stagnant === true`, sorted most-stagnant first (e.g. by `postponeCount` desc then
        `daysSinceProgress` desc). `stagnantCount = rows.length`.
      - **One efficient pass:** group the postpone-marker / stage-advance reads from `operation_log`
        by `elementId` rather than N+1 per extract where practical (the op log is indexed by element).
        No schema change.
- [ ] **An `extractStagnation.*` `window.appApi` surface** across the seam, Zod-validated:
      - channel `extractStagnationList` (`extractStagnation:list`).
      - contract (`contract.ts` + `contract.test.ts`): `ExtractStagnationListRequestSchema`
        (`{ asOf?, limit?, offset? }`) + `ExtractStagnationListResult` (the flat summary, the
        `suggestion`/`reasons` as string unions). Mirror the analytics shapes.
      - preload group (`extractStagnation.*`, grouped `window.appApi`, analytics-style); IPC handler;
        `DbService.listStagnantExtracts` (+ `db-service.test.ts`); renderer client a **flat**
        top-level method `appApi.getExtractStagnation(...)` delegating to
        `requireAppApi().extractStagnation.list(...)` (matching the existing flat convention) + types.
      - **No new mutation channel** — the remediation actions reuse the **existing** `extracts.*`
        commands (`extractsRewrite`, `extractsUpdateStage`/convert path, `extractsPostpone`,
        `extractsDelete`) already in `channels.ts`. (Card conversion uses the existing card-creation
        path from an extract — `cards.*` / the builder.)
- [ ] **A "Stagnant extracts" maintenance view in the renderer** — mirror `LeechCleanup.tsx`: a route
      `/maintenance/stagnant` (+ `router.tsx` + a `SECONDARY_NAV` entry) listing each stagnant extract
      with `TypeIcon` + title, its `reasons` (postponed ×N / no progress / no children / stale) as calm
      chips, `postponeCount` + `daysSinceProgress`, and the **suggested** action highlighted among the
      four buttons — **Rewrite** (open the extract editor / `extracts.rewrite`), **Convert** (create a
      card from it — the existing extract→card path), **Postpone** (`extracts.postpone`), **Delete**
      (`extracts.delete`, soft, undoable). Each button calls the existing typed command and removes the
      row optimistically; reuse the global undo `Snackbar`. An `EmptyState` "No stagnant extracts".
      Add a "Stagnant extracts" `Banner` on `AnalyticsScreen` (like the leech/retired banners) linking
      here when `stagnantCount > 0`. **No detection logic in React** — it renders the
      already-computed rows + suggestions and invokes the existing commands.
- [ ] **Tests (Vitest, `packages/scheduler`):** `isStagnant` — an extract postponed ≥ threshold,
      still `raw_extract`, no children, stale → `stagnant: true` with the right `reasons` +
      `suggestion`; an extract that *advanced* to `atomic_statement` → not stagnant (progressed); an
      extract with children → not stagnant (productive); an extract postponed once / recently created
      → not stagnant (boundary cases either side of `STAGNATION_POSTPONE_THRESHOLD` +
      `STAGNATION_STALE_DAYS`); the `suggestion` mapping per stage/priority. Deterministic with a
      fixed `now`.
- [ ] **Tests (Vitest, `packages/local-db`):** seed (via `packages/testing` + `test-db.ts`): a
      raw_extract postponed N times via `ExtractService.postpone` (so real `reschedule_element`
      postpone markers exist) with no children and an old `createdAt` → appears in
      `listStagnantExtracts` with `postponeCount = N`, the reasons, and a suggestion; a sibling extract
      that was `advanceStage`d to `atomic_statement` and/or produced a card → excluded; assert
      `stagnantCount`, the most-stagnant-first sort, and that a soft-deleted extract is excluded.
- [ ] **Tests (Vitest, `DbService` + renderer component):** the `extractStagnation.list` handler
      round-trips; the "Stagnant extracts" view renders rows from a mocked payload, highlights the
      suggested action, and each remediation button calls the right **existing** `extracts.*`/card
      command (mock `window.appApi`).
- [ ] **Playwright E2E** (`tests/electron/extract-stagnation.spec.ts`): on a seeded DB with a
      repeatedly-postponed, never-advanced extract, open `/maintenance/stagnant` → it lists the extract
      with its reasons + suggested action → take a remediation (e.g. Convert to a card, or Delete) →
      the row disappears and the underlying extract reflects the action (a card now exists / the
      extract is in trash) → **restart the app** → the stagnation list recomputes correctly from the
      durable signals.

### Done when

- Extracts that **keep returning without progressing** — postponed repeatedly, stage never advanced,
  no children produced — are **detected** by a pure, unit-tested heuristic
  (`@interleave/scheduler` `isStagnant`, the attention mirror of `isLeech`) and **surfaced** in a
  maintenance view + an analytics banner **with rewrite / convert / postpone / delete suggestions**;
  the detection is correct (unit-tested) and recomputes correctly after **app restart**.
- The heuristic lives in `@interleave/scheduler`, the scan in `packages/local-db`, **never** React;
  detection is **read-only** (no `operation_log`, no schedule change); the remediation suggestions
  invoke the **existing** transactional, op-logged `extracts.*`/card commands (no new mutation path);
  stagnation is an **attention** concern computed from stage/children/postpones, never FSRS `lapses`,
  and an extract is never labeled a "leech".
- The renderer reads it **only** through the typed `extractStagnation.*` `window.appApi` command
  (Zod IPC); no raw DB access; no `db.query`.
- `pnpm typecheck`, `pnpm test`, `pnpm lint`, and the extract-stagnation Playwright spec pass.

### Notes / risks

- **Stagnation is the attention mirror of a leech — keep them separate.** A leech (T040) is an FSRS
  *card* failing repeatedly (`lapses`); stagnation is an attention *extract* never progressing
  (stage/children/postpones). Co-locate the predicates (`leech.ts` + `stagnation.ts` in
  `@interleave/scheduler`) but never compute one from the other's signals. Do not add a "leech" flag
  to extracts and do not add `review_states` to extracts.
- **Reuse the existing postpone marker — no schema change.** The `{ postpone: true, postponeCount }`
  marker in the `reschedule_element` op payload (read via `OperationLogRepository.countPostpones`)
  already exists *precisely for T084* (see the `ExtractService` header). Read it; do not add a
  `postpone_count` column.
- **Suggestions are advisory and reuse existing actions.** T084 adds **no** new mutation primitive:
  rewrite/convert/postpone/delete already exist as T024 `extracts.*` (+ the extract→card path) and
  are each transactional + op-logged + undoable. The query only *recommends* one; the user chooses.
  Keep the suggestion pure + documented so it is testable and tunable.
- **Detect, don't auto-act.** T084 never auto-deletes or auto-postpones a stagnant extract (that
  overload-management instinct is the auto-postpone of M16/T077, and it targets *schedules*, not
  *stagnation*). The view surfaces; the user acts.
- **Tune the thresholds as named constants.** `STAGNATION_POSTPONE_THRESHOLD` +
  `STAGNATION_STALE_DAYS` are documented defaults in `@interleave/scheduler`, overridable by a future
  setting — never a magic number scattered in the query. A freshly created or once-postponed extract
  must not be flagged (the false-alarm floor, like T046's import floor and T083's un-started source).

---

## Exit criteria for T083 + T084

- **T083 (source-yield):** every source shows **read % / extracts created / cards created / mature
  cards / leeches / time spent**, computed by a read-only domain aggregation over
  `elements`/`read_points`/`document_blocks`/`review_states`/`review_logs`/`cards` (via the persisted
  `sourceId` lineage), and **low-yield sources are identifiable** in a ranked, lowest-first view (+
  the inspector "yield" chip), driven by a pure, tunable yield scorer in `@interleave/core`/
  `@interleave/scheduler`.
- **T084 (extract-stagnation):** extracts that **keep returning without progressing** are detected by
  a pure heuristic in `@interleave/scheduler` (the attention mirror of `isLeech`) over the charter's
  signals (stage no-advance / no children / repeated postpones) and surfaced in a maintenance view +
  analytics banner **with rewrite / convert / postpone / delete suggestions** that invoke the existing
  transactional `extracts.*`/card commands.
- Both are **read-only** (no mutation, no `operation_log`, no schedule change), live in
  `packages/local-db` + `packages/core`/`packages/scheduler` (**never** React), keep the
  FSRS-vs-attention split labeled, and **prefer querying existing tables — no new schema** (an
  additive index migration `0021` only if a real query needs it).
- All new capabilities reach the renderer **only** through the new typed `window.appApi` commands
  (`sourceYield.*`, `extractStagnation.*`) with Zod-validated IPC; **no raw DB/filesystem access** is
  exposed to the renderer, and no generic `db.query`.
- Both survive **app restart**: the yield + stagnation numbers recompute from durable tables.
- `pnpm typecheck`, `pnpm test`, `pnpm lint`, and the M17 analytics Playwright specs (source-yield;
  extract-stagnation) are green; the `roadmap.md` boxes for T083 + T084 are checked `[x]` with the
  commit reference.

When T083 + T084 are complete, generate the **T085 (leech remediation workflow)** + **T086
(minimum-information-principle checks)** sections of this file from the roadmap before starting them.
