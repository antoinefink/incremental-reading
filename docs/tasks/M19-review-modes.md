# M19 — Review modes (T096)

Detailed, buildable spec for the **review-modes** half of the nineteenth milestone. M19's
roadmap header reads "Review modes, desktop & encryption (T096–T098)", but **only T096 is in
scope for this local-first program**:

- **T097 — Tauri shell** is _deprioritized_. The canonical desktop shell is **Electron**
  (`apps/desktop`, shipped in T050); we do **not** build both Electron and Tauri. **Do not
  spec or build it here.**
- **T098 — Backup encryption hardening & audit** protects _cloud backups_ for the future
  server phase. There is no live sync in the local-first MVP. **Out of scope for this program;
  do not spec or build it here.**

This file therefore specs **T096 only**. When T096 is `[x]`, this milestone's review-modes
work is complete; T097/T098 stay parked.

T096 adds **targeted review modes**: review a chosen **subset** of cards — by **concept**,
**source**, **search query**, **branch** (a lineage subtree), **stale** items (T090),
**leeches** (T040), or a **random audit** — **outside normal scheduling**. Unlike the daily
session (T037), which surfaces only cards whose FSRS `review_states.due_at ≤ now`, a review
mode reviews its subset **regardless of due date**. Crucially, a review is still a review:
**grading writes a durable `review_logs` row and advances FSRS** through the existing
`CardSchedulerService` → `ReviewRepository.recordReview` path — only the **selection** ignores
the due-date filter. The FSRS-vs-attention split holds: review modes review **cards only**.

The architecture is unchanged and non-negotiable (see [`../../CLAUDE.md`](../../CLAUDE.md) and
the roadmap header): the React **renderer** (`apps/web`) never touches SQLite, Node, or the
filesystem. Every read flows React UI → typed client wrapper (`apps/web/src/lib/appApi.ts`) →
preload bridge (`apps/desktop/src/preload/index.ts`) → validated IPC (Zod) on the main side
(`apps/desktop/src/main/ipc.ts`) → the `DbService` (`apps/desktop/src/main/db-service.ts`) →
`packages/local-db` repositories / `packages/scheduler` services → SQLite. The mode **selection**
queries are **READ-ONLY** in `packages/local-db` (no SQL in React, no new generic `db.query`).
The only **mutation** in this feature is `review.grade` — which already exists (T037) and is
reused **verbatim**: it runs in one transaction and appends an `add_review_log` `operation_log`
row. Soft-delete and lineage are sacred; the feature survives **app restart**.

> **No new schema (prefer NONE).** T096 is overwhelmingly a new **selection** over existing
> tables. Every selection dimension already has a read seam:
>
> | Mode | Existing selection seam (real, cited) |
> |------|----------------------------------------|
> | `concept` | `ConceptRepository.elementsForConcept(conceptId)` → live member element ids (`packages/local-db/src/concept-repository.ts:516`) |
> | `source` | the owning-source rollup: `elements.source_id` (and/or `LineageQuery`) — cards under a source |
> | `branch` | `LineageQuery.get(id)` → `LineageData.nodes` (the lineage subtree; `packages/local-db/src/lineage-query.ts:86`) |
> | `search` | `SearchRepository.search(query, { type: "card" })` → ranked FTS card hits (`packages/local-db/src/search-repository.ts:164`) |
> | `semantic` | `DbService.semanticSearch` → `SemanticSearchRepository.search` (FTS+`vec0` KNN fusion; `apps/desktop/src/main/db-service.ts:1980`, `packages/local-db/src/semantic-search-repository.ts:86`) — an optional sub-mode of `search` |
> | `stale` | the T090 `cards` lifetime columns (`valid_until`/`review_by`) + `deriveExpiryStatus(lifetime, new Date(now))` (`packages/db/src/schema/cards.ts:120`, `@interleave/core`) |
> | `leech` | `ReviewRepository.listLeechCards()` → durable `cards.is_leech` rows (`packages/local-db/src/review-repository.ts:572`) |
> | `random` | a bounded random sample of live cards (a new read, but no schema) |
>
> Each selection resolves to an **ordered list of card element ids**, which the existing
> `toReviewCardView` (`apps/desktop/src/main/db-service.ts:3529`) turns into the SAME
> reveal-ready `ReviewCardView` the daily session ships. **No migration.**

Read first:

- [`../scheduling-and-priority.md`](../scheduling-and-priority.md) — the **Card scheduler
  (FSRS)** section (a graded review always advances FSRS state and writes a `review_logs` row)
  and the two-scheduler split (FSRS = cards; attention = sources/topics/extracts). Review modes
  do **not** change scheduling — they change **what is selected for review**, then grade
  through the unchanged FSRS path.
- [`../../CLAUDE.md`](../../CLAUDE.md) — **"Review rules"** (every review creates a durable
  review log; reveal / grade / edit / open source / suspend / delete; siblings not
  back-to-back) and the architectural layering (renderer → `window.appApi` → IPC → `DbService`
  → repositories; **no raw DB/filesystem to the renderer**).
- [`../domain-model.md`](../domain-model.md) — `Element` + lineage (`card → source location →
  source`), concept membership, the `derived_from`/`references` edges, soft-delete.
- [`../design-system.md`](../design-system.md) — the `screen-review` row (`rcard`, grade
  buttons, `FsrsStats`, `SchedulerChip`, the leech `Banner`) and the `screen-library` /
  `screen-queue` surfaces (where the mode-entry affordances live).
- Design kit (immutable reference): `design/kit/app/screen-review.jsx` (the review session this
  feature **reuses** — the only addition is a calm "mode header" chip describing the subset);
  `design/kit/app/screen-library.jsx` (the library/search/knowledge-map surface where
  "Review these" is offered).

## What already exists (inspect before building — do not duplicate)

T096 is a thin selection + entry layer over a fully built review session and seven already-built
read seams. **Build over these; do not re-implement any of them.**

- **The review session (T037–T040) is complete.** `apps/web/src/review/ReviewScreen.tsx` is the
  real session: it walks a deck via `appApi.reviewSessionNext({ exclude, recentSiblingGroups })`,
  reveals on `Space`, fetches the four previews via `review.preview`, grades via `review.grade`
  (response time measured), buries siblings, surfaces the leech `Banner`, and shows a completion
  summary. **T096 reuses this component** — it must run a mode-selected, non-due deck with the
  same reveal/grade/preview UI.
- **The `review.*` IPC surface (T037) exists end to end:** channels `reviewSessionNext`
  (`review:session:next`), `reviewCard` (`review:card`), `reviewPreview` (`review:preview`),
  `reviewGrade` (`review:grade`), `reviewLeeches` (`review:leeches`)
  (`apps/desktop/src/shared/channels.ts:107`); the Zod request schemas + result types in
  `contract.ts` (`ReviewSessionNextRequest`/`Result`, `ReviewCardRequest`/`Result`,
  `ReviewPreviewRequest`/`Result`, `ReviewGradeRequest`/`Result`,
  `apps/desktop/src/shared/contract.ts:3214`); the IPC handlers (`apps/desktop/src/main/ipc.ts:1001`),
  the preload `review` group (`apps/desktop/src/preload/index.ts:307`), and the renderer
  client (`apps/web/src/lib/appApi.ts:3939`). **`review.preview` and `review.grade` are reused
  verbatim** — a graded card in a mode is graded exactly like a daily card.
- **`DbService.toReviewCardView(cardElementId, asOfMs)`** (`apps/desktop/src/main/db-service.ts:3529`)
  already turns ANY card element id into the full reveal-ready `ReviewCardView` (prompt / answer
  / cloze / `SourceRef` lineage / `expiry` (T090) / FSRS signals / `leech` / `lapses` /
  `siblingGroupId` / occlusion / media). **This is the seam every mode deck reuses** — a mode
  selects ids, this builds the views. `DbService.reviewCard` already exposes the by-id read for
  the process loop (T031), proving the "ordered non-due set, walked by cursor" pattern.
- **The seven selection seams already exist** (the table above): `elementsForConcept`,
  `LineageQuery.get`, `SearchRepository.search`/`query`, `DbService.semanticSearch` /
  `SemanticSearchRepository.search`, the T090 lifetime columns + `deriveExpiryStatus`, and
  `ReviewRepository.listLeechCards`. **None of them are card-only by themselves** (concept/
  lineage/search return mixed element types) — T096's job is to **filter each to live `card`
  elements and order them**, not to re-query.
- **`ReviewSessionService`** (`packages/local-db/src/review-session-service.ts`) is the existing
  due-deck selection seam (sibling-aware, budget-bounded). T096 adds a **sibling** selection
  service for the non-due mode decks; do not bend `ReviewSessionService`'s due read to also do
  mode selection — keep the due session and the mode session as two clearly-labeled selections.

## What T096 must add (the gap)

1. A **mode model** in `@interleave/core` — the closed set of review-mode kinds + a typed
   selector — so the domain union and the IPC Zod schema can't drift.
2. A **read-only `ReviewModeService`** in `packages/local-db` that, given a mode + parameter,
   resolves an **ordered list of live `card` element ids** by composing the existing selection
   seams (above), filtered to cards, **ignoring `review_states.due_at`**.
3. Two new **read** commands on the `review.*` group — `review.modeDeck` (resolve the ordered
   card-id deck + a count + a label for a mode) and `review.modeCount` (a cheap count for the
   entry affordances) — wired across channels + contract + preload + ipc + db-service + client.
   The **grade/preview/card** reads are unchanged.
4. **Generalize `ReviewScreen`** to accept an optional **review mode** (default: the daily due
   session). In mode, it walks the mode deck (not the due deck), shows a calm **mode header**
   ("Reviewing 12 cards · Concept: _Spaced repetition_ · outside scheduling"), and reveals /
   previews / grades through the unchanged `review.*` path.
5. **Mode-entry affordances** on the existing surfaces (library/search/concepts/branch/leech/
   maintenance) — a "Review these" button that opens `/review` in the chosen mode.
6. Tests: a **unit test per selection query** (`ReviewModeService`) + a **DbService**
   integration (a graded non-due mode card writes `review_logs` + advances FSRS) + a
   **Playwright E2E** running a non-due subset session that survives restart.

---

## T096 — Branch/subset/semantic review modes

- **Status:** `[ ]`  · **Depends on:** T087, T037
- **Roadmap line:** Done when: review by concept, source, search query, branch, stale items,
  leeches, or random audit works outside normal scheduling.

### Goal

The user can launch a **targeted review session over a chosen subset of cards** — every card of
a **concept**, of a **source**, matching a **search query** (keyword or semantic), under a
**branch** (a lineage subtree), every **stale** card (T090), every **leech** (T040), or a
**random audit** sample — and review it with the full T037 session (reveal → grade
Again/Hard/Good/Easy → next-interval previews → advance). The selection deliberately **ignores
the normal due-date filter**: a card not yet due can still be reviewed in a mode. Grading is
unchanged — it still writes a durable `review_logs` row and advances the card's FSRS state via
`CardSchedulerService` → `ReviewRepository.recordReview` (a review is a review). The selection
is computed **main-side** from a typed mode; the renderer holds only the mode descriptor + the
existing session/UI state. Review modes are **cards only** — the two-scheduler split is intact.

### Context to load first

- Reference: `scheduling-and-priority.md` (FSRS card scheduler; the two-scheduler split — modes
  do not change scheduling, only selection); `CLAUDE.md` "Review rules" (durable log per review)
  + the layering rules; `domain-model.md` (lineage, concept membership, soft-delete).
- Existing code to inspect:
  - **Session (reuse, do not re-implement):** `apps/web/src/review/ReviewScreen.tsx` (the
    deck-walk via `reviewSessionNext`, reveal, `review.preview`, `review.grade`, the leech
    `Banner`, the completion summary); `apps/web/src/router.tsx` (`/review` route, `reviewRoute`).
  - **The `review.*` surface (reuse grade/preview/card; add modeDeck/modeCount):**
    `apps/desktop/src/shared/channels.ts:107` (`reviewSessionNext`/`reviewCard`/`reviewPreview`/
    `reviewGrade`/`reviewLeeches`); `apps/desktop/src/shared/contract.ts:3214` (the request/
    result schemas + `ReviewCardView`); `apps/desktop/src/main/ipc.ts:1001`;
    `apps/desktop/src/preload/index.ts:307`; `apps/web/src/lib/appApi.ts:3939`.
  - **The view builder (reuse):** `DbService.toReviewCardView` (`db-service.ts:3529`) — id →
    full `ReviewCardView`; `DbService.reviewCard`/`reviewPreview`/`reviewGrade`
    (`db-service.ts:3749`+) — the unchanged grade path (`gradeCard` →
    `ReviewRepository.recordReview` → `add_review_log`, T037).
  - **The selection seams (compose, filter to cards):**
    - concept: `ConceptRepository.elementsForConcept(conceptId)` (`concept-repository.ts:516`)
    - source: cards under a source — `elements.source_id = sourceId` filtered to `type: "card"`
      (mirror `QueueRepository`'s join shape); optionally via `LineageQuery`
    - branch: `LineageQuery.get(id)` → `LineageData.nodes` (`lineage-query.ts:86`), keep
      `type === "card"` nodes
    - search (keyword): `SearchRepository.search(query, { type: "card", limit })`
      (`search-repository.ts:164`) → ordered `SearchHit[]`
    - search (semantic): `DbService.semanticSearch({ q })` (`db-service.ts:1980`) →
      `SemanticSearchRepository.search` (FTS+`vec0` KNN fusion, T087); cards only
    - stale: the T090 `cards` lifetime columns (`valid_until`/`review_by`,
      `packages/db/src/schema/cards.ts:120`) + `deriveExpiryStatus(lifetime, new Date(now))` from `@interleave/core`
      — keep cards whose status is `due_for_review` or `expired`. **Do not full-scan the
      collection**: first run a bounded SQL prefilter to the cards that CAN expire
      (`valid_until IS NOT NULL OR review_by IS NOT NULL`, cheap via `cards_review_by_idx`,
      `cards.ts:147`), then run `deriveExpiryStatus` only over that candidate set. This mirrors the
      T092 verification-task scan `TaskService.generateVerificationTasks`
      (`packages/local-db/src/task-service.ts:308`), which joins `cards`→`elements`, drops
      soft-deleted rows, and skips `if (!lifetime.validUntil && !lifetime.reviewBy) continue` —
      reuse that candidate shape rather than scanning every card row before `MAX_REVIEW_MODE_DECK`
      caps anything
    - leech: `ReviewRepository.listLeechCards()` (`review-repository.ts:572`) → durable
      `cards.is_leech` rows (already cards, already ordered most-lapsed-first)
    - the due-deck selection precedent: `ReviewSessionService` (`review-session-service.ts`).
  - **Settings / fixtures:** `packages/local-db/src/test-db.ts` (in-memory `better-sqlite3` for
    unit/integration tests); the T009 seed (cards with review states) for the E2E.
- Invariants in play: selection is **read-only** (`packages/local-db`); the deck is **cards
  only**; selection **ignores `review_states.due_at`** (the defining behavior); grading is the
  **unchanged** `review.grade` path (one transaction + `add_review_log`); soft-deleted /
  `deleted` / (optionally) suspended cards are excluded from a deck; lineage is preserved; the
  feature survives **app restart**; **no new generic `db.query`**; **prefer no migration**.

### Deliverables

- [ ] **Mode model in `@interleave/core`** — a new framework-free `review-mode.ts` (the
      `task.ts`/`ai.ts` pattern: a closed tuple + guards, no DB/React imports), the **single
      source of truth** for both the domain union and the IPC Zod schema:
  - `REVIEW_MODE_KINDS = ["concept", "source", "branch", "search", "semantic", "stale", "leech",
    "random"] as const` + `ReviewModeKind` + `isReviewModeKind`.
  - `REVIEW_MODE_LABEL: Record<ReviewModeKind, string>` (calm UI labels: "Concept", "Source",
    "Branch", "Search", "Semantic", "Stale", "Leeches", "Random audit") + a defensive
    `reviewModeLabel(kind)` fallback.
  - A discriminated `ReviewModeSelector` describing each mode's parameter:
    `{ kind: "concept"; conceptId: ElementId }` | `{ kind: "source"; sourceId: ElementId }` |
    `{ kind: "branch"; rootId: ElementId }` | `{ kind: "search"; query: string }` |
    `{ kind: "semantic"; query: string }` | `{ kind: "stale" }` | `{ kind: "leech" }` |
    `{ kind: "random"; size: number; seed?: number }`. The optional `random.seed` is what makes
    the "seed travels in the descriptor" claim true: the runner mints a seed once when the random
    mode is launched (e.g. on the entry affordance) and carries it in the selector, so the same
    descriptor reproduces the same sample on a re-read; it is **not** persisted to the DB. A
    `MAX_REVIEW_MODE_DECK` constant (e.g. `500`) caps any deck (so a 100k collection can't build an
    unbounded session).
  - Re-export from `packages/core/src/index.ts`.
- [ ] **`ReviewModeService` (read-only) in `packages/local-db`** — `review-mode-service.ts`,
      constructed from the existing `Repositories` (like `LineageQuery`/`TaskService`), exposing:
  - `deck(selector: ReviewModeSelector, now: IsoTimestamp): ReviewModeDeck` where
    `ReviewModeDeck = { cardIds: ElementId[]; total: number; label: string; truncated: boolean }`.
    It resolves the selector to an **ordered list of LIVE `card` element ids**, by composing the
    cited seams and then **always**:
    - keeping only `type === "card"` elements that are **not** soft-deleted and **not** in the
      out-of-deck statuses (`deleted`; treat `suspended` as excluded by default — a suspended
      card is repaired in the leech remediation view (`LeechRemediation`), not surfaced in a mode);
      and **excluding T082-retired cards** (`cards.is_retired = true`) — mirror the daily deck,
      which `innerJoin`s `cards` and filters `eq(cards.isRetired, false)`
      (`packages/local-db/src/queue-repository.ts:73`). `toReviewCardView` does NOT itself drop
      retired cards (it checks only `type` + `deletedAt`), so the resolvers must apply the
      `is_retired = false` predicate themselves — a card the user explicitly retired stays out of
      a mode deck, exactly as it stays out of `dueCards` (T082's "review fewer, keep them");
    - **ignoring `review_states.due_at`** (the whole point — a non-due card is included);
    - applying `MAX_REVIEW_MODE_DECK` (set `truncated: true` when the underlying set exceeds it);
    - choosing a **deterministic, sensible order per mode** — search/semantic keep the ranked
      hit order; leech keeps most-lapsed-first; stale keeps most-overdue-first (or `review_by`
      asc); concept/source/branch order by `priority` desc then creation order (high-value first,
      mirroring the attention queue's bias); random uses a seeded shuffle so a deck is stable and
      reproducible — seed from `selector.seed` when present (it travels in the descriptor, not the
      DB), else fall back to a deterministic default. Note this is belt-and-suspenders: the deck is
      also fetched ONCE on mount and walked by index (see the renderer section), so within-session
      stability holds even without a transported seed; the `seed` exists so a re-read (e.g. a
      remount, or `count` then `deck`) reproduces the SAME sample rather than reshuffling.
  - `count(selector, now): { total: number }` — a cheap count for the entry affordances (it may
    short-circuit before building full views).
  - Per-mode resolvers kept as small private methods (`conceptCardIds`, `sourceCardIds`,
    `branchCardIds`, `searchCardIds`, `semanticCardIds`, `staleCardIds`, `leechCardIds`,
    `randomCardIds`) so each is unit-testable in isolation. The **semantic** resolver needs the
    pre-computed query vector (the embed runs in the runner, not here) — so `ReviewModeService`
    takes an **optional injected `queryVector`** for the semantic mode (mirroring
    `SemanticSearchRepository.search`'s `queryVector` option, `semantic-search-repository.ts:59`);
    when absent / semantics disabled / `vec0` unavailable, the semantic mode **degrades to the
    keyword (`search`) resolver** (never an error — calm fallback). The DB service supplies the
    vector via the existing `embedQuery` seam.
  - Re-export from `packages/local-db/src/index.ts`.
- [ ] **Two READ commands on the `review.*` group** (no new top-level group), Zod-validated,
      following the established `review.*` pattern exactly:
  - **channels** (`apps/desktop/src/shared/channels.ts`): `reviewModeDeck` (`review:mode:deck`),
    `reviewModeCount` (`review:mode:count`).
  - **contract** (`apps/desktop/src/shared/contract.ts`): a `ReviewModeSelectorSchema` Zod
    discriminated union mirroring `@interleave/core`'s `ReviewModeSelector` (validate
    `conceptId`/`sourceId`/`rootId` as `ElementIdSchema`, `query` as a bounded string,
    `random.size` as a bounded int, `random.seed` as an optional bounded int); then —
    - `review.modeDeck({ selector, asOf? }) → { deck: ReviewCardView[]; total: number;
      label: string; truncated: boolean }`. It resolves the ordered card-id deck via
      `ReviewModeService.deck`, then maps each id through the existing `toReviewCardView` so the
      renderer gets the SAME reveal-ready views the daily session ships (answer/ref hidden until
      reveal — review stays local + fast, no per-card round-trip). **Read-only** — no mutation,
      no `operation_log`.
    - `review.modeCount({ selector, asOf? }) → { total: number; label: string }` — the cheap
      count for the entry affordances.
  - **IPC** (`apps/desktop/src/main/ipc.ts`): two validated handlers.
  - **preload** (`apps/desktop/src/preload/index.ts`): `review.modeDeck` / `review.modeCount`
    on the existing `review` group.
  - **DbService** (`apps/desktop/src/main/db-service.ts`): `reviewModeDeck(request)` and
    `reviewModeCount(request)` — construct/cache a `ReviewModeService` per open DB (mirror the
    `reviewSession` field init at `db-service.ts:700`); for the **semantic** selector, await the
    `embeddingService.embedQuery(query)` (the `semanticSearch` path, `db-service.ts:1985`) and
    pass the vector into the service (degrading to keyword when semantics are off / `vec0`
    unavailable). The grade/preview/card commands are **untouched**.
  - **renderer client** (`apps/web/src/lib/appApi.ts`): mirror `reviewModeDeck`/`reviewModeCount`
    + the `ReviewModeSelector`/`ReviewCardView`-deck types on the `review` group.
- [ ] **Generalize `ReviewScreen` to run a mode** (`apps/web/src/review/ReviewScreen.tsx` +
      `apps/web/src/router.tsx`):
  - Add an **optional `mode?: ReviewModeSelector`** input to the screen (threaded from the route
    — e.g. `/review` with `?mode=concept&conceptId=…`). Read the descriptor from **loose search
    params** via `useSearch({ strict: false })` (the same pattern `ReviewScreen` already uses for
    `asOf` at `ReviewScreen.tsx:106` — the route declares no `validateSearch`, so do **not**
    introduce one; loose search is the codebase convention, e.g.
    `reader/navigateToLocation.ts:66`, `maintenance/StagnantExtracts.tsx:76`), then validate the
    kind in the renderer with the
    `@interleave/core` `isReviewModeKind` guard before constructing the selector. With **no
    mode**, behavior is exactly today's daily due session (`reviewSessionNext`) — a pure no-op for
    existing flows.
  - With a mode: on mount, call `review.modeDeck({ selector })` ONCE to get the ordered
    `ReviewCardView[]` + `total` + `label` + `truncated`; walk the deck **by index** (the
    process-loop precedent — a frozen ordered set + a cursor + an `exclude`/seen set), revealing
    via the local view, previewing via the unchanged `review.preview`, grading via the unchanged
    `review.grade`. **Sibling burying still applies within the deck** (reuse the existing
    `recentSiblingGroup` skip over the in-memory ordered deck, or — cleaner — pass `exclude` +
    `recentSiblingGroups` to a mode-aware `nextReviewCard`; keep the burying logic main-side per
    T039's invariant, not in React).
  - Render a calm **mode header** above the `rcard` (a chip row, design-system tokens): the mode
    `label` + the subset size + an explicit "outside scheduling" hint ("Reviewing 12 cards ·
    Concept: _Spaced repetition_ · not limited to what's due") and a **"× exit mode"** affordance
    back to the daily session. Show a `truncated` note when the deck was capped
    ("showing the first 500 of N"). Reuse the existing reveal/grade/preview/leech-`Banner`/
    completion-summary UI unchanged.
  - The completion summary makes clear this was a **targeted** session (per-grade `Metric`s +
    "Reviewed N of the {label} subset"), and offers "back to daily review".
- [ ] **Mode-entry affordances** on the existing surfaces (calm "Review these" buttons that
      route to `/review` in the chosen mode — small, additive, no new screens):
  - **Concept** — `apps/web/src/concepts/ConceptsScreen.tsx` (a concept row's "Review N cards").
  - **Search / Semantic** — `apps/web/src/library/` (`LibraryScreen`/`BrowseScreen`): a "Review
    matching cards" action on a search result set (keyword) + a "Review semantically related"
    when semantics are enabled (`semanticSearchEnabled`).
  - **Branch** — the lineage/hierarchy view (`LineageTree`, T023): "Review this branch" from a
    `source`/`topic`/`extract` node (reviews the cards in its subtree).
  - **Source** — a source's inspector/reader header: "Review this source's cards".
  - **Stale** — the maintenance/expiry surface (T090/T092): "Review stale cards".
  - **Leeches** — the leech remediation view (T040, `apps/web/src/maintenance/LeechRemediation.tsx`):
    "Review leeches" (in addition
    to the existing rewrite/suspend/delete).
  - **Random audit** — the review entry / home command center: "Audit N random cards".
  - Each affordance calls `review.modeCount` to show the subset size and is **omitted/disabled
    when the subset is empty** (a calm empty state, never a dead button). The renderer never
    computes the selection — it sends a typed selector.
- [ ] **Tests (Vitest, `packages/local-db` — one per selection query):** a
      `review-mode-service.test.ts` over an in-memory DB (`test-db.ts`) asserting, for **each**
      mode:
  - the resolver returns **only live `card` element ids** (excludes soft-deleted, `deleted`,
    suspended, **and T082-retired cards** (`cards.is_retired = true`); excludes non-card members of
    a concept/branch/search) — assert a retired card is dropped, mirroring `dueCards`;
  - the deck includes a card **whose `review_states.due_at` is in the FUTURE** (the load-bearing
    "outside scheduling" assertion — a not-due card IS selected, unlike `dueCards`);
  - the order is the documented per-mode order (search keeps rank; leech most-lapsed-first;
    stale most-overdue-first; concept/source/branch priority-desc);
  - `concept` resolves via `elementsForConcept`; `branch` resolves the lineage-subtree cards via
    `LineageQuery`; `stale` includes only `due_for_review`/`expired` cards (via
    `deriveExpiryStatus`) and excludes both a fresh card and a card with **no** lifetime
    constraint (`valid_until`/`review_by` both `NULL` — outside the prefilter candidate set);
    `leech` returns exactly the `listLeechCards` set; `random` returns a bounded, seed-stable
    sample (and the SAME sample for the same `seed`);
  - `MAX_REVIEW_MODE_DECK` caps the deck and sets `truncated`;
  - the **semantic** resolver with no `queryVector` (semantics off) **degrades to the keyword
    resolver** (same card ids as `search`), never throwing.
- [ ] **Tests (Vitest, `DbService`):** `reviewModeDeck` maps the selected ids through
      `toReviewCardView` (full reveal-ready views, answer present-but-hidden); grading a
      **non-due** card returned by a mode deck (via the unchanged `gradeCard`) **writes exactly
      one `review_logs` row**, advances `review_states` (due/stability/difficulty/reps/lapses/
      state) + `elements.due_at`, and logs `add_review_log` — all in one transaction (the same
      assertion T037 makes, now proving it holds for a non-due mode card). The semantic mode
      path is exercised with an injected fake `queryVector` (no model, no network) and with
      semantics disabled (keyword degrade).
- [ ] **Tests (Vitest, `@interleave/core`):** `review-mode.test.ts` — the closed tuple +
      `isReviewModeKind` + labels (incl. the defensive fallback) + the selector discriminant.
- [ ] **Tests (Vitest, renderer):** `ReviewScreen` in mode renders the mode header + subset
      size, walks the `review.modeDeck` deck (mock `appApi.review`), reveals + grades through the
      unchanged `review.grade`/`review.preview`, and shows the targeted completion summary; with
      no mode it still runs the daily due session (no regression). A concept/leech entry
      affordance routes to `/review` with the right selector and is omitted on an empty subset.
- [ ] **Playwright E2E** (`tests/electron/review-modes.spec.ts`): seed (T009) a concept with ≥2
      cards where **at least one is NOT due** (a future `review_states.due_at`) → open `/review`
      in `concept` mode → assert the **not-due** card appears in the deck (it would NOT appear in
      the daily session) → reveal → grade across ratings → assert a `review_logs` row was written
      and `review_states.due_at` advanced for the graded card → **restart the Electron app** →
      the logs + rescheduling persist. Add at least a smoke pass for a second mode (e.g. `leech`
      or `search`) confirming a non-due subset session runs and persists.
- [ ] **Docs:** check the T096 box in `roadmap.md` with the commit ref; note in the progress log
      that T097 (Tauri) + T098 (encryption) remain out of scope / parked.

### Done when

- Review by **concept, source, search query (keyword + semantic), branch, stale items, leeches,
  and random audit** works **outside normal scheduling**: each launches a real review session
  over its subset of cards, **including cards that are not yet due**, with the full T037 session
  (reveal → grade Again/Hard/Good/Easy → next-interval previews → advance).
- Grading a mode card writes a durable `review_logs` row and advances FSRS through the
  **unchanged** `CardSchedulerService` → `ReviewRepository.recordReview` path (one transaction +
  `add_review_log`); only the **selection** ignores the due-date filter. The two-scheduler split
  holds — modes review **cards only**; no `review_states`/FSRS row is touched for a non-card.
- The selection logic lives in `packages/local-db` (`ReviewModeService`, read-only) +
  `@interleave/core` (the mode model), **never** in React; the renderer reaches it only through
  the new typed `review.modeDeck`/`review.modeCount` IPC commands (Zod-validated). **No raw DB/
  filesystem access is exposed to the renderer; no generic `db.query`.**
- **No new schema / no migration** (T096 is selection over existing tables).
- The mode session and its rescheduling **survive app restart**; lineage is preserved.
- `pnpm typecheck`, `pnpm test`, `pnpm lint`, and the review-modes Playwright spec pass.

### Notes / risks

- **A review is a review — reuse, don't fork.** `review.preview` and `review.grade` are reused
  verbatim; the ONLY new reads are `review.modeDeck`/`review.modeCount`. Do **not** add a parallel
  grade path or a "mode review log" — a graded mode card and a graded daily card are
  indistinguishable in `review_logs` (correct: both advance the same FSRS state).
- **Selection ignores due, not liveness.** The defining behavior is dropping the
  `review_states.due_at ≤ now` filter — but every other deck guard stays (live, `card`-typed,
  not soft-deleted, not `deleted`, suspended excluded by default, **and T082-retired cards
  excluded** — `cards.is_retired = false`, mirroring `dueCards` at `queue-repository.ts:73`; a
  retired card is suppressed from the daily session and must be suppressed from a mode too). A
  mode is "review THIS subset", not "review everything".
- **Each underlying seam returns mixed types** (concept members / lineage nodes / search hits can
  be sources/extracts/cards). T096's resolvers **must filter to `card`** — assert this in the
  per-mode unit tests. Do not re-query; filter the existing read's output.
- **Semantic mode embeds in the runner, not the selection layer.** `ReviewModeService` is a
  synchronous read; the query vector is computed by the DB service via the existing
  `embeddingService.embedQuery` (T087) and injected. Keep `ReviewModeService` free of any
  embedding/model/network call — and degrade semantic → keyword when semantics are off / `vec0`
  unavailable, exactly as `SemanticSearchRepository` does (calm fallback, never an error).
- **Cap the deck.** `MAX_REVIEW_MODE_DECK` keeps a 100k-card collection from building an
  unbounded session; surface `truncated` so the UI is honest ("first 500 of N"). T100 load-tests
  this; leave the cap a named constant a future setting can override.
- **Random must be deterministic within a session** (a seeded shuffle). Two mechanisms combine:
  the mode deck is fetched ONCE on mount and walked by index, so it can't reshuffle mid-session;
  and the optional `random.seed` in the selector lets a re-read (remount, or `count` then `deck`)
  reproduce the SAME sample. The runner mints the seed when the random mode is launched and carries
  it in the descriptor; it is NOT persisted to the DB.
- **Sibling burying still applies** within a mode deck (T039's invariant: session-ordering only,
  no `review_states` mutation). Keep the burying selection main-side; the renderer threads opaque
  group ids, never computing relationships.
- **Out of scope (explicit):** **T097 (Tauri shell)** — deprioritized; the canonical shell is
  Electron (T050); do not build it. **T098 (backup encryption hardening & audit)** — protects
  cloud backups for the future server phase; there is no live sync in the local-first MVP; do not
  build it. Neither is specced here.
- **Downstream:** the random-audit + mode entry points are natural homes for later
  maintenance/QA work (T099/T100) and for a future "review by tag" or "review by priority band"
  mode — keep `ReviewModeSelector` a discriminated union so a new kind is an additive case, not a
  rewrite.

---

## Exit criteria for M19 (review-modes scope)

- **T096 is `[x]`** in [`../roadmap.md`](../roadmap.md) with its commit reference.
- Targeted review over **concept / source / search (keyword + semantic) / branch / stale /
  leech / random** works **outside normal scheduling** in the Electron desktop app, reusing the
  T037 session; grading writes durable `review_logs` + advances FSRS unchanged; the selection is
  read-only `packages/local-db` + `@interleave/core`, reached only via typed
  `review.modeDeck`/`review.modeCount` IPC; **no new schema**; survives **app restart**.
- `pnpm typecheck`, `pnpm test`, `pnpm lint`, and the review-modes Playwright spec are green.
- **T097 (Tauri) and T098 (backup encryption) remain parked / out of scope** for this
  local-first program and are NOT implemented under M19.

When T096 is complete, generate `tasks/M20-scale-hardening.md` from the roadmap before starting
T099.
