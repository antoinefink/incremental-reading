---
date: 2026-06-09
updated: 2026-06-10
topic: gold-standard-incremental-reading
focus: >
  Determine precisely what is missing or inadequate for Interleave to be a gold-standard
  incremental reading application. No scope creep — key workflows and features only.
mode: repo-grounded
---

# Ideation: What separates Interleave from gold-standard incremental reading

**Verdict:** Interleave has gold-standard *sensors* and MVP-grade *actuators*. The mechanics the
canon demands (importers, two schedulers, priority bands, block-level processing states,
analytics, AI infrastructure) are built; what is missing is the closed loop. Signals are
computed, threaded through the type system, durably persisted — and then dropped before they
change what the system does. Nearly every survivor below consumes data the app already
captures: these are completions of existing systems, not new surfaces.

Evidence trail for the open-loop pattern (each independently verified in this pass):

- `packages/scheduler/src/attention-scheduler.ts:104-112` marks `lastSeenAt` "RESERVED —
  deliberately NOT consumed by `nextDueAt` … this axis has zero effect on the output today".
- `retirementSuggestion` is computed in the scheduler and threaded through `SchedulerService`
  (`packages/local-db/src/scheduler-service.ts:190,265`); zero consumers exist in `apps/web`.
- `packages/scheduler/src/stagnation.ts` self-describes as "advisory + read-only. It never
  mutates, never schedules" — and scopes stagnation to extracts only (`stagnation.ts:16-22`).
- Postpone provenance is op-logged per element (`reschedule_element` ops, auto-postpone
  `batchId` batches, `schedulerSignals.postponed` on queue rows) and never aggregated anywhere.
- T079 lets users set per-concept retention targets; nothing reports per-concept results back
  (`apps/web/src/analytics/AnalyticsScreen.tsx:15-16` still says concept-level retention and the
  7-day forecast were "deferred to M17/T083"; T083 became source-yield instead).
- `needs_later` block deferrals are recorded and honestly counted at exit
  (`doneIntentBreakdown.ts`), then never honored on return — zero references in
  `packages/scheduler`, no jump-to-deferred in any reader.
- `stale_after_edit` stops at block rows; the extracts, statements, and cards derived from
  those blocks keep circulating with untouched schedules.

## Grounding Context

**Codebase Context.** Desktop-first, local-first Electron app; React 19 renderer behind a typed
`window.appApi` bridge; better-sqlite3 + Drizzle; filesystem asset vault; mutations
command-shaped and op-logged. Pipeline: Source → Topic → Extract → Clean extract → Atomic
statement → Card → Review → Mature knowledge. FSRS for active-recall cards only; the attention
scheduler owns sources/topics/extracts/tasks. Roadmap status at ideation time: Part I
(T001–T050) complete; Part II (T051–T100) complete except M11 encrypted-backup server
(T051–T057, planned). Multi-device sync out of scope by design (single canonical device +
restore). Load-tested at 100k+ cards/extracts (M20).

**Past learnings (docs/solutions/).** Daily-work routing is a trusted-side read model with
`recommendedAction` (`process_due_queue → triage_inbox → resume_unscheduled_source → clear`);
inbox triage has four verbs (Read now / Queue soon / Save for later / Delete); a durable
7-state block-processing model exists per source block (unread, read, extracted, ignored,
processed_without_output, needs_later, stale_after_edit) with content-hash reconciliation, and
its solution doc explicitly names "scheduler inputs based on how much useful output a source
produced" as an unbuilt seam; queue eligibility is backend-canonical; the DoneIntentMenu
pattern (Return later / Finished / Abandon with honest per-state breakdowns) is the house style
for terminal actions; analytics are read models over durable domain facts, never parallel
tables. Noted absences in the knowledge base — topic-level synthesis workflows,
knowledge-maturity tracking, media-specific reading depth, spaced source re-reading strategy,
cross-source interleaving — flagged these areas as unbuilt or untested before this pass.

**External research.** Full canon checklist, per-tool failure notes, abandonment causes,
cross-domain analogies, and sources are in the appendix at the end of this document.

**Process.** 9 agents (codebase scan, learnings researcher, web researcher, 6 ideation frames:
pain/friction, inversion/automation, assumption-breaking, leverage/compounding, cross-domain
analogy, constraint-flipping). 48 raw ideas; every claim verified against the repo before
surfacing. All six frames independently converged on idea #1; five of six on idea #3.
Expanded 2026-06-10 with the underlying research detail (no new research performed).

**Roadmapped 2026-06-10** as [`Part III — Close the loops (T101–T134)`](../roadmap.md) — nine
milestones (M21–M29) with detailed specs in `docs/tasks/M21-honest-exits.md` through
`M29-longform-geometry.md`. All nine survivors are covered; the sequencing notes below became
the milestone order.

## Topic Axes

1. capture-triage — import surfaces, dedupe, inbox triage verbs, priority at entry
2. reading-extraction — reader UX, reading points, block states, extract creation, source completion
3. queue-overload — priority queue, auto-postpone, priority bias, audits, overload tolerance, scheduling inputs
4. extract-to-card — statement/card production cadence, cloze, quality gates, graveyard prevention
5. review-feedback — review UX/ordering, analytics closing the loop, maturity signals, integrity checks

## The gold-standard scorecard

The SuperMemo canon (see appendix for sources) defines the mechanic set. Interleave against it,
as verified in this pass:

| Canon mechanic | Interleave status | Notes |
|---|---|---|
| Persistent reading points with visual resume | **Shipped** | Text, PDF, and media read points exist (`useReadPoint.ts`, `PdfReader.tsx`, `MediaReader.tsx`). #5 adds orientation on top of resume. |
| Per-element priority | **Shipped, adequacy gap** | Stored numerically, surfaced as A–D bands. Set cold at entry with zero distribution context; inflation unmeasured (#3, #9). |
| Priority-ordered queue with protection rules | **Shipped** | M16 queue scoring; cards up-weighted before reading (`queue-score.ts:133`) — which is itself the distillation-starvation mechanism #6 addresses. Session-start randomization not assessed this pass. |
| Auto-postpone | **Shipped, manual-only** | T077: banner → preview → confirm, every overloaded day (#2). SuperMemo runs it pre-session, unattended. |
| A-Factor (adaptive per-element intervals) | **Missing** | The flagship gap; the seam is explicitly reserved in code (#1). |
| Extracts as scheduled elements | **Shipped** | Extract stage ladder with attention scheduling. Default entry rung is hardcoded `raw_extract` regardless of shape (#6 lever). |
| Provenance propagation through extraction levels | **Shipped, strong** | Lineage invariant + main-side extract rebuilds; exceeds the canon bar. |
| Cloze with enforced quality step | **Shipped** | Cloze action in the selection toolbar; card-quality checks with compact disclosure. Not a gap in this pass. |
| Done vs Dismiss as distinct terminal states | **Mixed** | The reader/queue side *exceeds* canon (DoneIntentMenu: three intents + honest breakdown). The inbox side has a trapdoor: "Save for later" writes the same `dismissed` status as Abandon (#9). |
| Semantic review order | **Not assessed** | Embeddings exist (T087/T088); whether review ordering uses them was not verified in this pass. |
| Overload tolerance by design | **Partial** | Machinery yes (planner, preview, batch undo); ambient operation no (#2); sacrifice receipts no (#3). |
| "Priorities missed" statistic | **Missing** | No priorities-missed / bias / drift concept anywhere in docs, renderer, or scheduler (#3). |
| Incremental video/audio | **Partial** | Readers and read points exist; no per-segment depth model, so done-gates/yield are blind for media (#5). |
| Subset learning (focused sessions) | **Shipped** | T096 review modes; a natural consumer of #4's topic maturity. |
| Scheduled reading phase (the anti-Polar property) | **Shipped at source level** | The attention scheduler is the product's core strength. Gaps are sub-source (#5) and the save-for-later exit (#9). |

Reading of the scorecard: the *structural* canon (scheduled reading, lineage, two schedulers,
priority queue) is in place — this is what the roadmap correctly built. The missing third is
consistently the *adaptive/accountability* layer: intervals that learn (#1), overload handling
that runs itself and shows receipts (#2, #3), and a defined, measurable terminal stage (#4).

## Failure-mode coverage

Documented abandonment causes for IR tools, mapped to the survivors that address them:

| Abandonment cause | Addressed by |
|---|---|
| Queue bankruptcy | #2 (ambient trim to budget), #3 (honest receipts), #1 (load amortizes as collections mature) |
| Extract graveyards | #6 (flow control with teeth), #1's value-model constraint (honorable non-card fates) |
| Priority inflation | #3 (inflation warning, declared-vs-received audit), #9 (informed defaults at entry) |
| Overwhelm at totals on open | #2 (minutes-denominated, pre-trimmed day) |
| No feedback the system is working | #4 (maturity progression), #3 (integrity ledger) |
| Silent drift out of the system (Polar's death) | #9 (save-for-later resurfacing), #5 (sub-source geometry), #1 (earned retirement proposals) |
| "Productive procrastination" | #6 (protected distillation), #3 (forced reckoning on chronic postponers) |
| Trust erosion from stale/wrong content | #7 (lineage integrity loop) |

## Ranked Ideas

### 1. Yield-adaptive attention scheduling (close the A-Factor seam)

**Description:** Replace the static interval lookup with a continuous per-element interval
multiplier driven by what each element actually produces. Today `sourceIntervalDays` returns
fixed band floors `{A:1, B:7, C:30, D:90}` with no per-element state; interval growth exists
only for postpones and `done`; productive actions (`extract`/`rewrite`) always reset to the
band floor. So a priority-A source returns every single day forever — whether it yields ten
extracts per visit or zero, whether it has had two passes or fifty. The build: each productive
pass updates a per-element multiplier (bounded, e.g. ×0.5–×4 on the band base) from extraction
yield per visit, descendant card creation and health, unresolved-block ratio, and recency —
with priority modulating the growth rate, exactly as SuperMemo's priority-adjusts-A-Factor
coupling does. High-yield sources grow their intervals slowly (keep returning); exhausted ones
grow fast (drift out with dignity).

**Evidence detail:**
- `attention-scheduler.ts:104-112` — `lastSeenAt` "RESERVED — deliberately NOT consumed".
- `adjustForSourceProcessing` contains exactly two yield branches: halve the interval when
  high-priority with >25% unresolved blocks; double it plus `retirementSuggestion: true` when
  the source is dead (≥90% terminal blocks, zero extracted output, ≥50% ignored). Everything
  between those edges is invisible to scheduling.
- `retirementSuggestion` is threaded through `scheduler-service.ts:190,265` and consumed by
  nothing in `apps/web` (verified grep) — a finished signal pipeline, dropped at the last hop.
- `docs/scheduling-and-priority.md` promises the scheduler considers "last processed date" and
  "whether the element produced useful children (extracts/cards)"; `packages/scheduler`'s own
  AGENTS charter requires "child value produced, stagnation". The implementation consumes
  neither in graded form — the spec currently overstates what ships, a trust bug in itself.
- The T083 rollup (extracts, cards, mature cards, leeches, time spent per source) exists as a
  read model and never reaches `nextDueAt`.

**Sketch:** First slice — wire `retirementSuggestion` into the DoneIntentMenu surface as a
system-proposed nudge ("96% processed, 14 extracts produced — mark Finished?" / "cycled 4 times
with nothing extracted — Abandon?"), one tap from the existing intent surface; this ships the
dropped signal with no scheduler change. Second slice — consume `lastSeenAt` (recency damping).
Third — the full multiplier, surfaced in the queue row ("returning in 3d instead of 7d: last
visit produced 6 extracts") so interval changes are always explainable, and added to the
maintenance drift diagnostic as new drift cases.

**Binding constraint (from the critique pass):** the value function must count
`synthesis_note` lineage and honorable non-card fates. `packages/core/src/source-yield.ts`
defines "reward = mature cards (most), then cards, then extracts produced" — T095 shipped
synthesis notes as a first-class scheduled output type, yet an extract feeding a synthesis note
is invisible to yield and still reads as graveyard material. Yield-driven scheduling built on
the cards-only definition would systematically punish legitimate synthesis-driven reading.

**Interlocks:** #3 is the audit view of what the multiplier does; #8's lapse clustering is a
natural additional input (descendant cards failing → source returns sooner); #5 extends the
yield substrate to PDF/media so heavy formats participate.

**Axis:** queue-overload
**Basis:** `direct:` code/spec citations above. `external:` SuperMemo A-Factor — long articles
~1.1 (slow growth, frequent return), short extracts ~1.8 (fast growth); priority modulates the
factor; core canon since SM 2006, not an advanced extra.
**Rationale:** The only idea all six frames generated independently. It is the difference
between a priority-sorted to-do list and an engine that learns; without it, attention load
grows linearly with source count and never amortizes — the precise failure mode that makes
years-long collections collapse.
**Downsides:** Scheduling changes are trust-sensitive; every interval change must be
explainable in the UI and covered by the drift diagnostic. Curve tuning takes iteration —
start conservative (narrow multiplier bounds), widen with evidence.
**Confidence:** 92%
**Complexity:** Medium-High
**Status:** Unexplored

### 2. Ambient, time-denominated overload control

**Description:** Two coupled changes. (a) Promote auto-postpone from a manual ceremony to an
opt-in standing policy. Today T077 ships it as: an `OverloadBanner` renders only when due >
budget, the user clicks to fetch a preview (`queue.autoPostpone`), then confirms
(`queue.autoPostponeApply`). Every overloaded morning therefore starts with arithmetic and a
decision tax — at exactly the moment an overwhelmed user is most likely to bounce. The policy
version runs the same deterministic planner main-side at day rollover (T058 background-runner
infrastructure exists), writes one `batchId`, and the user opens onto an already-trimmed day
with a calm receipt in the daily summary: "14 low-priority items slipped — undo." The banner
remains as the manual override. (b) Re-denominate the budget in minutes. `dailyReviewBudget` is
an item count (default 60, "soft cap on items surfaced per day"); one 6-second cloze and one
90-minute PDF pass each cost "1", so 60 items can mean 15 minutes or 3 hours and the meter
cannot tell. Learn per-type unit costs from telemetry the app already records — seconds-per-card
from `review_logs`, per-source time-spent from the T083 rollup, reading pace per format — set
the budget in minutes with a reserve buffer, and project the queue's real time cost in the
gauge. A "what fits in 25 minutes" session-assembly mode falls out of the same pricing.

**Evidence detail:**
- `apps/web/src/pages/queue/OverloadBanner.tsx:5-12` — manual flow confirmed; renders only
  when over budget. `docs/tasks/M16-sort-overload.md` (~line 486) specifies the "'Auto-postpone
  N' button that opens a small confirm/preview" and self-describes T077 as "the single-shot
  overload valve."
- `packages/core/src/settings.ts:42` — count-based budget. "est. minutes" exists only as a
  display estimate in the queue header (`QueueScreen.tsx:5`); the only durable time fields in
  local-db are media `durationMs` plus T083's per-source time-spent.
- T078 catch-up/vacation are likewise invoke-only ceremonies; the daily-work read model's
  action set has no overload-handling state at all.
- House precedent to respect: auto-scheduling fresh *imports* was explicitly rejected (new
  material would dominate older high-value due work). Deferring already-due work is a different
  operation — but the receipts/undo contract should be designed to the same standard that
  rejection set.

**Sketch:** Settings: "Keep my day within budget: off / suggest / automatic." Automatic runs at
day rollover; suggest pre-computes and one-taps. Receipt line in the daily-work summary with
undo (batch undo and op-log audit already exist). Budget setting migrates from count to
minutes with a coarse-cost fallback for cold start.

**Interlocks:** #3 is the accountability companion — unattended trimming is only trustworthy
with a sacrifice ledger. #6's protected distillation quota composes into the same day-shaping
step (the "daily plan compiler" synthesis: trim to time, then balance stages).

**Axis:** queue-overload
**Basis:** `direct:` citations above. `external:` SuperMemo auto-postpone runs before the
session by design — the user never faces the raw backlog; "overwhelm at totals" is a
documented abandonment trigger.
**Rationale:** Queue bankruptcy is the #1 documented abandonment cause for IR tools, and the
user who most needs the valve is the least likely to calmly operate it daily. The planner,
protection rules, preview math, and batch undo all exist; only the trigger is wrong-way-around.
Minutes are the unit the user actually runs out of — overload tolerance only works if the
protected subset is sized in that unit.
**Downsides:** Unattended mutation needs an airtight receipts-and-undo contract. Early time
estimates are noisy — start with coarse per-type costs and visibly label them as estimates.
**Confidence:** 88%
**Complexity:** Medium
**Status:** Unexplored

### 3. Priority-integrity ledger and chronic-postpone reckoning

**Description:** A read model answering: did executed attention match declared priorities? The
system silently sacrifices low-value work in at least three ways — auto-postpone victims
(strictly priority-ordered selection), the geometric postpone recession (interval grows by
`(1 + 0.5 × postponeCount)` toward `POSTPONE_CEILING_DAYS = 180`), and mature-card defers — and
no surface accumulates or reports the cumulative cost. Build: per band and topic, the share of
due work actually serviced vs deferred; cumulative postpone debt; an inflation warning when the
A-band creeps toward meaninglessness ("A already holds 41% of 8,200 elements"); and a
"sacrificed this month" list. The active half: a periodic integrity sweep that walks items
postponed ≥N times through a forced keep / demote / done / delete decision instead of silent
recession — plus a per-topic **fallowing** verb (deliberate rest with a scheduled return date;
managed land, not abandoned land — distinct from both postpone and abandon). Natural delivery:
a weekly session that is itself a scheduled attention element (the same pattern as T095
synthesis notes), pairing this ledger with #4's maturity report into one "weekly proof + audit"
ritual.

**Evidence detail:**
- Verified absence: greps for priorities-missed / priority-bias / inflation / drift across
  `docs/`, `apps/web/src`, `packages/scheduler/src` return nothing, including the M16/M17
  specs.
- `attention-scheduler.ts` recession math and the 180-day ceiling; a C-priority source can be
  postponed into multi-year oblivion with zero signal.
- Postpone provenance is fully captured today: per-item `postponeCount` (descriptor comment:
  "read from `reschedule_element` ops"), auto-postpone `batchId` per apply,
  `schedulerSignals.postponed` on queue rows — captured, never read back. Pure leverage on the
  operation log.
- `stagnation.ts:16-22` scopes stagnation to extracts — "a card is never called 'stagnant'",
  and neither is a source; chronic-postpone detection exists for nothing.
- `docs/test-battle-audit.md:58-59` flags "repeated postpones and starvation detection" as an
  untested behavior — the team's own audit anticipated this gap.

**Sketch:** `PriorityIntegritySummary` read model (band/topic → serviced %, deferred %,
postpone debt, band share); a quiet queue-header indicator when fidelity degrades; the chronic
list (postponeCount ≥ 5) surfaced in the weekly sweep with one forced verb per item; fallow
verb writes a scheduled return with reason, excluded from "missed" accounting.

**Interlocks:** Prerequisite trust layer for #2's automation; the audit view of #1's interval
decisions; shares its weekly delivery surface with #4; #9's save-for-later resurfacing sweep
naturally lives in the same session.

**Axis:** review-feedback
**Basis:** `direct:` citations above. `external:` SuperMemo ships a literal "Priorities missed"
statistic warning of priority bias; GTD's weekly review exists precisely to force disposition
of repeatedly deferred items — no current IR tool implements it as a scheduled workflow step.
**Rationale:** Overload tolerance by design is only honest if the user can see what tolerance
cost them. Without receipts, the user cannot distinguish "the system is protecting my A-items"
from "the system is quietly losing my library" — the precise trust failure behind abandonment;
and priority inflation (the best-documented way SM-style priority degrades into noise) stays
invisible until the queue stops meaning anything.
**Downsides:** Must route through existing daily-work/maintenance surfaces rather than a new
dashboard; forced-decision cadence needs tuning to avoid nagging (weekly, capped item count).
**Confidence:** 90%
**Complexity:** Medium
**Status:** Unexplored

### 4. Topic-level knowledge maturity (define the pipeline's terminal stage)

**Description:** "Mature knowledge" — the pipeline's stated endpoint — has no operational
definition, no metric, and no screen. Maturity exists only as a per-card FSRS stability cut
(`isCardMature`, the `mature_card` stage, T082 retirement framed as cleanup) and a per-source
mature-card count (T083). Build the per-topic knowledge-state read model: a coverage funnel
(read % → extracts → distilled statements → cards → mature share), stability distribution,
measured retention trend from review logs, staleness/contradiction flags (from T090 expiry and
#7's propagation), and graduation events ("Bayesian statistics reached mature") surfaced in the
daily summary. Feed the consumers that already exist and are waiting: T096 subset review
(targeting weak topics), T095 synthesis notes (prompting synthesis when a topic matures), and
T082 retirement (graduation, not cleanup).

**Evidence detail:**
- `AnalyticsScreen.tsx:15-16` — the header comment still says the 7-day forecast and
  "Retention by concept" panels are "deferred to M17/T083"; they never landed (T083 became
  source-yield instead). `AnalyticsGetResult` in `appApi.ts` carries no concept-level or
  stability-distribution fields.
- T079 lets users *set* per-concept desired retention; no surface ever reports per-concept
  results back — a configuration without a readback.
- Greps for funnel/maturity surfaces in `apps/web/src` return nothing beyond per-card stats.
- House pattern makes this cheap: analytics are read models over durable facts (review logs
  captured at the grading write path, block-processing rows) — no new write paths, no schema
  migration.

**Sketch:** `TopicKnowledgeState` read model per topic/concept: funnel counts, stability
buckets (young/maturing/mature/retired-with-honor), retention trend (rolling 90d measured vs
target from T079), flags. Topic page panel + graduation events in the daily summary + weekly
ritual inclusion. The denominator problem (coverage % of a moving target as new sources
import) is handled by funnel *ratios* between adjacent stages rather than absolute
percent-of-topic, plus per-period snapshots for trend.

**Interlocks:** Shares the "what counts as value" definition with #1's binding constraint
(synthesis and honorable fates must count); delivered alongside #3 in the weekly ritual;
consumes #7's staleness flags.

**Axis:** review-feedback
**Basis:** `direct:` citations above. `reasoned:` users think in topics ("do I know X now?");
per-card stability cannot answer that without a coverage dimension — a system whose stated
output has no measurable definition cannot show progress toward it.
**Rationale:** "No feedback that the system is working" is a named abandonment cause that daily
counters cannot answer — counters prove you did the work; only maturity progression proves the
work accumulates. Months in with no visible compounding is exactly when committed users quit.
This is also the strongest retention/celebration hook the current count-based analytics cannot
provide.
**Downsides:** Defining maturity honestly is the hard part — guard against vanity metrics;
funnel ratios and measured retention keep it falsifiable.
**Confidence:** 85%
**Complexity:** Medium
**Status:** Unexplored

### 5. Long-form reading geometry and the re-entry payoff

**Description:** Make books, papers, and lectures first-class IR citizens. Four connected
pieces. (a) **Block states for PDF and media:** the 7-state block model exists only for
ProseMirror document sources — `PdfReader.tsx` and `MediaReader.tsx` contain zero
block-processing references (verified grep); PdfReader's affordances are text/region extraction
plus a page read-point, MediaReader has no watched/listened-segment tracking. So for exactly
the formats where IR earns its keep, the system cannot say what fraction was read, deferred, or
ignored — the DoneIntentMenu's "honest per-state breakdown" is empty, and yield/scheduling are
structurally blind for the heaviest sources. Extend the model at page/region granularity for
PDFs and time-segment granularity for media, reusing the existing state vocabulary and
content-hash reconciliation. (b) **Structural skim pass:** the schema documents "One read-point
per element" (`packages/db/src/schema/relations.ts`), and `docs/concept.md`'s own refinery
pipeline literally begins with "skim and triage" — which has zero corresponding features
(verified: no "skim" hits across the roadmap and all task specs); M14 gives chapters-as-topics
to EPUB only. First contact with a 300-page PDF should be a pass over its TOC/outline with
per-section verdicts — extract-worthy / read later / ignore — that bulk-set block states and
create per-section attention scheduling, so deep reading starts where value is instead of at
page 1. (c) **Re-entry briefing:** a source returns after three weeks and the reader resumes a
scroll position but synthesizes nothing. Render a since-last-visit briefing at the top of every
scheduled return — read %, deferred blocks, stale-after-edit blocks, how this source's cards
are performing, next unresolved block — computed entirely from existing block rows and yield
data. (d) **Honor `needs_later`:** deferred blocks are write-only today (marking control +
exit count, nothing else); add a jump-to-deferred rail on reopen and feed block-level deferral
into the source's return context.

**Evidence detail:**
- Block model lives in `packages/local-db/src/block-processing-service.ts`, consumed by
  `SourceReader`/`ProcessedSpanButtons` only. `needs_later` reaches the scheduler solely inside
  the aggregate `unresolvedRatio` (`scheduler-service.ts:137`).
- `PdfReader.tsx:107,869` — the only "outline" is the visual rectangle around extracted
  regions; no document-outline navigation or section-scoped bulk action exists anywhere in
  `apps/web/src/pages/source/`.
- `docs/domain-model.md` defines `topic` ("a chapter/section") and the `rough_topic` stage —
  vocabulary with no workflow that creates them from a source's structure.
- The cost asymmetry: the 7-state model prices every decision at one block; a 1,000-block PDF
  therefore costs 1,000 micro-decisions or zero. Structural triage is the missing middle gear —
  how humans actually attack long material.

**Sketch:** Slice order matters here: (b) skim verdicts + (c) briefing + (d) jump rail are
buildable on existing data for document sources first; (a) full block parity for PDF/media is
the larger substrate build that then makes #1/#6 work for heavy formats. Per-section verdicts
map to bulk block-state operations (ignore → `ignored`, later → `needs_later`, extract-worthy
→ unread + section priority) with one `batchId` undo.

**Interlocks:** (a) is the substrate that lets #1's yield multiplier and #6's flow stats see
books and lectures; the briefing consumes #7's stale flags and #8's struggling-card signal;
per-section scheduling feeds #1.

**Axis:** reading-extraction
**Basis:** `direct:` citations above. `external:` SuperMemo's article-splitting and
non-sequential reading are canonical; Polar died partly because documents drifted out
unscheduled — the same failure recurs here at section granularity for everything past the
cursor.
**Rationale:** A 400-page PDF is the canonical incremental-reading object and PDF import was a
flagship Part II milestone — but without geometry, format support is cosmetic: the system
handles a book no better than a scrolled web page. The hard part (durable per-unit state with
reconciliation) is already designed; this is extension, not invention.
**Downsides:** The largest build in the set. PDF segmentation has no DOM to lean on
(page/region heuristics); media segmentation likewise. Mitigate by slicing as sketched.
**Confidence:** 87%
**Complexity:** High
**Status:** Unexplored

### 6. Extract-pipeline flow control (graveyard prevention with teeth)

**Description:** The system detects extract graveyards and warns about imbalance but
structurally creates them. The evidence chain: queue scoring up-weights "due cards first, then
reading" (`queue-score.ts:133`); T077's victim order postpones "low-priority topics then
low-priority mature cards" — distillation work is the designated loser whenever load exceeds
budget; the daily-work model's four recommended actions never include "convert your card-ready
statements" (statements instead nag one-at-a-time at +1d inside the process queue:
`atomic_statement → return 1`, "convert now, or come back tomorrow"); and T084's stagnation
detection is read-only by spec ("labels, not actions"; "The view surfaces; the user acts").
Detection without flow control means watching the debt grow with better instruments. Add flow
control — a coherent minimal set, not all levers at once:

1. **Protected distillation quota** — a small guaranteed share of each day (minutes or
   conversions) reserved for extract→card work, so card production never drops to zero under
   overload.
2. **Batch conversion sessions** — gather card-ready atomic statements across sources into one
   keyboard-first drafting surface, instead of one-at-a-time queue encounters.
3. **Extract aging policy** — an extract untouched after N unproductive returns auto-demotes to
   a recoverable reference state (batched, op-logged, undoable), with age bands visible
   wherever extracts appear.
4. *(Optional levers)* WIP-aware routing — stage inventory (inbox, unread sources, unprocessed
   extracts, statements without cards) feeds `recommendedAction` as a new value per the house
   read-model pattern (kanban pull, not another banner); shape-aware staging — extracts are
   born `raw_extract` unconditionally (`extraction-service.ts:228,343`) and walk three
   scheduled rungs (+1..7d raw, +3..14d clean, +1d atomic) even when the capture is already a
   single atomic sentence — classify shape at creation so card-ready captures are born
   `atomic_statement`; background AI pre-drafting — M18's AI is strictly pull
   (seven actions over a user-selected span, one element at a time); an opt-in background sweep
   over due/stagnant statements into the existing `ai_suggestions` table turns queue encounters
   into approve/edit/dismiss (the drafts-only invariant — never schedule an unapproved card —
   makes this safe by construction).

**Evidence detail:** all citations above verified this pass; T046 balance banner is advisory
("warns"), T084 remediation verbs are rewrite/convert/postpone/delete with no honorable
non-card fate (see #1's binding constraint), T099 bulk ops are maintenance-side only.

**Interlocks:** the quota composes into #2's day-shaping; the aging policy's target states are
A3's honorable fates (must not count as failure in yield); #3 audits what aging demoted; the
batch-session machinery is shared with #9's bulk triage; AI pre-drafting needs an explicit
consent boundary (running AI over content the user didn't just select).

**Axis:** extract-to-card
**Basis:** `direct:` citations above. `external:` extract graveyards are the #2 documented
abandonment cause; the Anki IR add-on's named failure is extract backlogs invisible to the
system; Little's Law — uncapped inflow with fixed throughput produces unbounded cycle time.
**Rationale:** A pipeline whose output stage depends on a middle stage that every overload
mechanism deprioritizes will converge on graveyards exactly when the user is busiest. The
soft-delete/undo house invariants make automated demotion safe to ship here in a way
competitors couldn't.
**Downsides:** Six levers is too many — the brainstorm should commit to the minimal set
(quota + batch sessions + aging) and treat the rest as follow-ups.
**Confidence:** 85%
**Complexity:** Medium-High
**Status:** Unexplored

### 7. Lineage integrity loop (edits propagate, schedules re-stabilize)

**Description:** Two halves of one correctness gap — the one survivor about the system being
quietly *wrong* rather than inefficient. **Forward (dirty-bit propagation):** when a source
edit or reimport marks blocks `stale_after_edit`, nothing flows downstream — the solution doc
defines the state as "a warning that previous progress no longer matches the current block
text," and reconciliation marks block rows only; no stale flag exists on extracts or cards
(verified — the only card staleness is T090's calendar `valid_until`/`review_by`). A user who
fixes an error in a source then spends months reviewing cards that contradict their own
correction, with FSRS faithfully strengthening the superseded fact. Propagate the dirty bit
down the derivation DAG: changed block → live extract outputs anchored to it → their statements
and cards → a capped, batched re-verify pass with three resolutions per item — **confirm**
(drift is immaterial), **rebase** (re-anchor/update from the new text, hash-diff assisted), or
**detach** (keep standalone with frozen provenance snapshot). **Backward (write barrier):** the
M7 spec rule — "Editing a card mid-review must not corrupt the in-flight FSRS state — edit the
body only; never touch `review_states` from an edit" — was written to protect in-flight session
state, but as blanket policy it leaves no re-stabilization path at all (T038 surfaces are
update/suspend/delete only). A card whose answer is substantively rewritten retains the full
stability its *old* formulation earned: it next surfaces in nine months and fails, reading as
user failure rather than scheduler debt. And T085's leech remediation actively routes users
toward rewriting failing cards — the system encourages the mutation, then schedules the result
on falsified history. Add a write barrier: on substantive edit (heuristic on the answer-bearing
side, user-confirmable), offer keep-schedule (typo) or demote to a short confirmation interval
so FSRS re-stabilizes the new formulation; log the edit-reschedule linkage in review logs so
T080 parameter optimization can exclude contaminated history (grades before and after a rewrite
refer to different knowledge under one card id).

**Evidence detail:** citations above; `external:` incremental build systems (Bazel/Salsa/rustc
query systems) treat shipping stale downstream artifacts as broken, not fast — correctness
comes from invalidating the transitive closure of a changed input; generational GCs add mutated
tenured objects to the remembered set and re-scan them precisely because age-based trust is
void after mutation (Anki's community norm of "reset after major edit" is the folk version).

**Sketch:** forward propagation rides the existing content-hash reconciliation moment; the
re-verify queue lives in maintenance with a queue-injected cap (avoid a wall of confirmations
after a large reimport — batch by source). Backward barrier hooks the card-edit command;
"substantive" = normalized diff above threshold on the answer side, always user-overridable.

**Interlocks:** feeds #5's re-entry briefing (stale counts) and #4's topic flags; #8 shares the
descendant-health lens; protects #1 (yield computed over verified-live lineage).

**Axis:** extract-to-card
**Basis:** `direct:` + `external:` as above.
**Rationale:** "Source lineage is sacred" is the product's deepest invariant, but lineage
currently only points backward — it never pushes change forward. Both halves break the same
promise: that what you review is still true to its source, and that your schedule reflects what
you actually know.
**Downsides:** "Substantive edit" detection is heuristic — offer the choice rather than
auto-deciding; re-verify must batch gracefully after large reimports.
**Confidence:** 88%
**Complexity:** Medium
**Status:** Unexplored

### 8. Lapse-driven re-reading (the Review→Source back-edge)

**Description:** When several cards descended from one extract or source region keep lapsing,
that is comprehension debt, not memory debt — the encoding was thin, and the remedy is
re-reading the context, which nothing generates. T085's leech screen offers "open source" and
"back to extract" as manual per-card navigation; the attention scheduler takes no lapse or
leech input at all (verified — zero references in `packages/scheduler` and the local-db
scheduling paths). Build the loop as proposals: cluster lapses over review logs joined to
lineage anchors (K lapses within a window across cards sharing an extract/source-region
ancestor); above threshold, propose a scheduled "re-read this section" attention item targeting
the exact blocks — `source_locations` pin the region — with the failing cards attached as
context. Accepting enqueues it; the re-read surface offers re-extract and rewrite affordances
inline.

**Evidence detail:** review logs capture prompt/response timing and FSRS transitions at the
grading write path (the analytics house pattern); lineage anchors are immutable (extraction
fidelity doc); the block model makes region targeting cheap. All three ingredients exist; the
join is the feature.

**Sketch:** proposal read model + one new attention item type; cap proposals per week; cheap,
remembered dismissal. Per-card remediation treats each leech as an isolated formulation bug —
when failures correlate by parent, only the system can see the correlation, and the cheapest
fix is upstream re-exposure.

**Interlocks:** the lapse-cluster signal doubles as a #1 multiplier input (struggling
descendants → source returns sooner); surfaces in #5's briefing ("3 cards from this source are
struggling"); respects #7 (a rewrite prompted here goes through the write barrier).

**Axis:** review-feedback
**Basis:** `direct:` citations above. `reasoned:` FSRS can only adjust intervals on a weak
memory trace; only the attention scheduler can repair the trace itself — and Interleave is the
rare system holding both schedulers plus exact provenance. Leaving the loop open wastes its
defining asset.
**Rationale:** Closes the pipeline into an actual cycle (Review → Source) instead of a one-way
conveyor; converts "spaced source re-reading" — a noted absence — from a calendar guess into a
need-driven mechanic; no shipping competitor, SuperMemo included, does this well.
**Downsides:** Clustering thresholds must avoid queue spam from noisy lapses; keep proposals
rare and high-confidence.
**Confidence:** 80%
**Complexity:** Medium
**Status:** Unexplored

### 9. Triage verbs that survive contact (resurfacing + bulk + informed defaults)

**Description:** Three fixes to the inbox's verb set, in priority order. **(a) "Save for later"
is a trapdoor:** `keepForLater` writes `status: "dismissed"`
(`apps/desktop/src/main/db-service.ts:2698-2700`) — the exact terminal status the
DoneIntentMenu's "Abandon" intent uses. Saved items have no schedule, never appear in the
daily-work read model (resume scans `status: "active"` with `dueAt === null` only,
`daily-work-query.ts:60-64`), never re-enter the inbox or queue, and are reachable only by
manually remembering to browse the library. The data cannot even distinguish "saved with
intent" from "abandoned" — which poisons any future fix and is Polar's death mechanism
(material drifting out unscheduled) reproduced inside the surface built to prevent it. Fix:
a distinct parked status with `parkedAt`, plus a periodic resurfacing sweep ("you saved these
12 items 90 days ago — keep, schedule, or let go") delivered through #3's integrity session.
Migration note: existing `dismissed` rows are already conflated; the distinction applies going
forward unless op-log reconstruction is attempted. **(b) Bulk triage:** the four verbs are
strictly per-item — no multi-select exists in `apps/web/src/pages/inbox/` (verified; T099's
bulk operations are maintenance-side sweeps over old material, not the inbox) — while the
product ships three high-volume feeders (extension capture, URL import, T069 Kindle/Readwise
highlights) that land dozens of items at once. A 50-item morning is 50 individual decisions.
Add grouping by origin/domain/type, keyboard-driven verb+priority over slices, one `batchId`
so a whole sweep is one undo. **(c) Informed defaults:** priority is the input every downstream
protection keys off (auto-sort, auto-postpone victim order, retention bands) and it is
currently the least-informed decision in the system — set cold, per item, at the moment the
user knows the material least, with zero distribution context. The signals to suggest a band
already exist unwired: embeddings and related-item search (T087/T088), per-source yield history
(T083), source-reliability metadata (T091). Suggest band + placement with a one-line
justification ("near your high-yield 'distributed systems' cluster; this author's last 3
sources averaged 11 cards") as accept-or-override chips; M18's AI action union (seven
formulation verbs) contains no triage action, so this is a deterministic-heuristic-first
build with an optional AI refinement.

**Evidence detail:** citations above; solutions doc `inbox-triage-queue-soon` line 35
documents the verb's intent as "set it aside without scheduling it" — the intent was deferral;
the implementation is abandonment.

**Interlocks:** the resurfacing sweep lives in #3's session; bulk machinery is shared with
#6's batch conversion; suggested-priority justifications follow the same explainability bar as
#1's interval surfacing.

**Axis:** capture-triage
**Basis:** `direct:` citations above. `external:` SuperMemo's priority system degrades in
practice through hand-ranking fatigue and inflation — the best-documented reason its 0–100
priority becomes noise; email-triage systems solved volume with tiered batch processing and
snooze-to-context.
**Rationale:** Triage is the pipeline's front door, and one of its four verbs silently exits
the entire system — close to a bug report, and the verb users press most under overload.
Capture throughput now exceeds triage throughput by an order of magnitude.
**Downsides:** Bulk mutations must preserve op-log/undo invariants (the `batchId` precedent
covers this); suggested priorities need visible justifications to avoid automation bias.
**Confidence:** 84%
**Complexity:** Low-Medium
**Status:** Unexplored

## Sequencing and dependency notes

Not a plan (that is `ce-plan`'s job after a brainstorm), but the dependency structure the
critique pass surfaced:

- **Two near-term, near-bug fixes:** wire `retirementSuggestion` into the DoneIntentMenu (#1's
  first slice — the signal pipeline is built and dropped) and give "Save for later" real
  semantics (#9a — a one-status fix plus a sweep). Both are small, high-trust wins.
- **Read models before behavior changes:** #3 (integrity ledger), #4 (maturity), and #5c
  (re-entry briefing) are pure read models over durable facts — no schema risk, immediate
  user-visible value, and they build the accountability surface that makes the behavior
  changes trustworthy.
- **Behavior changes ride on receipts:** #2's automation and #1's full multiplier should land
  after (or with) #3, so every autonomous action has a visible ledger from day one.
- **The value-model constraint comes first within #1/#6:** decide what counts as yield
  (synthesis, honorable fates) before keying scheduling or aging off the cards-only definition.
- **The substrate build:** #5a/b (PDF/media block parity + skim pass) is the largest item and
  unlocks #1/#6 for heavy formats; it can proceed independently in slices.
- **#7 and #8 are self-contained loops** that can land in any order once their host surfaces
  (maintenance re-verify, proposal items) exist.

## Rejection Summary

| # | Idea | Reason Rejected |
|---|------|-----------------|
| 1 | Wire `retirementSuggestion` into UI | Folded into #1 as the first shippable slice |
| 2 | Shape-aware extract staging | Folded into #6 as a lever |
| 3 | Background AI drafting sweep | Folded into #6 as a lever (drafts-only invariant) |
| 4 | Non-card terminal fates / synthesis counts as yield | Promoted into #1/#6 as a binding design constraint rather than a standalone feature |
| 5 | Honor `needs_later` on return | Folded into #5 |
| 6 | Source re-entry briefing | Folded into #5 |
| 7 | Save-for-later resurfacing | Folded into #9 (lead element) |
| 8 | Bulk inbox triage | Folded into #9 |
| 9 | Suggested priority at triage | Folded into #9 |
| 10 | Per-topic fallowing verb | Folded into #3 |
| 11 | Weekly knowledge ledger ritual | Folded into #3/#4 as the delivery surface |
| 12 | Minutes-denominated budget | Folded into #2 |
| 13 | Daily plan compiler (synthesis) | Folded into #2 + #6 (composed expression of both) |
| 14 | Percentile-anchored priority entry | Rejected — see below |
| 15 | Capacity-priced intake | Rejected — see below |
| 16 | Knowledge-aware novelty (delta) triage | Rejected — see below |
| 17 | Commissioning briefs (entry-side reading contracts) | Rejected — see below |
| 18 | Blocked-on-prerequisite readiness | Rejected, close call — see below |
| 19 | Park-it tangent capture in reader | Rejected — see below |

Axis coverage: all five axes have survivors (queue-overload #1 #2; review-feedback #3 #4 #8;
reading-extraction #5; extract-to-card #6 #7; capture-triage #9). No deliberate gaps.

### Rejected with substance (resurrectable in a future round)

These six were full candidates with verified bases; they lost to the field, not to vagueness.
Preserved here so a future round can pick them up without re-deriving them.

**Percentile-anchored priority entry** *(capture-triage)* — Replace absolute A/B/C/D stamping
with comparative placement: show live distribution at triage ("A already holds 41% of 8,200
elements; this lands around #300") and offer pairwise anchoring against the current A-median
item. Basis: priority is stored numerically but surfaced only as four absolute bands set with
zero distribution context (verified — no percentile/relative mechanism anywhere); SuperMemo's
0–100 priority is intrinsically positional. Rejected because: #9c (suggested priority) plus
#3's inflation warning attack the same failure with less per-item ceremony — pairwise anchoring
taxes exactly the moment #9b is trying to make faster. The distribution-context display alone
("A is 41% of your collection") could ride along with #9c cheaply.

**Capacity-priced intake** *(capture-triage)* — Price imports at the door: project what a
300-page PDF at priority A costs in reading hours, expected extracts, and cards at the user's
historical yield rate; show a backpressure indicator when pipeline debt is high. Basis: T081's
workload simulator shipped as a `/settings` tool with hand-entered levers, unwired from any
intake surface — the math exists, in the wrong room. Rejected because: largely redundant once
#2 prices time and #6 applies backpressure; T046 already establishes the advisory-intake-nudge
pattern. Revisit if overload persists after #2/#6 land.

**Knowledge-aware novelty (delta) triage** *(capture-triage)* — Score incoming sources by
novelty against what the user already knows: estimated overlap with existing extracts/cards via
the local vec0 index ("~60% covered by your existing extracts on FSRS; novel material
concentrates in sections 3–5"). Basis: the only overlap mechanisms are identity-level (T061
canonical-URL dedupe; T088's conservative near-duplicate flag at cosine ~0.99, same-type) —
nothing compares content against the collection, and a local-first app with embeddings of
everything is uniquely positioned to do it on-device. No shipping tool does this. Rejected
because: it is a *differentiator beyond the gold-standard bar* this ideation was scoped to, and
overlap estimates carry real trust risk (they must be honest enough to delete on). The
strongest candidate for a dedicated differentiator round.

**Commissioning briefs / entry-side reading contracts** *(capture-triage)* — At triage, record
intended depth (`skim_for_leads` / `selected_sections` / `full_process`) and make it the
denominator downstream: Done evaluates against the contract instead of all-blocks-resolved,
yield normalizes against intent, the scheduler bounds revisit chains for skim contracts. Basis:
triage decides *when* a source returns but never *how deep*; the only completion standard is
total block resolution, so deliberate skimming — a core IR skill — is punished by the done gate
and misread as low yield. Rejected because: it introduces a new domain concept whose payoff
depends on redefining Done/yield denominators — better litigated inside the #5/#6 brainstorms
where those denominators are already on the table.

**Blocked-on-prerequisite readiness** *(reading-extraction; the closest call in the set)* —
`docs/concept.md` names problem #3 incremental reading solves: "Some texts are too hard right
now… read prerequisites first, and return when you have the background" — and its per-item
decision loop includes "Do I understand it? no → add prerequisite / postpone." Nothing
implements this beyond generic time-based postpone: "prerequisite" exists only as an inert AI
draft kind (T093 `prerequisite_list`) and a read-only ancestor display (T088); the closed
`RELATION_TYPES` set has no blocked-on edge. The idea: items have *readiness*, not just
priority and due dates — a blocked item leaves the rotation entirely and resurfaces
automatically when its prerequisite progresses (extracted, carded, or matured), with the
unblock reason shown. Blind time-based postponing of too-hard material guarantees it returns
equally unreadable, training re-postponement; conflating "too hard" with "not interested"
quietly buries the most growth-valuable material. Rejected only on frequency-vs-survivors and
cost (first new relation type since M1 plus a new scheduler input). Strong next-round
candidate.

**Park-it tangent capture** *(reading-extraction)* — A "Follow up" selection-toolbar action
creating an inbox stub linked by relation to the current source and block ("spawned from source
X, block Y"), returning focus to reading. Basis: the toolbar's full action set is
extract/cloze/highlight/copy/cancel (`SelectionToolbar.tsx:43-55`) — capturing a tangent means
leaving the reader and losing lineage; aviation's sterile-cockpit "park it" discipline and
SuperMemo's reading-begets-reading branching are the models, and it is the cheapest path to
source-to-source citation lineage, which no surface currently produces. Rejected because:
tangent capture is partially served by the extension, and the citation-lineage benefit alone
did not clear this field. Cheap to revisit.

## Appendix: external research detail

### The SuperMemo canon (the bar this ideation measured against)

From the SuperMemo help archive (SM 13–19) and Wozniak's writings:

- **Reading point** — a persistent per-article cursor surviving restarts, with a visual resume
  marker (Ctrl+F7 set / Alt+F7 return in SM).
- **Priority queue** (introduced SM 13, 2006, in direct response to Wikipedia-scale import
  volume) — every element holds a 0–100% priority; the outstanding queue auto-sorts by priority
  at session start. The defining property: *the system tolerates overload by design* — when the
  day's load can't be finished, only low-priority items suffer.
- **Auto-sort** — priority ordering with a small configurable randomization factor to prevent
  staleness and stop recent high-priority items permanently blocking older mid-priority ones.
- **Auto-postpone** — runs *before* the learning day begins; defers backlog by priority, never
  touching top-priority or today's material. The user always starts with a manageable,
  prioritized slice, never the raw total.
- **A-Factor** — per-topic interval multiplier: long source articles get low A-Factors (~1.1 —
  slow interval growth, frequent return); short extracts high (~1.8 — fast expansion).
  Adjusting priority also adjusts the A-Factor. This is how reading cadence tracks extraction
  rate rather than fixed intervals.
- **Extracts as scheduled elements** — Alt+X creates an independent child element inheriting
  reference metadata, scheduled like any other article — never a separate to-do list.
- **Reference propagation** — source metadata auto-carries to all downstream extracts through
  n levels of extraction.
- **Cloze with an enforced quality step** — the documentation prescribes one-sentence extracts
  *before* cloze conversion.
- **Done vs Dismiss** — distinct terminal states: Done removes a fully processed article from
  review while preserving provenance and children; Dismiss purges.
- **Semantic review order** — priority × scheduling order surfaces related material together,
  building a contextual scaffold before atomization.
- **Overload tolerance by design** (Wozniak, ~2005) — the system explicitly does not promise
  all items are reviewed on schedule; in overloaded collections the ~95% retention figure
  applies to the top-priority subset. A documented architectural choice, not a bug.
- **"Priorities missed"** — SM's statistics surface this metric and warn of *priority bias*
  (the tendency to rate everything high). The failure mode is actively measured and reported.
- **Incremental video/audio** — read points and spaced review extend to media via start
  markers (SM's own video support acknowledged as limited; the principle is what carries).
- **Subset learning** — any tag/branch isolatable into a focused session without disrupting
  the global queue.
- **SM19 (2023)** — native web import from Chrome/Edge, unlimited collections.

### Adjacent tools: strengths and documented failures

- **Polar** (2018–2022, effectively abandoned) — pagemarks per document, annotation sidebar,
  flashcard flow. Failures users name: the *reading phase was never scheduled* (documents
  silently drift out of circulation); card scheduling felt unreliable; isolated highlights lose
  meaning without context. The Zettelkasten-forum post-mortem language: "system fatigue" and
  "productive procrastination."
- **Anki IR add-on** (2011–present) — extract + reading-point mechanics grafted onto a
  card-first data model. Broke with Anki 23.10/FSRS (2023); an unofficial clone patched it
  April 2025. No native priority queue, no auto-postpone; extract backlogs are invisible to the
  scheduling graph — the graveyard failure in its purest form.
- **RemNote** — "Incremental Everything" positioning, but IR is a plugin, broken with newer
  updates as of 2024 and "buggy for months" per the feedback board; hundreds of votes for
  native priority-queue IR remain unimplemented as of 2025–2026. The demand signal for exactly
  the mechanics this ideation prioritizes.
- **Readwise Reader** — excellent ingestion (32+ integrations, PDF/EPUB/RSS/email), but its
  "spaced repetition" is highlight resurfacing only: no extract→statement→card pipeline, no
  priority queue, no reading-point scheduling, no overload management. A capture-and-resurface
  tool; review discipline entirely user-supplied.
- **Market gap** — no modern tool combines native priority queue + auto-postpone + scheduled
  reading phases + lineage through extraction levels. SuperMemo has the mechanics with a steep
  UX cliff, Windows-only. That combination with modern UX is the open slot — and it is the
  combination Interleave has already structurally built, minus the adaptive/accountability
  layer this document targets.
- **Emerging pattern (2025–2026)** — users LLM-summarize sources and import the summaries as IR
  articles: compresses the top of the funnel, solves nothing about extract processing or
  priority management. Consistent with keeping AI assistive (#6's drafts-only sweep) rather
  than pipeline-replacing.

### Cross-domain patterns and where they landed

| Domain pattern | IR translation | Landed in |
|---|---|---|
| Hospital ED triage (ESI classes) — the queue is *managed*, never cleared; low-priority patients are explicitly told they wait longer | Explicit deferral as correct behavior, with the sacrifice visible | #2, #3 |
| Email triage (snooze-to-context, tiered batch processing) | Park-with-return-date instead of a void; bulk verbs at volume | #9 |
| Athletic periodization (accumulated fatigue is real; planned deloads) | Extract debt compounds like training debt; protected capacity and throttles | #6 (rejected sibling: capacity-priced intake) |
| Feed ranking decay — decay functions must be *visible* to the user | Interval changes always explainable in the UI | #1's surfacing rule |
| GTD weekly review — a scheduled system-integrity check, not a catch-up | Weekly ledger + forced verdicts on chronic postponers | #3, #4 delivery |
| Manufacturing WIP limits / kanban pull (Little's Law) | Stage inventory feeds the recommended action; intake earns capacity by processing | #6 |
| Incremental build invalidation (transitive closure of a changed input) | `stale_after_edit` propagates down the lineage DAG | #7 |
| GC generations / write barriers (mutated tenured objects get re-scanned) | Substantively edited cards re-stabilize instead of keeping unearned stability | #7 |
| Aviation fuel planning (budget the constrained resource directly, with reserves) | Minutes-denominated budget with a reserve buffer | #2 |
| Newsroom commissioning briefs | Entry-side depth contracts | Rejected (#17), preserved above |
| Agricultural fallowing (rested land is managed, not abandoned) | Per-topic fallow verb with scheduled return | #3 |

### Sources

- SuperMemo Help Archive — Priority queue (super-memory.com/archive/help15/priority.htm):
  priority queue mechanics, auto-sort, auto-postpone, A-Factor interaction.
- SuperMemo Help Archive — Incremental reading (super-memory.com/archive/help15/read.htm):
  reading points, extracts, cloze, Done/Dismiss, reference propagation, overload handling.
- Wikipedia: Incremental Reading — canonical overview and workflow steps.
- supermemo.guru — Wozniak's overload-by-design framing; priority queue introduced 2006.
- Speed Reading Lounge, Readwise Reader review (2026) — passive-system limitation, no
  reading-phase scheduling.
- Zettelkasten Forum, "Polar and incremental reading" — system fatigue, productive
  procrastination, abandonment causes.
- RemNote feedback board, "Incremental reading" — plugin breakage, native-IR demand.
- Anki Forums — IR add-on unofficial clone, FSRS compatibility fix (April 2025).
- MasterHowToLearn, "What to do after creating extracts" — extract-backlog mechanics,
  trust-the-scheduler principle.
- Soki.ai, "Essence of incremental reading" — market-gap framing.
- Hospital triage queueing-theory literature (PMC/PubMed) — priority-class queue management
  under bounded throughput.
