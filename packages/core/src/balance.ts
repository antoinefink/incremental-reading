/**
 * Import / process balance rule (T046).
 *
 * The core failure mode of an incremental-reading system is **importing faster
 * than you process**: the inbox silently fills with new material that buries the
 * older, higher-value items you meant to distill. This module is the SINGLE,
 * pure, tunable place that decides whether the user is in that state, given the
 * week's four headline numbers.
 *
 * Why it lives in `@interleave/core` (not `packages/local-db`, not React):
 *  - the judgment is a pure function of four counts + two thresholds, so it is
 *    trivially unit-testable and identical wherever it runs;
 *  - the SAME rule + constants back the domain aggregation (`computeBalance` in
 *    `packages/local-db`) AND any future preview/UI — they cannot disagree;
 *  - the factor is a stable, user-overridable SETTING (`importBalanceFactor`),
 *    and a setting needs a home that has no DB/Electron dependency.
 *
 * The rule is **advisory only**. It NEVER mutates a schedule — auto-postpone /
 * overload management (sacrificing low-priority material when due load exceeds
 * the budget) is M16/T077. T046 just SURFACES the imbalance as a `Banner`.
 *
 * ## The rule (documented + tunable)
 *
 * "Processed output" this week = `extractsCreated + cardsCreated` (the two ways a
 * raw import turns into durable, distilled knowledge). "Imports" = `sourcesImported`.
 *
 * We compare imports to processed output by a `factor`:
 *   - `ok`     — imports are roughly in line with (or below) what you processed;
 *   - `warn`   — imports exceed processed output by `factor`× (you're falling behind);
 *   - `danger` — imports exceed processed output by `DANGER_MULTIPLIER × factor`×
 *                (the gap is severe).
 *
 * A **floor** (`IMPORT_BALANCE_FLOOR`) gates the whole thing: a quiet week with
 * only a handful of imports never raises an alarm, even at a high ratio (3 imports
 * and 0 extracts is not a crisis). The banner only fires once `sourcesImported`
 * crosses the floor AND the ratio crosses the factor.
 *
 * `reviewsDueThisWeek` is reported alongside (the fourth headline number) but does
 * NOT enter the imbalance judgment — it is context for the user ("…and you already
 * have K reviews due"), not part of the import-vs-process ratio.
 */

/** A severity bucket for the balance banner. `ok` hides it; `warn`/`danger` show it. */
export type BalanceSeverity = "ok" | "warn" | "danger";

/**
 * The four weekly headline numbers the rule + banner read. Counts are over the
 * balance window (default 7 days); `reviewsDueThisWeek` looks FORWARD.
 */
export interface BalanceCounts {
  /** `source` elements imported (created) in the window. */
  readonly sourcesImported: number;
  /** `extract` elements created in the window. */
  readonly extractsCreated: number;
  /** `card` elements created in the window. */
  readonly cardsCreated: number;
  /** Reviews (cards, optionally + attention items) due within the next 7 days. */
  readonly reviewsDueThisWeek: number;
}

/** The judgment produced by {@link judgeBalance}. */
export interface BalanceJudgment {
  /** True when `severity !== "ok"` — the banner is shown. */
  readonly imbalanced: boolean;
  /** The severity bucket driving the banner variant. */
  readonly severity: BalanceSeverity;
  /**
   * `imports / max(processedOutput, 1)` — the ratio the judgment is based on,
   * exposed for debugging/preview (the banner shows the raw counts, not this).
   */
  readonly ratio: number;
  /** Processed output this window (`extractsCreated + cardsCreated`). */
  readonly processedOutput: number;
}

/**
 * Default imbalance factor: imports must exceed processed output by this multiple
 * to count as falling behind. `1.5` means "you imported at least 50% more than you
 * processed". Overridable per-user via `SETTINGS_KEYS.importBalanceFactor`.
 */
export const DEFAULT_IMPORT_BALANCE_FACTOR = 1.5;

/** Inclusive bounds for the user-tunable import-balance factor. */
export const IMPORT_BALANCE_FACTOR_MIN = 1.1;
export const IMPORT_BALANCE_FACTOR_MAX = 5;

/**
 * Import floor: a week with fewer than this many imported sources never raises an
 * alarm regardless of ratio (a quiet week is not an overload). Kept a constant
 * (not a setting) — it is a false-alarm guard, not a preference dial.
 */
export const IMPORT_BALANCE_FLOOR = 5;

/**
 * How much worse than `warn` the ratio must be to escalate to `danger`. At the
 * default factor `1.5`, `danger` triggers at `1.5 × 2 = 3×` processed output.
 */
export const DANGER_MULTIPLIER = 2;

/**
 * Decide whether imports outpace processing this window. PURE — no I/O, no
 * mutation. `factor` defaults to {@link DEFAULT_IMPORT_BALANCE_FACTOR} and is
 * clamped to the documented bounds so a malformed setting can never disable or
 * over-trigger the warning.
 *
 *  - Below the {@link IMPORT_BALANCE_FLOOR} of imports → always `ok` (quiet week).
 *  - `imports >= processedOutput × factor × DANGER_MULTIPLIER` → `danger`.
 *  - `imports >= processedOutput × factor` → `warn`.
 *  - otherwise → `ok`.
 *
 * When `processedOutput` is `0` and imports are at/above the floor, the ratio is
 * effectively infinite, so the rule escalates straight to `warn`/`danger` by the
 * absolute import count (you imported a lot and distilled nothing).
 */
export function judgeBalance(
  counts: Pick<BalanceCounts, "sourcesImported" | "extractsCreated" | "cardsCreated">,
  factor: number = DEFAULT_IMPORT_BALANCE_FACTOR,
): BalanceJudgment {
  const imports = Math.max(0, Math.trunc(counts.sourcesImported));
  const processedOutput =
    Math.max(0, Math.trunc(counts.extractsCreated)) + Math.max(0, Math.trunc(counts.cardsCreated));

  // Clamp the (possibly user-supplied) factor into the documented bounds.
  const f = clampFactor(factor);

  // Ratio of imports to processed output (≥ 1 denominator so it is finite and the
  // 0-output case is governed by absolute import count via the thresholds below).
  const ratio = imports / Math.max(processedOutput, 1);

  // The warn / danger thresholds in ABSOLUTE imported-source terms.
  const warnThreshold = processedOutput * f;
  const dangerThreshold = processedOutput * f * DANGER_MULTIPLIER;

  // The floor guard: a quiet week never alarms.
  if (imports < IMPORT_BALANCE_FLOOR) {
    return { imbalanced: false, severity: "ok", ratio, processedOutput };
  }

  // 0 processed output is the worst case: any import volume at/above the floor is
  // at least a `warn`, escalating to `danger` at 2× the floor.
  if (processedOutput === 0) {
    const severity: BalanceSeverity =
      imports >= IMPORT_BALANCE_FLOOR * DANGER_MULTIPLIER ? "danger" : "warn";
    return { imbalanced: true, severity, ratio, processedOutput };
  }

  if (imports >= dangerThreshold) {
    return { imbalanced: true, severity: "danger", ratio, processedOutput };
  }
  if (imports >= warnThreshold) {
    return { imbalanced: true, severity: "warn", ratio, processedOutput };
  }
  return { imbalanced: false, severity: "ok", ratio, processedOutput };
}

/** Clamp an arbitrary (possibly malformed) factor into the documented bounds. */
export function clampFactor(factor: number): number {
  if (!Number.isFinite(factor)) return DEFAULT_IMPORT_BALANCE_FACTOR;
  return Math.min(IMPORT_BALANCE_FACTOR_MAX, Math.max(IMPORT_BALANCE_FACTOR_MIN, factor));
}
