/**
 * Recovery modes (T078) — the two human-facing OVERLOAD TOOLS, as PURE planners.
 *
 * `docs/scheduling-and-priority.md` ("Overload handling → Catch-up / vacation modes")
 * asks for two ways to steer the queue under sustained pressure, and BOTH must show the
 * COST of postponement BEFORE committing (what slips, by how much):
 *
 *  - **Catch-up** — the user is BEHIND (a pile of overdue/due items exceeds what one
 *    day's budget can clear). {@link planCatchUp} spreads that backlog forward over the
 *    next `spreadDays` so each day's load ≤ budget, putting HIGH-VALUE / FRAGILE items on
 *    the EARLIEST days (recovered first) and pushing LOW-VALUE to the back — recovering
 *    gracefully instead of facing an un-clearable wall.
 *  - **Vacation** — the user WILL BE AWAY over `[awayStart, awayEnd]`. {@link planVacation}
 *    finds everything that would come due in that window and chooses SUSPEND-for-the-window
 *    (a status change) vs SHIFT-past-return (a reschedule) per item, then re-spreads the
 *    shifted load over the days AFTER `awayEnd` within budget (high-value first), so the
 *    user comes back to a survivable queue rather than the full backlog on day one.
 *
 * This module is PURE domain logic: no DB, no IPC, no React, and (deliberately) NO `ts-fsrs`
 * import — it reads the already-computed retrievability/stability/`fsrsState`/lapse signals
 * off the flat queue row (`QueueQuery` decorates them), so the two-scheduler split stays
 * READ-ONLY here. `asOf`/`awayStart`/`awayEnd` are injected; there is no `Math.random()` —
 * the plans are fully reproducible (same input → same plan).
 *
 * It REUSES T077's value reasoning + fragile/mature classification ({@link queueItemScore},
 * {@link isCardFragile}) so the high-value/fragile items the auto-postpone valve protects
 * are exactly the items catch-up recovers FIRST and vacation never strands. The per-item
 * APPLY (attention reschedule vs FSRS card defer vs vacation suspend) lives in
 * `packages/local-db`'s `RecoveryModeService`; this module only decides the dates + the cost.
 */

import { type AutoPostponeInput, type AutoPostponeSignals, isCardFragile } from "./auto-postpone";
import { MS_PER_DAY } from "./date-util";
import {
  DEFAULT_QUEUE_SCORE_WEIGHTS,
  type QueueScoreInput,
  queueItemScore,
  type SessionMode,
} from "./queue-score";

/**
 * The flat row the recovery planners consume — the same structural shape T077's
 * {@link AutoPostponeInput} reads (the scorer's {@link QueueScoreInput} plus the card
 * fragility/leech signals + the explicit-protection flag). Structurally satisfied by
 * `QueueQuery`'s enriched `QueueItemSummary`, so the planners need no DB.
 */
export interface RecoveryInput extends AutoPostponeInput {
  /** The richer FSRS/leech signals used for the fragile↔mature classification. */
  readonly schedulerSignals: QueueScoreInput["schedulerSignals"] & AutoPostponeSignals;
  /** A human title for the cost preview / slips list (optional — falls back to id). */
  readonly title?: string;
}

/** Which apply seam a planned recovery item routes through — the two-scheduler split. */
export type RecoveryScheduler = "fsrs" | "attention";

/**
 * One planned MOVE in a recovery plan: the item + the EXACT absolute day it now lands on.
 * `scheduler` decides the apply seam (attention reschedule vs FSRS card defer); the absolute
 * `targetDueAt` is what `cardDeferTo` / `scheduleAt({ manual })` persist so the applied
 * per-day load curve matches the previewed plan day-for-day.
 */
export interface RecoveryPlanItem {
  readonly id: string;
  readonly type: string;
  readonly scheduler: RecoveryScheduler;
  /** The exact calendar day (ISO-8601) this item is moved to. */
  readonly targetDueAt: string;
}

/**
 * One planned SUSPEND in a vacation plan: the item is taken out of the queue for the away
 * window (status → `suspended`), to be resumed on return. The prior status is captured at
 * apply time (and in the op pre-image) so resume restores it exactly.
 */
export interface VacationSuspendItem {
  readonly id: string;
  readonly type: string;
}

/** One day of the load curve: a calendar day + how many items are due that day. */
export interface LoadCurvePoint {
  /** Local-agnostic calendar day key `YYYY-MM-DD` (UTC, derived from the due instant). */
  readonly date: string;
  readonly count: number;
}

/**
 * One item that NEWLY SLIPS because of the plan: its old vs new due, and by how many days.
 * This is the headline "cost of postponement" — what moves and by how much.
 */
export interface SlipRow {
  readonly id: string;
  readonly title: string;
  /** The due time BEFORE the plan (ISO-8601), or `null` (never-scheduled). */
  readonly fromDueAt: string | null;
  /** The due time AFTER the plan (ISO-8601). */
  readonly toDueAt: string;
  /** How many whole days later the item now lands (≥ 0). */
  readonly slipDays: number;
}

/**
 * The shared COST preview both planners return — it QUANTIFIES the cost of postponement
 * so the renderer can always show it BEFORE committing (the Done-when requirement):
 * total items moved, the new tail date (how far the last item now lands), the per-day load
 * curve BEFORE vs AFTER, and the per-item `slips` list (what newly slips + by how much).
 */
export interface PostponeCostPreview {
  /** Total items the plan MOVES (reschedules/defers). */
  readonly moved: number;
  /** The latest day any moved item now lands on (ISO-8601), or `null` when nothing moves. */
  readonly newTailDueAt: string | null;
  /** How many extra days the tail extends past where the backlog would otherwise sit. */
  readonly daysAdded: number;
  /** The per-day due load BEFORE the plan (today forward), oldest day first. */
  readonly loadBefore: readonly LoadCurvePoint[];
  /** The per-day due load AFTER the plan, oldest day first. */
  readonly loadAfter: readonly LoadCurvePoint[];
  /** What newly slips + by how many days (the explicit cost). */
  readonly slips: readonly SlipRow[];
}

/** A catch-up plan: the day-assigned moves + the cost preview. */
export interface CatchUpPlan {
  /** The items to move, each with its exact target day (earliest = highest value). */
  readonly items: readonly RecoveryPlanItem[];
  /** The quantified cost of postponement (shown before committing). */
  readonly cost: PostponeCostPreview;
}

/** A vacation plan: the suspends + the post-return shifts + the cost preview. */
export interface VacationPlan {
  /** Items SUSPENDED for the away window (resumed on return). */
  readonly suspend: readonly VacationSuspendItem[];
  /** Items SHIFTED to a day AFTER return (re-spread within budget, high-value first). */
  readonly shift: readonly RecoveryPlanItem[];
  /** The away window start (ISO-8601, echoed back). */
  readonly awayStart: string;
  /** The away window end (ISO-8601, echoed back). */
  readonly awayEnd: string;
  /** How many items were suspended for the window. */
  readonly suspendedCount: number;
  /** How many items were shifted past return. */
  readonly shiftedCount: number;
  /** The quantified cost of postponement. */
  readonly cost: PostponeCostPreview;
}

/** Options for {@link planCatchUp}. */
export interface CatchUpOptions {
  readonly items: readonly RecoveryInput[];
  /** The per-day cap the backlog is spread under (the daily review budget). */
  readonly budget: number;
  /** "Now" the spread starts from + the value ranking compares against (ISO-8601). */
  readonly asOf: string;
  /** Over how many days to spread the backlog (≥ 1). */
  readonly spreadDays: number;
  /** The mode the value ranking uses (default `"full"`). */
  readonly mode?: SessionMode;
}

/** Options for {@link planVacation}. */
export interface VacationOptions {
  readonly items: readonly RecoveryInput[];
  /** The away window start (inclusive, ISO-8601). */
  readonly awayStart: string;
  /** The away window end (inclusive, ISO-8601). `awayEnd` MUST be ≥ `awayStart`. */
  readonly awayEnd: string;
  /** "Now" the value ranking compares against (ISO-8601). */
  readonly asOf: string;
  /** The per-day cap the shifted load is re-spread under after return. */
  readonly budget: number;
  /** The mode the value ranking uses (default `"full"`). */
  readonly mode?: SessionMode;
}

/** The UTC `YYYY-MM-DD` key for an instant (the load-curve bucket). */
function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Parse an ISO instant to epoch ms, or `fallback` when unparseable. */
function parseMs(iso: string | null, fallback: number): number {
  if (!iso) return fallback;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? fallback : ms;
}

/**
 * The per-day load curve for a set of (id → dueMs) assignments, over `[startMs, endMs]`
 * inclusive (one bucket per calendar day). Days with no items still appear (count 0) so the
 * before/after curves align day-for-day. Items due before `startMs` bucket on the first day;
 * items due after `endMs` bucket on the last day (so the curve never silently drops load).
 */
function loadCurve(
  dueMsById: ReadonlyMap<string, number>,
  startMs: number,
  endMs: number,
): LoadCurvePoint[] {
  const startDay = Date.parse(`${dayKey(startMs)}T00:00:00.000Z`);
  const endDay = Date.parse(`${dayKey(endMs)}T00:00:00.000Z`);
  const points: LoadCurvePoint[] = [];
  const counts = new Map<string, number>();
  for (let d = startDay; d <= endDay; d += MS_PER_DAY) {
    const key = dayKey(d);
    counts.set(key, 0);
    points.push({ date: key, count: 0 });
  }
  for (const due of dueMsById.values()) {
    let key: string;
    if (due < startDay) key = dayKey(startDay);
    else if (due > endDay) key = dayKey(endDay);
    else key = dayKey(due);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return points.map((p) => ({ date: p.date, count: counts.get(p.date) ?? 0 }));
}

/** Whole days between two instants (≥ 0), rounded to the nearest day. */
function slipDaysBetween(fromMs: number, toMs: number): number {
  return Math.max(0, Math.round((toMs - fromMs) / MS_PER_DAY));
}

/**
 * Rank rows by VALUE for recovery: highest value first (reverse of T077's victim order),
 * so high-value/fragile items land on the earliest days. Fragile cards get a deliberate
 * value BOOST so a fragile high-value memory is recovered before an equally-scored mature
 * one (a fragile memory is the one about to be lost). Ties break by id ASC for determinism.
 */
function rankByValueDesc(
  items: readonly RecoveryInput[],
  asOfMs: number,
  mode: SessionMode,
): RecoveryInput[] {
  const recoveryValue = (item: RecoveryInput): number => {
    const base = queueItemScore(item, { mode, asOfMs, weights: DEFAULT_QUEUE_SCORE_WEIGHTS });
    // A fragile card is the most perishable memory — boost it so it recovers first.
    const fragileBoost = item.type === "card" && isCardFragile(item.schedulerSignals) ? 0.5 : 0;
    return base + fragileBoost;
  };
  return [...items].sort((a, b) => {
    const va = recoveryValue(a);
    const vb = recoveryValue(b);
    if (va !== vb) return vb - va; // highest value first
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * Assign each ranked item (highest value first) to the EARLIEST day (starting `startMs`,
 * one day apart) that still has capacity `< budget`, filling day 0, then day 1, …. Returns
 * the per-item target instant (ms) keyed by id. When the backlog exceeds `spreadDays ×
 * budget`, the overflow lands on the LAST day (it can't be cleared sooner; the cost preview
 * shows that day over budget rather than silently dropping items). The within-day time is
 * fixed to noon UTC so a "day" is a stable calendar slot.
 */
function spreadAcrossDays(
  ranked: readonly RecoveryInput[],
  startMs: number,
  spreadDays: number,
  budget: number,
): Map<string, number> {
  const perDayCap = Math.max(1, budget);
  const days = Math.max(1, spreadDays);
  // Day 0 = noon UTC on `startMs`'s calendar day; each subsequent day adds 24h. Noon keeps a
  // "day" a stable calendar slot (so the load-curve bucket — derived from the same UTC day —
  // is unambiguous and never lands on a boundary).
  const day0Ms = Date.parse(`${dayKey(startMs)}T12:00:00.000Z`);
  const dayInstant = (offset: number): number => day0Ms + offset * MS_PER_DAY;
  const assigned = new Map<string, number>();
  const dayCounts = new Array<number>(days).fill(0);
  let cursor = 0;
  for (const item of ranked) {
    // Advance to the first day with remaining capacity (or stop at the last day).
    while (cursor < days - 1 && (dayCounts[cursor] ?? 0) >= perDayCap) cursor += 1;
    dayCounts[cursor] = (dayCounts[cursor] ?? 0) + 1;
    assigned.set(item.id, dayInstant(cursor));
  }
  return assigned;
}

/**
 * Build the shared {@link PostponeCostPreview} from the before/after due assignments. The
 * curve window runs from `asOf`'s day to the latest of the after-tail and a fixed horizon, so
 * both curves cover the same span. `slips` lists only items whose due moved LATER.
 */
function buildCost(
  before: ReadonlyMap<string, number>,
  after: ReadonlyMap<string, number>,
  titleById: ReadonlyMap<string, string>,
  fromById: ReadonlyMap<string, string | null>,
  asOfMs: number,
): PostponeCostPreview {
  const afterValues = [...after.values()];
  const newTailMs = afterValues.length > 0 ? Math.max(...afterValues) : null;
  const beforeValues = [...before.values()];
  const beforeTailMs = beforeValues.length > 0 ? Math.max(...beforeValues) : asOfMs;

  // The curve spans asOf's day → the after-tail's day (or the before-tail, whichever later),
  // so the before/after curves align and the extension is visible.
  const endMs = Math.max(newTailMs ?? asOfMs, beforeTailMs, asOfMs);
  const loadBefore = loadCurve(before, asOfMs, endMs);
  const loadAfter = loadCurve(after, asOfMs, endMs);

  const slips: SlipRow[] = [];
  for (const [id, toMs] of after) {
    const beforeMs = before.get(id);
    const fromMs = beforeMs ?? asOfMs;
    if (toMs <= fromMs) continue; // not a slip (same day or earlier)
    slips.push({
      id,
      title: titleById.get(id) ?? id,
      fromDueAt: fromById.get(id) ?? null,
      toDueAt: new Date(toMs).toISOString(),
      slipDays: slipDaysBetween(fromMs, toMs),
    });
  }
  // Deterministic order: largest slip first, then id.
  slips.sort((a, b) => b.slipDays - a.slipDays || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return {
    moved: after.size,
    newTailDueAt: newTailMs != null ? new Date(newTailMs).toISOString() : null,
    daysAdded: newTailMs != null ? slipDaysBetween(beforeTailMs, newTailMs) : 0,
    loadBefore,
    loadAfter,
    slips,
  };
}

/**
 * Plan a CATCH-UP: spread the overdue/due backlog forward over `spreadDays` so each day's
 * load ≤ `budget`, putting HIGH-VALUE / FRAGILE items on the EARLIEST days and low-value on
 * the latest. Returns the day-assigned moves + the quantified cost (per-day load curve before
 * vs after + the `slips`). Pure + deterministic — same input always yields the same plan.
 *
 * Only items that actually MOVE LATER appear in the plan (an item already landing on its
 * current day — e.g. when the backlog already fits day 0 — is not rescheduled). High-value
 * fragile cards are never pushed to the back: they sort to day 0 first.
 */
export function planCatchUp(options: CatchUpOptions): CatchUpPlan {
  const asOfMs = parseMs(options.asOf, Date.now());
  const mode = options.mode ?? "full";
  const ranked = rankByValueDesc(options.items, asOfMs, mode);

  const before = new Map<string, number>();
  const titleById = new Map<string, string>();
  const fromById = new Map<string, string | null>();
  for (const item of options.items) {
    before.set(item.id, parseMs(item.dueAt, asOfMs));
    titleById.set(item.id, item.title ?? item.id);
    fromById.set(item.id, item.dueAt);
  }

  const targets = spreadAcrossDays(ranked, asOfMs, options.spreadDays, options.budget);

  // The plan is only the items whose target lands LATER than where they already sit (a
  // catch-up that puts the whole backlog on day 0 within budget moves nothing).
  const planItems: RecoveryPlanItem[] = [];
  const after = new Map<string, number>();
  for (const item of ranked) {
    const targetMs = targets.get(item.id) ?? asOfMs;
    const fromMs = before.get(item.id) ?? asOfMs;
    after.set(item.id, targetMs);
    if (targetMs > fromMs) {
      planItems.push({
        id: item.id,
        type: item.type,
        scheduler: item.scheduler,
        targetDueAt: new Date(targetMs).toISOString(),
      });
    }
  }
  // Deterministic plan order: earliest target first, then by value (id tiebreak).
  planItems.sort(
    (a, b) =>
      Date.parse(a.targetDueAt) - Date.parse(b.targetDueAt) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  const cost = buildCost(before, after, titleById, fromById, asOfMs);
  return { items: planItems, cost };
}

/**
 * Plan a VACATION over `[awayStart, awayEnd]`: find everything that would come due IN that
 * window, choose SUSPEND (status, for fragile/high-value memory that should simply pause) vs
 * SHIFT-past-return (reschedule, for durable items that can recede), and re-spread the shifted
 * load over the days AFTER `awayEnd` within `budget` (high-value first). Returns the suspends +
 * the day-assigned shifts + the quantified cost. Pure + deterministic.
 *
 * The SUSPEND-vs-SHIFT split: a FRAGILE card (the most perishable memory) is SUSPENDED so its
 * FSRS trajectory simply pauses for the trip rather than being pushed weeks out; everything
 * else (attention items + mature cards) is SHIFTED to after return and re-spread within budget,
 * high-value first. This keeps "high-value fragile memory is protected" — a fragile card is
 * never sacrificed to a far-future date, it is paused and resumed.
 */
export function planVacation(options: VacationOptions): VacationPlan {
  const asOfMs = parseMs(options.asOf, Date.now());
  const mode = options.mode ?? "full";
  const awayStartMs = parseMs(options.awayStart, asOfMs);
  const awayEndMs = parseMs(options.awayEnd, asOfMs);

  // Everything due strictly within the away window (inclusive bounds).
  const inWindow = options.items.filter((item) => {
    const due = parseMs(item.dueAt, asOfMs);
    return due >= awayStartMs && due <= awayEndMs;
  });

  const before = new Map<string, number>();
  const titleById = new Map<string, string>();
  const fromById = new Map<string, string | null>();
  for (const item of inWindow) {
    before.set(item.id, parseMs(item.dueAt, asOfMs));
    titleById.set(item.id, item.title ?? item.id);
    fromById.set(item.id, item.dueAt);
  }

  // Partition: fragile cards are SUSPENDED (paused), everything else is SHIFTED past return.
  const suspend: VacationSuspendItem[] = [];
  const toShift: RecoveryInput[] = [];
  for (const item of inWindow) {
    if (item.type === "card" && isCardFragile(item.schedulerSignals)) {
      suspend.push({ id: item.id, type: item.type });
    } else {
      toShift.push(item);
    }
  }
  // Deterministic suspend order (id).
  suspend.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // Re-spread the shifted load over the days AFTER return, high-value first, within budget.
  const ranked = rankByValueDesc(toShift, asOfMs, mode);
  const firstDayAfterReturnMs = Date.parse(`${dayKey(awayEndMs + MS_PER_DAY)}T12:00:00.000Z`);
  // Spread window = enough days to hold the shifted load at `budget`/day (≥ 1).
  const spreadDays = Math.max(1, Math.ceil(ranked.length / Math.max(1, options.budget)));
  const targets = spreadAcrossDays(ranked, firstDayAfterReturnMs, spreadDays, options.budget);

  const shift: RecoveryPlanItem[] = [];
  const after = new Map<string, number>();
  // Suspended items leave the curve entirely (paused → no due day during the plan horizon).
  for (const item of ranked) {
    const targetMs = targets.get(item.id) ?? firstDayAfterReturnMs;
    after.set(item.id, targetMs);
    shift.push({
      id: item.id,
      type: item.type,
      scheduler: item.scheduler,
      targetDueAt: new Date(targetMs).toISOString(),
    });
  }
  shift.sort(
    (a, b) =>
      Date.parse(a.targetDueAt) - Date.parse(b.targetDueAt) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  // The cost curve only covers the SHIFTED items (suspended items have no due during the
  // horizon — they are paused). `before` is restricted to the shifted set to align.
  const beforeShifted = new Map<string, number>();
  for (const item of toShift) beforeShifted.set(item.id, before.get(item.id) ?? asOfMs);
  const cost = buildCost(beforeShifted, after, titleById, fromById, asOfMs);

  return {
    suspend,
    shift,
    awayStart: options.awayStart,
    awayEnd: options.awayEnd,
    suspendedCount: suspend.length,
    shiftedCount: shift.length,
    cost,
  };
}
