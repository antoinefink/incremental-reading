/**
 * Display formatting for FSRS scheduler signals.
 *
 * The FSRS optimizer stores stability/difficulty as raw doubles (e.g.
 * `4.88681033` days, `7.37018264`/10). Surfacing the full precision in the
 * inspector chip + stat cards overflows the box and reads as absurdly precise —
 * nobody needs eight decimal places of "days". These helpers truncate the
 * DISPLAY to a calm, fixed precision; the canonical value is untouched (it stays
 * in the payload and is surfaced verbatim via a `title` on hover). Pure
 * presentation — no scheduling math lives here.
 */

/** Drop a trailing fractional zero so `"4.0"` → `"4"` while `"4.9"` is kept. */
function trimTrailingZero(value: string): string {
  return value.includes(".") ? value.replace(/\.?0+$/, "") : value;
}

/** Round to one decimal place (avoids float noise like `4.8999999`). */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Format FSRS memory **stability** (a number of DAYS) for display.
 *
 * One decimal under 10 days, where the fraction is meaningful (`4.88681033` →
 * `"4.9"`); a whole number at 10 days and beyond, where the fractional day no
 * longer matters (`12.34` → `"12"`, `364.7` → `"365"`). Non-finite or
 * non-positive input clamps to `"0"`. The unit (`d`) is rendered by the caller.
 */
export function formatStability(days: number): string {
  if (!Number.isFinite(days) || days <= 0) return "0";
  if (days < 10) return trimTrailingZero(round1(days).toFixed(1));
  return Math.round(days).toString();
}

/**
 * Format FSRS **difficulty** (a `0`–`10` scale) for display: one decimal place
 * (`7.37018264` → `"7.4"`), `10.0` collapsed to `"10"`, clamped to `[0, 10]`.
 * The `/10` suffix is rendered by the caller.
 */
export function formatDifficulty(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  return trimTrailingZero(round1(Math.min(10, value)).toFixed(1));
}
