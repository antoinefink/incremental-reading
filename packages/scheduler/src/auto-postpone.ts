/**
 * Auto-postpone planning (T077) — the deterministic OVERLOAD VALVE.
 *
 * `docs/scheduling-and-priority.md` ("Overload handling → Auto-postpone") asks: when
 * the due load exceeds the daily budget, postpone the overflow by VALUE — **low-priority
 * topics/sources/extracts first, then low-priority *mature* cards**, while **never
 * touching high-priority *fragile* cards** (or leeches under repair, or items the user
 * explicitly protected). This module is that selection, as PURE domain logic: no DB, no
 * IPC, no React, and (deliberately) NO `ts-fsrs` import — it reads the already-computed
 * retrievability/stability/`fsrsState`/lapse signals off the flat queue row (`QueueQuery`
 * decorates them), so the two-scheduler split stays READ-ONLY here. `asOf` is injected so
 * there is no hidden `Date.now()`; there is no `Math.random()` — the plan is fully
 * reproducible (same due set + budget → same plan).
 *
 * THE FRAGILE↔MATURE CUTLINE is the heart of the protection rule: a card is MATURE only
 * when `fsrsState === "review"` AND its stability clears {@link CARD_MATURE_STABILITY_DAYS}
 * (and, when retrievability is known, it is above {@link CARD_MATURE_RETRIEVABILITY}); a
 * card that is new/learning/relearning, or whose stability/retrievability is below the
 * cutline, is FRAGILE and is never sacrificed to free up budget. The whole point is that
 * a high-priority *fragile* card keeps its place even under heavy overload — only durable,
 * low-value memories (mature cards) and low-value reading items recede.
 *
 * It reuses T076's {@link queueItemScore} to rank victims WITHIN each tier (lowest score
 * first), so "what is least valuable right now" is one consistent notion across auto-sort
 * and auto-postpone.
 */

import { isLeech, LEECH_LAPSE_THRESHOLD } from "./leech";
import {
  DEFAULT_QUEUE_SCORE_WEIGHTS,
  type QueueScoreInput,
  queueItemScore,
  type SessionMode,
} from "./queue-score";

/**
 * The FSRS/leech signals the planner reads off a card row — a structural superset of the
 * scorer's {@link QueueScoreInput}. The queue's `schedulerSignals` already carries these
 * (retrievability/stability/`fsrsState`/lapses); declared here minimally so
 * `packages/scheduler` does not depend on `packages/local-db`.
 */
export interface AutoPostponeSignals {
  /** Card recall probability now (`0.0`–`1.0`), or `null` for new/attention rows. */
  readonly retrievability: number | null;
  /** FSRS memory stability in days, or `null` for new/attention rows. */
  readonly stability: number | null;
  /** Current FSRS phase (`new`/`learning`/`review`/`relearning`), or `null` for attention rows. */
  readonly fsrsState: string | null;
  /** Cumulative FSRS lapses (failed reviews) — drives leech exclusion; `null` for attention rows. */
  readonly lapses: number | null;
}

/**
 * The flat row the planner consumes — the scorer's {@link QueueScoreInput} plus the
 * card fragility/leech signals + the explicit-protection flag. Structurally satisfied by
 * `QueueQuery`'s enriched `QueueItemSummary` (so the planner needs no DB).
 */
export interface AutoPostponeInput extends QueueScoreInput {
  /** The richer FSRS/leech signals used for the fragile↔mature + leech classification. */
  readonly schedulerSignals: QueueScoreInput["schedulerSignals"] & AutoPostponeSignals;
  /** True for an A-priority / user-protected row — never auto-postponed. */
  readonly protected: boolean;
}

/**
 * The stability (in days) a card must clear — together with `fsrsState === "review"` — to
 * count as MATURE (a durable memory that can recede under overload without real risk).
 * Below this, or in a non-`review` phase, the card is FRAGILE and protected. 21 days is a
 * deliberate, defensible cutline (roughly three weeks of retained stability); it is a named
 * constant so a future per-collection setting can override it without hunting for a literal.
 */
export const CARD_MATURE_STABILITY_DAYS = 21 as const;

/**
 * The retrievability floor a card must be above (when its retrievability is known) to count
 * as MATURE. A card whose recall probability has already decayed below this is treated as
 * FRAGILE (about to be forgotten — exactly the memory the user must not lose), even if its
 * stability is high. `0.9` mirrors the FSRS default desired-retention target.
 */
export const CARD_MATURE_RETRIEVABILITY = 0.9 as const;

/** Which apply seam a planned victim routes through — the two-scheduler split made explicit. */
export type PostponeKind = "attention" | "cardDefer";

/** Why a victim was chosen (surfaced in the preview so the cost is legible). */
export type PostponeReason = "low-priority-topic" | "low-priority-mature-card";

/** One planned postpone — the id + which scheduler/apply seam it routes through. */
export interface PostponePlanItem {
  readonly id: string;
  readonly type: string;
  readonly scheduler: "fsrs" | "attention";
  /** The apply seam: `attention` → reschedule on the attention scheduler; `cardDefer` → FSRS defer. */
  readonly postponeKind: PostponeKind;
  /** Why this item was sacrificed (for the preview). */
  readonly reason: PostponeReason;
}

/** The deterministic postpone plan: the ordered victims + the resulting counts. */
export interface AutoPostponePlan {
  /** The items to postpone, in application order (cheapest value first). */
  readonly items: readonly PostponePlanItem[];
  /** How many items would be postponed (`items.length`). */
  readonly count: number;
  /** The due count that remains after applying the plan (≤ budget when achievable). */
  readonly remainingAfter: number;
}

/** Options for {@link planAutoPostpone}. */
export interface AutoPostponeOptions {
  /** The daily review budget — the threshold the remaining due count must drop to. */
  readonly budget: number;
  /** "Now" the victim ranking compares against (ISO-8601); defaults to the wall clock. */
  readonly asOf?: string;
  /**
   * Protect ALL high-priority (band A) cards from postponement regardless of maturity
   * (default `true`). A high-priority fragile card is never a victim; this additionally
   * shields a high-priority *mature* card so "high-priority memory is protected" holds
   * for the whole A band, not just the fragile slice.
   */
  readonly protectHighPriority?: boolean;
  /** The mode the victim-ranking score uses (default `"full"`); the plan is mode-stable. */
  readonly mode?: SessionMode;
}

/** Band-A threshold (mirrors `@interleave/core` `priorityToLabel`: A ≥ 0.75). */
const HIGH_PRIORITY_THRESHOLD = 0.75;
/** Band C/D threshold — "low priority" is below band B (B ≥ 0.5), i.e. C/D. */
const LOW_PRIORITY_THRESHOLD = 0.5;

/** Whether a row is high priority (band A) — never sacrificed when protecting. */
function isHighPriority(item: AutoPostponeInput): boolean {
  return item.priority >= HIGH_PRIORITY_THRESHOLD;
}

/** Whether a row is low priority (band C/D) — the only auto-postpone victims. */
function isLowPriority(item: AutoPostponeInput): boolean {
  return item.priority < LOW_PRIORITY_THRESHOLD;
}

/**
 * Whether a card is MATURE — a durable memory that can recede under overload. Mature ⇔
 * `fsrsState === "review"` AND stability ≥ {@link CARD_MATURE_STABILITY_DAYS} AND (when its
 * retrievability is known) retrievability ≥ {@link CARD_MATURE_RETRIEVABILITY}. Pure over
 * the row's signals. A non-card row is never "mature" in this sense (it is not a memory).
 */
export function isCardMature(signals: AutoPostponeSignals): boolean {
  if (signals.fsrsState !== "review") return false;
  if (signals.stability == null || signals.stability < CARD_MATURE_STABILITY_DAYS) return false;
  if (signals.retrievability != null && signals.retrievability < CARD_MATURE_RETRIEVABILITY) {
    return false;
  }
  return true;
}

/**
 * Whether a card is FRAGILE — anything that is NOT mature (new/learning/relearning, or low
 * stability/retrievability). The protection rule keys off this: a high-priority fragile card
 * is never auto-postponed. The exact inverse of {@link isCardMature} for cards.
 */
export function isCardFragile(signals: AutoPostponeSignals): boolean {
  return !isCardMature(signals);
}

/** Whether a card row is a leech (lapses ≥ threshold) — excluded from auto-postpone. */
function isLeechRow(item: AutoPostponeInput): boolean {
  const lapses = item.schedulerSignals.lapses;
  if (lapses == null) return false;
  return isLeech({ lapses }, LEECH_LAPSE_THRESHOLD);
}

/**
 * Plan the overload auto-postpone. Returns a DETERMINISTIC, ordered list of victims so the
 * remaining due count drops to ≤ `budget`, applying the doc's exact victim policy:
 *
 *   1. **low-priority attention items** (topics/sources/extracts/tasks/synthesis notes,
 *      band C/D) — lowest {@link queueItemScore} first;
 *   2. then **low-priority *mature* cards** — lowest score first; NEVER a fragile card and
 *      NEVER a high-priority card while `protectHighPriority`;
 *   3. it STOPS as soon as the remaining due count is back within budget.
 *
 * It NEVER selects a high-priority fragile card, a leech, or a `protected` (band-A / pinned)
 * item. Pure: no DB, no IPC, no React, no randomness — same input always yields the same plan.
 */
export function planAutoPostpone(
  items: readonly AutoPostponeInput[],
  options: AutoPostponeOptions,
): AutoPostponePlan {
  const protectHighPriority = options.protectHighPriority ?? true;
  const parsedAsOf = options.asOf ? Date.parse(options.asOf) : Date.now();
  const asOfMs = Number.isNaN(parsedAsOf) ? Date.now() : parsedAsOf;
  const mode = options.mode ?? ("full" as SessionMode);
  // Rank victims by the SAME value reasoning as T076's auto-sort (reusing its default
  // weights), so "least valuable right now" is one consistent notion across both.
  const score = (item: AutoPostponeInput): number =>
    queueItemScore(item, { mode, asOfMs, weights: DEFAULT_QUEUE_SCORE_WEIGHTS });

  // How many items must recede to get the WHOLE due set back within budget.
  const overflow = Math.max(0, items.length - Math.max(0, options.budget));
  if (overflow === 0) {
    return { items: [], count: 0, remainingAfter: items.length };
  }

  // Eligible victims, partitioned into the two tiers. An item is eligible only if it is
  // low priority AND not explicitly protected; cards additionally must be mature, not
  // fragile, not a leech, and (when protecting) not high priority (already excluded by the
  // low-priority gate, but checked explicitly for clarity/defense).
  const lowAttention: AutoPostponeInput[] = [];
  const lowMatureCards: AutoPostponeInput[] = [];
  for (const item of items) {
    if (item.protected) continue; // explicitly pinned — never auto-postponed
    if (!isLowPriority(item)) continue; // only band C/D recedes
    if (item.type === "card") {
      if (protectHighPriority && isHighPriority(item)) continue; // belt-and-suspenders
      if (isLeechRow(item)) continue; // leeches are under repair, not auto-postponed
      if (isCardFragile(item.schedulerSignals)) continue; // fragile memory is PROTECTED
      lowMatureCards.push(item);
    } else {
      lowAttention.push(item);
    }
  }

  // Within each tier rank by ascending score (least valuable first); tie-break by id ASC so
  // a fixed input always yields a fixed plan.
  const byScoreThenId = (a: AutoPostponeInput, b: AutoPostponeInput): number => {
    const sa = score(a);
    const sb = score(b);
    if (sa !== sb) return sa - sb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
  lowAttention.sort(byScoreThenId);
  lowMatureCards.sort(byScoreThenId);

  // Drain attention items first, then mature cards, stopping as soon as the remaining due
  // count is within budget.
  const ordered = [...lowAttention, ...lowMatureCards];
  const plan: PostponePlanItem[] = [];
  let remaining = items.length;
  for (const item of ordered) {
    if (remaining <= options.budget) break;
    plan.push({
      id: item.id,
      type: item.type,
      scheduler: item.scheduler,
      postponeKind: item.type === "card" ? "cardDefer" : "attention",
      reason: item.type === "card" ? "low-priority-mature-card" : "low-priority-topic",
    });
    remaining -= 1;
  }

  return { items: plan, count: plan.length, remainingAfter: remaining };
}
