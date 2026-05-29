/**
 * Priority (T005).
 *
 * Priority is first-class on every source, extract, card, and task. It is stored
 * **numerically** (a normalized `0.0`–`1.0` value, `1.0` = highest) so the
 * scheduler can do continuous math — protect high-value fragile memory, sacrifice
 * low-priority topics first under overload, and stop newly imported material from
 * automatically dominating older high-value material. The MVP UI surfaces only
 * four coarse labels (A/B/C/D); this module converts BOTH directions so the
 * numeric store and the label UI never drift apart.
 *
 * Keeping conversion here (framework-agnostic, tested) keeps priority logic out
 * of React components, per the layering rules.
 */

import { clamp01 } from "./numeric";

/**
 * Normalized numeric priority, `0.0`–`1.0` (higher = more important). This is
 * what SQLite stores (`elements.priority`) and what the scheduler scores against.
 */
export type Priority = number;

/**
 * The four coarse priority labels shown in the MVP UI:
 *
 *  - `A` high value (want to remember) — most protected
 *  - `B` useful
 *  - `C` maybe / nice to have
 *  - `D` low / background — skimmed or deleted first under overload
 */
export const PRIORITY_LABELS = ["A", "B", "C", "D"] as const;
export type PriorityLabel = (typeof PRIORITY_LABELS)[number];

/**
 * The representative numeric value each label maps TO when a user picks a label.
 * Bands are centered so that round-tripping a label → number → label is stable
 * (see {@link priorityToLabel} thresholds). `A`=0.875, `B`=0.625, `C`=0.375,
 * `D`=0.125 — the midpoints of four equal quarters of the `[0,1]` range.
 */
export const PRIORITY_LABEL_VALUE: Readonly<Record<PriorityLabel, Priority>> = {
  A: 0.875,
  B: 0.625,
  C: 0.375,
  D: 0.125,
};

/**
 * Lower-bound thresholds (inclusive) used to bucket a numeric priority into a
 * label. A value `>= 0.75` is `A`, `>= 0.5` is `B`, `>= 0.25` is `C`, else `D`.
 * Ordered high → low so {@link priorityToLabel} can return the first match.
 */
const PRIORITY_LABEL_THRESHOLDS: readonly (readonly [PriorityLabel, number])[] = [
  ["A", 0.75],
  ["B", 0.5],
  ["C", 0.25],
  ["D", 0],
];

/** Default priority for freshly imported material: `C` (maybe / nice to have). */
export const DEFAULT_PRIORITY: Priority = PRIORITY_LABEL_VALUE.C;

/** Type guard: is `value` one of the four label strings? */
export function isPriorityLabel(value: unknown): value is PriorityLabel {
  return typeof value === "string" && (PRIORITY_LABELS as readonly string[]).includes(value);
}

/**
 * Convert a coarse {@link PriorityLabel} to its representative numeric
 * {@link Priority} (label → number). Used when a user picks `A`/`B`/`C`/`D` in
 * the UI and we need a value to store/schedule against.
 */
export function priorityFromLabel(label: PriorityLabel): Priority {
  return PRIORITY_LABEL_VALUE[label];
}

/**
 * Convert a numeric {@link Priority} to its coarse {@link PriorityLabel}
 * (number → label) for display. Out-of-range inputs are clamped to `[0,1]`
 * first so a stored value can never produce an undefined label.
 */
export function priorityToLabel(priority: Priority): PriorityLabel {
  const v = clamp01(priority);
  for (const [label, lowerBound] of PRIORITY_LABEL_THRESHOLDS) {
    if (v >= lowerBound) {
      return label;
    }
  }
  // Unreachable: the `D` threshold is 0 and `v` is clamped to >= 0.
  return "D";
}
