/**
 * Stable seeded queue jitter (T029).
 *
 * `scheduling-and-priority.md`'s daily-queue rule asks for 10–20% randomness on
 * the otherwise deterministic priority-then-due-date order, so the user isn't
 * trapped grinding one topic. The queue READ (`packages/local-db`) stays strictly
 * deterministic; this thin presentation layer applies the jitter as a STABLE,
 * seeded shuffle — seeded by the calendar day + each row id — so the order is
 * steady within a session/render (re-renders never reshuffle) yet varies day to
 * day. Never a fresh `Math.random()` per render.
 *
 * Pure + framework-free (no React, no DB) so it is unit-testable.
 */

/**
 * A small, fast deterministic string hash (FNV-1a + a murmur-style finalizer).
 *
 * FNV-1a alone avalanches poorly — consecutive inputs (`…:row-0`, `…:row-1`) map to
 * near-consecutive outputs, which would preserve the input order and defeat the
 * jitter. The finalizer (xor-shift + two odd-constant multiplies) scrambles the
 * low bits so neighboring ids land at unrelated fractions. Returns a fraction in
 * `[0, 1)`.
 */
function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // Murmur3 fmix32 finalizer for a strong avalanche.
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 0x100000000;
}

/** The calendar-day seed (`YYYY-MM-DD`) so the order is stable within a day. */
export function daySeed(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Apply a STABLE jitter to an already-sorted list: each row keeps its sort rank but
 * is nudged by a deterministic per-(day, id) offset so ADJACENT rows can swap
 * (so the user isn't trapped in one topic) while a strong priority gap is preserved.
 *
 * `amount` is the spec's 10–20% band (default `0.15`, its midpoint). The offset is
 * `±amount × NUDGE` ranks, where `NUDGE = 7` makes a 15% jitter reach ~±1 rank —
 * enough for neighbors to exchange day to day (so the user isn't trapped in one
 * topic) but never enough to overtake an item several ranks away (a strong priority
 * gap survives). Stable within a seed (re-renders never reshuffle); varies day to
 * day. Returns a new array; never mutates the input.
 */
const NUDGE = 7;

export function jitterOrder<T extends { id: string }>(
  rows: readonly T[],
  options: { seed?: string; amount?: number } = {},
): T[] {
  const seed = options.seed ?? daySeed();
  const amount = options.amount ?? 0.15;
  return rows
    .map((row, index) => {
      const noise = (hash32(`${seed}:${row.id}`) - 0.5) * 2 * amount * NUDGE;
      return { row, key: index + noise };
    })
    .sort((a, b) => a.key - b.key)
    .map((entry) => entry.row);
}
