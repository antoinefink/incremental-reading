/**
 * Fact lifetime + expiry derivation (T090) — the claim-lifetime model + the PURE,
 * framework-free function that turns it into a `fresh` / `due_for_review` / `expired`
 * status.
 *
 * A "fact" (canonically a `card`, the fact carrier) can carry a LIFETIME: how stable
 * it is ({@link FactStability}), the window it is true ({@link FactLifetime.validFrom}
 * → {@link FactLifetime.validUntil}), the jurisdiction it applies to, the software
 * version it describes, and a `review_by` re-check deadline. From those fields +
 * `now`, {@link deriveExpiryStatus} computes a DERIVED attribute (like `isLeech` /
 * `isRetired`) — NOT a lifecycle status: a card stays `active`/`scheduled` underneath;
 * "expired" is never an `ELEMENT_STATUSES` value.
 *
 * Load-bearing constraints (CLAUDE.md + the T090 spec):
 *  - **Pure, no I/O, no React, no Drizzle, no DB.** Fields in, status out — so it is
 *    trivially testable and reusable by the main side (which computes the status) AND
 *    the renderer (which only renders it). The two sides can never drift.
 *  - **Loose, defensive date handling — never aggressive, never throws.** An
 *    unparseable/empty date is treated as "no constraint" (absent), exactly like the
 *    `source-ref.ts` year guard. A fact with no lifetime never expires (the vast
 *    majority of cards), so the common case is a cheap `fresh`.
 *  - **All fields nullable.** No backfill; an existing row with every field `null`
 *    derives `fresh`.
 *  - **Signal source for T092.** `expired`/`due_for_review` is the signal the T092
 *    verification-task generation consumes — this module exposes the derivation; T090
 *    does NOT generate tasks.
 */

/**
 * How stable a fact is over time — a small, restrained vocabulary that maps cleanly to
 * the kit's labels (and avoids a meaningless free-form numeric half-life):
 *  - `stable`   — durable knowledge (a definition, a theorem) — rarely rots.
 *  - `slow`     — changes over years (a best practice, a population statistic).
 *  - `volatile` — changes fast (a current version, a price, a "latest" claim).
 *
 * Advisory metadata only — it does NOT itself drive {@link deriveExpiryStatus} (the
 * dates do); it documents the user's intent and colors the badge. The closed tuple is
 * the source of truth for the `cards.fact_stability` CHECK (the DB and domain can't
 * drift). `null` = unspecified.
 */
export const FACT_STABILITY = ["stable", "slow", "volatile"] as const;

/** A fact-stability label — one of {@link FACT_STABILITY}. */
export type FactStability = (typeof FACT_STABILITY)[number];

/** Type guard: is `value` one of the {@link FACT_STABILITY} labels? */
export function isFactStability(value: unknown): value is FactStability {
  return typeof value === "string" && (FACT_STABILITY as readonly string[]).includes(value);
}

/**
 * The claim-lifetime fields a fact (a card, canonically) may carry. Every field is
 * nullable — a fact with no lifetime never expires. Stored as-entered (ISO dates
 * preferred) and parsed defensively; this struct is agnostic to which table the
 * fields came from (cards today; an optional `elements` mirror later) so adding the
 * mirror is non-breaking.
 */
export interface FactLifetime {
  /** How stable the fact is (advisory), or `null` = unspecified. */
  readonly factStability: FactStability | null;
  /** ISO date — the start of the fact's validity, or `null`. */
  readonly validFrom: string | null;
  /**
   * ISO date — the END of the fact's validity, or `null`. When `now > validUntil` the
   * fact is {@link FactExpiryStatus} `expired`.
   */
  readonly validUntil: string | null;
  /** Free-text jurisdiction the fact applies to ("US-CA" / "EU" / "global"), or `null`. */
  readonly jurisdiction: string | null;
  /** Free-text software version the fact describes ("React 19" / "Postgres 18"), or `null`. */
  readonly softwareVersion: string | null;
  /**
   * ISO date — the soft re-check deadline. When `now > reviewBy` the fact is
   * `due_for_review` (a softer signal than `expired`), or `null`.
   */
  readonly reviewBy: string | null;
}

/** A {@link FactLifetime} with every field absent — a fact with no lifetime. */
export const EMPTY_FACT_LIFETIME: FactLifetime = {
  factStability: null,
  validFrom: null,
  validUntil: null,
  jurisdiction: null,
  softwareVersion: null,
  reviewBy: null,
};

/**
 * The derived expiry attribute of a fact (NOT a lifecycle status):
 *  - `fresh`          — within its validity window and not past `review_by`.
 *  - `due_for_review` — past its `review_by` deadline (a soft re-check signal).
 *  - `expired`        — past its `valid_until` (the strong, "this is out of date" signal).
 *
 * `expired` dominates `due_for_review` (an out-of-date fact is more urgent than one
 * merely due for a re-check).
 */
export type FactExpiryStatus = "fresh" | "due_for_review" | "expired";

/**
 * Parse a loose date string to epoch ms, or `null` when it is empty/unparseable —
 * the SAME defensive guard pattern as `source-ref.ts`'s `yearOf`. Never throws; an
 * unparseable date is "no constraint", not an error. A bare ISO date (`2025-01-01`)
 * is parsed as UTC midnight so the result does not depend on the host timezone.
 */
function parseDateMs(value: string | null | undefined): number | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  // A bare `YYYY-MM-DD` is interpreted as UTC midnight (host-locale-independent).
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? `${trimmed}T00:00:00Z` : trimmed);
  return Number.isNaN(t) ? null : t;
}

/**
 * Derive a fact's {@link FactExpiryStatus} from its {@link FactLifetime} and `now`.
 * Pure + total: the same inputs always yield the same status, and an
 * unparseable/empty date is treated as absent (no constraint) so it NEVER throws.
 *
 *  - `expired` when `validUntil` parses AND `now > validUntil`;
 *  - else `due_for_review` when `reviewBy` parses AND `now > reviewBy`;
 *  - else `fresh`.
 *
 * `validFrom` is informational (a not-yet-valid fact is still `fresh`, not "expired" —
 * a future window is not staleness); the jurisdiction/version/stability fields are
 * display-only and do not affect the status.
 */
export function deriveExpiryStatus(
  lifetime: FactLifetime | null | undefined,
  now: Date = new Date(),
): FactExpiryStatus {
  if (!lifetime) return "fresh";
  const nowMs = now.getTime();
  const validUntilMs = parseDateMs(lifetime.validUntil);
  if (validUntilMs != null && nowMs > validUntilMs) return "expired";
  const reviewByMs = parseDateMs(lifetime.reviewBy);
  if (reviewByMs != null && nowMs > reviewByMs) return "due_for_review";
  return "fresh";
}

/** True when ANY lifetime field is set — the inspector shows the Expiry section only then. */
export function hasFactLifetime(lifetime: FactLifetime | null | undefined): boolean {
  if (!lifetime) return false;
  return (
    lifetime.factStability != null ||
    (lifetime.validFrom?.trim() ?? "") !== "" ||
    (lifetime.validUntil?.trim() ?? "") !== "" ||
    (lifetime.jurisdiction?.trim() ?? "") !== "" ||
    (lifetime.softwareVersion?.trim() ?? "") !== "" ||
    (lifetime.reviewBy?.trim() ?? "") !== ""
  );
}

/**
 * Map a fact's persisted lifetime → the T086 `SourceRecencySignals` shape so the
 * card-quality `outdated-source` warning and the REAL persisted expiry AGREE (T090 is
 * the deferred half of T086). `sourceIsStale` is `true` once the derived expiry status
 * is NOT `fresh` (expired OR due for review); `sourceDate` prefers the fact's
 * `validFrom` (the explicit "true as of" date) and falls back to the source's
 * published date. Pure + framework-free (returns a plain `{ sourceDate, sourceIsStale }`
 * the caller spreads into the quality input). Defined here (not in `card-quality.ts`)
 * to keep the lifetime → recency mapping with the lifetime model; `card-quality.ts`
 * stays agnostic to WHERE its signals come from.
 */
export function lifetimeToRecencySignals(
  lifetime: FactLifetime | null | undefined,
  now: Date = new Date(),
  sourcePublishedAt: string | null = null,
): { sourceDate: string | null; sourceIsStale: boolean } {
  const status = deriveExpiryStatus(lifetime, now);
  const validFrom = lifetime?.validFrom?.trim();
  return {
    sourceDate: validFrom && validFrom !== "" ? validFrom : (sourcePublishedAt ?? null),
    sourceIsStale: status !== "fresh",
  };
}

/**
 * A short, framework-free UI label for an expiry status ("Expired 2025-01-01" /
 * "Review by 2026-09-01"), or `null` for `fresh` (no banner/badge). The renderer
 * renders this verbatim; the date is the relevant lifetime field shown as-entered
 * (loose, not reformatted — like the refblock's published date).
 */
export function expiryLabel(
  status: FactExpiryStatus,
  lifetime: FactLifetime | null | undefined,
): string | null {
  if (status === "fresh") return null;
  if (status === "expired") {
    const date = lifetime?.validUntil?.trim();
    return date ? `Expired ${date}` : "Expired";
  }
  // due_for_review
  const date = lifetime?.reviewBy?.trim();
  return date ? `Review by ${date}` : "Due for review";
}
