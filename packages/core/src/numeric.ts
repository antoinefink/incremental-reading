/**
 * Small numeric helpers shared by the domain (T005).
 *
 * Framework-agnostic and dependency-free, per the layering rules. Kept tiny and
 * pure so they are trivially testable and reusable by the scheduler/priority
 * code without dragging in any persistence or UI concern.
 */

/**
 * Clamp a number into the closed unit interval `[0, 1]`. `NaN` clamps to `0` so
 * a corrupt stored value can never escape the range. Used by priority and
 * (later) scheduler scoring, both of which operate on normalized `0.0`–`1.0`
 * values.
 */
export function clamp01(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}
