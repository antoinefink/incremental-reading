/**
 * Date arithmetic for the attention scheduler (T028) — the SINGLE source of truth.
 *
 * Before T028 the same `addDays` helper was copy-pasted into `extract-service.ts`
 * and `extraction-service.ts` in `packages/local-db`. Both copies are now deleted;
 * those services import {@link addDays} from here, so there is exactly ONE
 * implementation of "add N days to an ISO timestamp" in the codebase.
 *
 * Pure + framework-agnostic (no Drizzle/React/Node-only APIs) so the Vitest suite
 * can drive it from a fixed injected clock — the scheduler never calls
 * `Date.now()` deep inside its math (see `attention-scheduler.ts`).
 */

import type { IsoTimestamp } from "@interleave/core";

/** Milliseconds in one calendar day (UTC, no DST handling — deliberate for MVP). */
export const MS_PER_DAY = 86_400_000;

/**
 * Add `days` (may be fractional or negative) to an ISO-8601 timestamp, returning a
 * new ISO-8601 timestamp. The canonical, deduplicated implementation the local-db
 * services and the attention scheduler share.
 */
export function addDays(fromIso: IsoTimestamp, days: number): IsoTimestamp {
  const base = Date.parse(fromIso);
  if (Number.isNaN(base)) {
    throw new Error(`addDays: invalid ISO timestamp "${fromIso}"`);
  }
  return new Date(base + days * MS_PER_DAY).toISOString() as IsoTimestamp;
}
