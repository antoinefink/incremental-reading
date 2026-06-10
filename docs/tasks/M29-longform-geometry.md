# M29 — Long-form geometry & the re-entry payoff (T130–T134)

> A 400-page PDF is the canonical incremental-reading object, and PDF import was a flagship
> Part II milestone — but the 7-state block-processing model exists ONLY for ProseMirror
> document sources: `PdfReader.tsx` and `MediaReader.tsx` contain zero block-processing
> references (verified), so for exactly the formats where IR earns its keep, done-gates, yield,
> and scheduling are structurally blind. The schema documents "One read-point per element"
> (`packages/db/src/schema/relations.ts`), `docs/concept.md`'s own pipeline begins with "skim
> and triage" — zero matching features anywhere — and `needs_later` deferrals are write-only
> (recorded, counted at exit via `doneIntentBreakdown.ts`, never honored on return; zero
> scheduler references). This milestone makes books, papers, and lectures first-class: durable
> geometry, a structural skim gear, and scheduled returns that orient instead of dumping the
> user at a scroll position. Ideation survivor #5 (+#5c/d re-entry payoff).
>
> **Slicing rationale (why this order):** T130/T131 are cheap, ship on existing block rows for
> document sources, and pay off every scheduled return immediately. T132/T133 are the substrate
> build (largest item in Part III) that extends the same payoff — and #1's yield scheduling,
> #6's flow stats, and honest Done breakdowns — to PDF/media. T134 rides on T132's geometry.
>
> **Shared context for every task in this file.** Read
> `docs/solutions/architecture-patterns/durable-source-block-processing-state.md` (the 7-state
> model, content-hash reconciliation, "extracted" derived from live lineage, the markDone gate)
> and `docs/solutions/design-patterns/non-modal-intent-menu-replacing-confirm-gate.md` (the
> breakdown copy derives from domain predicates).
>
> **Standard gates (inherited by every task below):** `pnpm lint` · `pnpm typecheck` ·
> `pnpm test` · relevant `pnpm e2e`; persistence survives restart; mutations transactional +
> op-logged; lineage preserved; UI follows `design/tokens.css` + kit; no unrelated refactors.
>
> **File/line references** verified 2026-06-09/10; re-verify with grep before editing.

---

# T130 — Source re-entry briefing

- **Milestone:** M29 — Long-form geometry & re-entry
- **Status:** `[ ]` not started
- **Depends on:** T083
- **Roadmap line:** opening a scheduled source return renders a since-last-visit briefing —
  read %, new/deferred/stale block counts, descendant card performance, last extraction point —
  computed from existing block and yield rows, with one-click jump to the next unresolved block.

## Goal

The attention scheduler's entire output is "this source returns now" — and today the return
resumes a scroll position with zero synthesis. The briefing makes every scheduled return
cheaper forever: what happened last time, what's outstanding, where to start. Pure read-model
payoff on data the block system already stores.

## Context to load first

- Existing code: block-processing rows + `packages/local-db/src/block-processing-service.ts`
  (per-state counts — the breakdown derivation in `doneIntentBreakdown.ts` shows the predicate
  style), `useReadPoint.ts` (resume — the briefing complements, never replaces it), T083 yield
  + descendant card stats per source, reader header chrome (`SourceReader.tsx` — host surface;
  see the `process-queue-source-reader-*` solutions notes for chrome conventions).
- Invariants: read model behind typed IPC; the briefing renders only on *scheduled returns*
  (arriving via queue/process flow) or when meaningfully stale (e.g. >7 days since last visit) —
  not on every casual open; dismissible per visit.

## Deliverables

- [ ] `SourceReturnBriefing` read model: last-visit timestamp, read% delta, counts by state
      (new/unread, `needs_later`, `stale_after_edit`, needs-reverify when T123 exists),
      descendant card health (count, retention, struggling clusters when T128 exists), last
      extraction point, next-unresolved-block target.
- [ ] Briefing UI at the top of the reader on scheduled returns: compact, dismissible, with
      one-click "jump to next unresolved" (and "jump to first deferred" — T131 deepens this);
      copy derived from domain predicates (no renderer-invented numbers).
- [ ] Tests: unit (read model math on seeded block/yield fixtures; scheduled-return gating);
      e2e — process-queue into a partially-read fixture source, briefing renders correct
      counts, jump lands on the right block, restart-safe.

## Done when

- A source arriving through the queue opens with an accurate since-last-visit briefing and a
  working jump; casual opens stay clean; dismissing it lasts the visit.
- Standard gates pass.

## Notes / risks

- Keep it glanceable: one compact strip, not a dashboard — the user is here to read.

---

# T131 — Honor `needs_later`

- **Milestone:** M29 — Long-form geometry & re-entry
- **Status:** `[ ]` not started
- **Depends on:** T130
- **Roadmap line:** deferred blocks are reachable via a jump rail (listing `needs_later` and
  `stale_after_edit` blocks) and un-deferring/resolving updates the durable state — block
  deferral stops being write-only.

## Goal

A user who marks a paragraph "needs later" today gets nothing back: the mark is counted at exit
and never seen again (zero scheduler references; no navigation). After this task, deferred
blocks are first-class targets on return — a rail lists them, jumping is one key, resolving
updates the durable state. The deferral promise finally pays.

## Context to load first

- Existing code: `needs_later` write path (`ProcessedSpanButtons.tsx` — the marking control)
  and exit counting (`doneIntentBreakdown.ts`); block-state read paths +
  `scheduler-service.ts:137` (the aggregate `unresolvedRatio` — deferred blocks already feed it
  as unresolved); reader decoration machinery (`packages/editor` reader decorations — the rail
  highlights ride this); T130's briefing (the rail is its deep half).
- Invariants: state transitions through the block-processing service (domain-gated like
  `markDone`); rail order = document order; resolving a block from the rail writes the same
  states the inline controls write.

## Deliverables

- [ ] Jump rail in the reader: a collapsible list/strip of `needs_later` +
      `stale_after_edit` (+ needs-reverify when T123 exists) blocks with snippet previews;
      keyboard next/prev-deferred navigation; entry from the T130 briefing.
- [ ] Resolution affordances at the rail/inline: un-defer (back to unread/read), mark read /
      extract (existing verbs), each updating durable block state via the service.
- [ ] Scheduler note: deferred-block presence already pressures return via `unresolvedRatio` —
      verify and add a unit test pinning that contract (no new scheduler input here; T112 owns
      interval shaping).
- [ ] Tests: unit (rail read model, transitions); e2e — defer two blocks, exit (breakdown
      counts them), return via queue, rail lists them, jump + resolve one, counts update,
      restart-safe.

## Done when

- Deferred blocks are visible, navigable, and resolvable on every return; the exit breakdown,
  rail, and block rows always agree; deferral demonstrably round-trips.
- Standard gates pass.

## Notes / risks

- This is the trust-repair task for the marking feature — if the rail is buried, the feature
  stays "write-only" in practice. Make next-deferred a first-class shortcut (T048 registry).

---

# T132 — PDF block-state parity

- **Milestone:** M29 — Long-form geometry & re-entry
- **Status:** `[ ]` not started
- **Depends on:** T064, T065
- **Roadmap line:** PDF sources carry durable per-page/per-region processing state (the
  existing 7-state vocabulary + reconciliation), feeding source progress, Done-intent
  breakdowns, yield, and the scheduler exactly as document blocks do.

## Goal

Give the heaviest sources real geometry: per-page (and per-extracted-region) processing state
for PDFs, in the same 7-state vocabulary the document reader uses — so a 400-page book has
honest progress, an honest Done breakdown, real yield ratios, and scheduler pressure that sees
it. The hard design (durable per-unit state, reconciliation, lineage-derived "extracted") is
already done for documents; this is extension to a second geometry.

## Context to load first

- Existing code: the block-processing schema/service/repository (what a "block row" needs —
  this task generalizes the unit key from ProseMirror block ID to a page/region key for PDF
  sources; inspect how rows join to elements and how reconciliation hashes content),
  `PdfReader.tsx` (page rendering, text layer, region extraction — :107/:869 show the current
  extraction-rectangle overlay; read-point per page), PDF text extraction from T064 (page text
  for content-hashing), DoneIntentMenu breakdown + `unresolvedRatio` consumers (they must Just
  Work once rows exist).
- Invariants: same state vocabulary and transition gates (no PDF-special states); "extracted"
  derived from live output lineage exactly as documents do (region extracts already carry page
  + coordinates — T065); reconciliation on re-import (content-hash per page; a re-OCRed or
  re-imported page transitions to `stale_after_edit` like an edited block).

## Deliverables

- [ ] Unit model: page-level rows for every PDF source (created lazily on first open or at
      import — decide and document; lazy avoids 400-row writes for never-opened files), plus
      region-level derivation for extracted regions (a page with live region extracts counts
      extracted; remaining page text stays unread/read — document the page-state composition
      rule).
- [ ] Reader integration: page states driven by reading position + explicit verbs (mark-read,
      ignore, needs-later at page granularity — a compact per-page affordance, not per-line
      chrome); the existing extraction flows set extracted state via lineage derivation.
- [ ] Consumers verified: source progress, Done-intent breakdown, `sourceProcessing` ratios,
      T083 read%, T130 briefing, T131 rail — all render PDF sources with no special-casing
      (tests per consumer).
- [ ] Reconciliation: page-content hashes; re-import/OCR transitions changed pages to
      `stale_after_edit` (and T123 propagation picks it up when present).
- [ ] Tests: unit (row lifecycle, composition rule, reconciliation); e2e — read a fixture PDF,
      mark pages, extract a region, exit shows an honest breakdown, return shows the briefing,
      restart-safe.

## Done when

- A PDF source reports honest per-page progress everywhere documents do; the Done gate's
  breakdown is populated; yield and scheduler pressure see PDF work; re-import staleness works.
- Standard gates pass.

## Notes / risks

- Largest task in Part III — keep granularity disciplined: PAGES (with regions as derivation
  inputs), not text-line blocks; finer granularity is a non-goal and a tarpit.
- 1000-page fixtures: verify row-count performance against the M20 large-collection harness.

---

# T133 — Media segment states

- **Milestone:** M29 — Long-form geometry & re-entry
- **Status:** `[ ]` not started
- **Depends on:** T073, T074
- **Roadmap line:** audio/video sources track per-segment processed state (derived from
  playback and fragment extraction), feeding the same surfaces — "watched 40%, 2 segments
  deferred" is durable data, not memory.

## Goal

The media analog of T132: lectures and podcasts get durable per-segment state — watched
ranges, deferred segments, extracted fragments — so media sources stop being black boxes to
progress, Done breakdowns, yield, and scheduling.

## Context to load first

- Existing code: `MediaReader.tsx` (playback, timestamped read-point from T073), media-fragment
  extraction (T074 — start/end timestamps; fragments are the "extracted" lineage source),
  T132's generalized unit-key design (segments are time ranges; reuse the same row model with
  a time-range key — coordinate the schema so PDF and media don't fork the table shape),
  transcript availability (T073 — segment boundaries can follow transcript chunks when present,
  else fixed-length windows; document the rule).
- Invariants: same 7-state vocabulary; watched-state derives from actual playback coverage
  (player time-update accumulation, debounced + persisted main-side), never from scrubbing
  past; "extracted" derives from live fragment lineage.

## Deliverables

- [ ] Segment model: time-range rows per media source (transcript-chunk boundaries when
      available, else fixed windows ~2–5 min); playback coverage marks read; explicit verbs for
      ignore/needs-later per segment; fragments set extracted via lineage.
- [ ] Reader integration: a segment strip on the timeline (states color-coded per tokens);
      jump-to-deferred; the T130 briefing + T131 rail consume media segments unchanged.
- [ ] Consumers verified: progress, Done breakdown, yield read%, scheduler ratios for media
      sources (tests per consumer).
- [ ] Tests: unit (coverage accumulation math, segment derivation); e2e — play parts of a
      fixture video, defer a segment, extract a fragment, exit breakdown is honest, return
      briefing + rail work, restart-safe.

## Done when

- A media source reports honest segment-level progress in every surface documents and PDFs do;
  playback genuinely watched is what counts as read.
- Standard gates pass.

## Notes / risks

- Coverage writes are high-frequency — batch/debounce persistence (the read-point pattern
  already solves this; reuse its cadence).

---

# T134 — Structural skim pass

- **Milestone:** M29 — Long-form geometry & re-entry
- **Status:** `[ ]` not started
- **Depends on:** T067, T132
- **Roadmap line:** long-form sources (PDF outline/TOC, EPUB chapters, long documents by
  heading) support a skim pass assigning per-section verdicts — extract-worthy / later /
  ignore — that bulk-set block states (one batch, one undo) and create per-section scheduling,
  so deep reading starts where the value is.

## Goal

The missing middle gear between 1,000 per-block micro-decisions and zero: first contact with a
long source is a pass over its STRUCTURE — triage the table of contents, kill the front matter,
prioritize chapter 7, defer chapter 2 — implementing the "skim and triage" step the product's
own concept doc has always named. Sections become the unit of intent; deep reading starts where
value is instead of at page 1.

## Context to load first

- Existing code: structure sources — PDF outline/bookmarks (PDF.js outline API; fall back to
  heading-detection or page-range chunks when absent), EPUB chapters (T067 already creates
  chapter topics — reconcile: the skim pass should drive THAT machinery, not duplicate it),
  document headings (block tree); T132 page rows + T131 bulk state semantics (verdicts bulk-set
  underlying block/page/segment states in one `batchId`); `docs/domain-model.md` `topic` /
  `rough_topic` (the per-section schedulable unit — sections become child topic elements with
  their own priority + attention schedule); per-section read-points (the "one read-point per
  element" rule holds because sections ARE elements).
- Invariants: verdicts are bulk block-state ops + child-element creation in ONE transaction with
  undo; section elements carry full lineage (source + block/page range); the global source
  schedule and section schedules must not double-surface (decide the rule: a source with
  sectioned children schedules through its sections; the parent becomes a container — document
  and test queue eligibility accordingly, per the backend-canonical-eligibility pattern).

## Deliverables

- [ ] Structure extraction: a per-source outline (PDF outline → page ranges; EPUB chapters;
      document headings → block ranges), with a manual fallback (select a range → "make
      section").
- [ ] Skim surface: outline view with per-section verdict chips — extract-worthy (priority +
      schedule as child section-topic) / later (deferred section, returns via scheduling) /
      ignore (blocks/pages set ignored) — keyboard-first, one batch, one undo.
- [ ] Per-section scheduling: verdict-created sections are attention-scheduled child elements
      (priority inherited/adjustable), each with its own read-point; queue rows show
      "section of <source>"; parent/child surfacing rule implemented + tested.
- [ ] Done-gate integration: section terminal actions route through the DoneIntentMenu with the
      section's own breakdown; the parent's breakdown aggregates sections.
- [ ] Tests: unit (outline extraction per format, verdict batch semantics, surfacing rule);
      e2e — import a fixture PDF with an outline, run a skim pass (mixed verdicts), queue
      surfaces the extract-worthy section first, ignored front matter never surfaces,
      restart-safe.

## Done when

- A 300-page fixture book is triaged at the TOC in under a minute of verdicts; sections
  schedule independently with honest lineage and read-points; ignored matter disappears from
  pressure; one undo reverses a whole skim pass.
- Standard gates pass.

## Notes / risks

- Reconcile with T067's chapter topics FIRST (read its spec + code) — the likely design is
  "skim pass = the verdict UI over the existing chapter-topic machinery, generalized to PDF +
  documents". Do not ship two section concepts.
- Surface-ownership lesson applies (the one reverted decision in `docs/solutions/`): settle the
  parent-vs-section queue-surfacing rule in the spec BEFORE building UI.
