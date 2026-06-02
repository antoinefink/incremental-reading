/**
 * Source reference (the `refblock`) — the framework-agnostic citation model (T043).
 *
 * Every extract and card consistently shows WHERE it came from: the originating
 * source title / URL / author / published date / location, plus the verbatim
 * source snippet. This module is the SINGLE source of truth for how a reference
 * READS — the citation line, the location label, the openable href — so review,
 * the extract view, the inspector, and the library result rows all agree.
 *
 * It is deliberately framework-free (no React, no Drizzle, no Electron): the main
 * process assembles the {@link SourceRef} from the persisted lineage
 * (`card → source location → source` / `extract → source`) and the renderer's
 * `RefBlock` component renders {@link formatSourceRef}. T043 adds presentation +
 * the missing provenance fields, NOT a new lineage model.
 *
 * No remote fetching — provenance is whatever was captured at import (T014).
 * `publishedAt` is a loose date string stored as-is; the formatter shows the year
 * when it parses and otherwise leaves the value untouched (it does not aggressively
 * reformat). Richer citation styles + source-reliability metadata are M18/T091.
 */

/**
 * Source-reliability vocabulary (T091) — three small ordinal enums the user assigns
 * to a `source` to record HOW TRUSTWORTHY it is. Ordinal enums (not free-form 0–1
 * floats) are deliberate: they map cleanly to the kit's restrained labels + the badge
 * colors, and the closed tuples are the single source of truth for the matching
 * `sources` CHECK constraints (the DB + the domain union can never drift). All three
 * are nullable on a source — a source with no reliability data renders exactly as
 * before (no badge), no backfill.
 */

/**
 * What KIND of source this is — display + a loose reliability prior. Free-form
 * classification (e.g. AI auto-tagging) is out of scope (T093+); this is user-entered.
 */
export const SOURCE_TYPES = [
  "paper",
  "book",
  "article",
  "docs",
  "reference",
  "blog",
  "forum",
  "video",
  "dataset",
  "personal_note",
  "other",
] as const;

/** A source type — one of {@link SOURCE_TYPES}. */
export type SourceType = (typeof SOURCE_TYPES)[number];

/**
 * The source's TIER in the primary/secondary/tertiary scholarship sense:
 *  - `primary`   — original/first-hand (a paper, a dataset, a spec).
 *  - `secondary` — analysis/synthesis of primaries (a review article, a textbook).
 *  - `tertiary`  — digests/aggregations (an encyclopedia, a blog summary).
 */
export const RELIABILITY_TIERS = ["primary", "secondary", "tertiary"] as const;

/** A reliability tier — one of {@link RELIABILITY_TIERS}. */
export type ReliabilityTier = (typeof RELIABILITY_TIERS)[number];

/** The user's CONFIDENCE in the source — an ordinal trust level. */
export const CONFIDENCE_LEVELS = ["high", "medium", "low"] as const;

/** A confidence level — one of {@link CONFIDENCE_LEVELS}. */
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

/** Type guard: is `value` one of the {@link SOURCE_TYPES}? */
export function isSourceType(value: unknown): value is SourceType {
  return typeof value === "string" && (SOURCE_TYPES as readonly string[]).includes(value);
}

/** Type guard: is `value` one of the {@link RELIABILITY_TIERS}? */
export function isReliabilityTier(value: unknown): value is ReliabilityTier {
  return typeof value === "string" && (RELIABILITY_TIERS as readonly string[]).includes(value);
}

/** Type guard: is `value` one of the {@link CONFIDENCE_LEVELS}? */
export function isConfidenceLevel(value: unknown): value is ConfidenceLevel {
  return typeof value === "string" && (CONFIDENCE_LEVELS as readonly string[]).includes(value);
}

/**
 * A resolved reference to the origin of an extract/card, assembled main-side from
 * the persisted `sources` provenance row + the `source_locations` anchor. Every
 * field is nullable because manual imports may omit provenance and a (rare)
 * source-less element must degrade gracefully (a calm "source unavailable" line,
 * never a broken link).
 */
export interface SourceRef {
  /** The owning `source` element's id (the reader to open on "jump to source"). */
  readonly sourceElementId: string | null;
  /** The source title (provenance), or `null` when the source is gone/unknown. */
  readonly sourceTitle: string | null;
  /** The as-entered URL, when the source came from the web. */
  readonly url: string | null;
  /** The source author, when known. */
  readonly author: string | null;
  /** A loose published-date string stored as-is at import (NOT reformatted). */
  readonly publishedAt: string | null;
  /** The human-readable source location ("Definition · ¶ 4" / "p. 12"), or `null`. */
  readonly locationLabel: string | null;
  /** A verbatim snapshot of the originating text (the `refblock` quote), or `null`. */
  readonly snippet: string | null;
  /** The source's kind (T091 — `paper`/`book`/…), or `null` when unspecified. */
  readonly sourceType: SourceType | null;
  /** The source's tier (T091 — `primary`/`secondary`/`tertiary`), or `null`. */
  readonly reliabilityTier: ReliabilityTier | null;
  /** The user's confidence in the source (T091 — `high`/`medium`/`low`), or `null`. */
  readonly confidence: ConfidenceLevel | null;
  /** Free-text reliability caveats / known biases (T091), or `null`. */
  readonly reliabilityNotes: string | null;
}

/** A {@link SourceRef} whose source could not be resolved (the calm orphan case). */
export const EMPTY_SOURCE_REF: SourceRef = {
  sourceElementId: null,
  sourceTitle: null,
  url: null,
  author: null,
  publishedAt: null,
  locationLabel: null,
  snippet: null,
  sourceType: null,
  reliabilityTier: null,
  confidence: null,
  reliabilityNotes: null,
};

/**
 * The presentation-ready pieces a `RefBlock` renders. `citation` is the single
 * "Author. Title (Year)." line (omitting any missing part cleanly); `locationLabel`
 * is the spot inside the source; `href` is a usable link target derived from the
 * URL, or `null` when there is none. `hasSource` distinguishes a resolved
 * reference from the orphan placeholder so the renderer can show a calm
 * "source unavailable" line instead of a broken link.
 */
export interface FormattedSourceRef {
  /** The assembled citation line ("François Chollet. On the Measure… (2019)."), or "". */
  readonly citation: string;
  /** The source location label, or `null`. */
  readonly locationLabel: string | null;
  /** A usable href derived from the URL, or `null`. */
  readonly href: string | null;
  /** The verbatim source snippet (the quote), or `null`. */
  readonly snippet: string | null;
  /** False when nothing about the source could be resolved (the orphan case). */
  readonly hasSource: boolean;
  /**
   * A presentation-ready reliability summary (T091), or `null` when the source carries
   * NO reliability metadata (no badge — the unchanged pre-T091 render). When present it
   * gives the renderer everything for the badge + uncertainty note WITHOUT re-deriving:
   * the raw `tier`/`confidence`/`sourceType`, a calm `label`
   * ("Primary source · high confidence"), the free-text `notes`, and `hasUncertainty`
   * (true for `low` confidence OR a present notes string — the badge tints + the note
   * shows). All framework-free; the `RefBlock` only renders it.
   */
  readonly reliability: ReliabilitySummary | null;
}

/** The presentation-ready reliability badge + uncertainty note (T091). */
export interface ReliabilitySummary {
  /** The source tier, or `null`. */
  readonly tier: ReliabilityTier | null;
  /** The confidence level, or `null`. */
  readonly confidence: ConfidenceLevel | null;
  /** The source type, or `null`. */
  readonly sourceType: SourceType | null;
  /** The calm one-line badge label, e.g. "Primary source · high confidence". */
  readonly label: string;
  /** The free-text reliability/uncertainty note, or `null`. */
  readonly notes: string | null;
  /** True for low confidence OR a present notes string — surfaces the uncertainty cue. */
  readonly hasUncertainty: boolean;
}

/** Extract a 4-digit year from a loose date string, when one parses; else `null`. */
function yearOf(publishedAt: string | null): string | null {
  if (!publishedAt) return null;
  const trimmed = publishedAt.trim();
  if (trimmed === "") return null;
  // A leading ISO/RFC year (e.g. "2019-11-05…" or "2019") is the common case and
  // does not depend on the host locale/timezone.
  const leading = trimmed.match(/^(\d{4})\b/);
  if (leading) return leading[1] ?? null;
  // Otherwise fall back to Date parsing for human-entered dates ("Nov 5, 2019").
  const t = Date.parse(trimmed);
  if (Number.isNaN(t)) {
    // Last resort: any 4-digit run that looks like a year (1000–2999).
    const any = trimmed.match(/\b([12]\d{3})\b/);
    return any ? (any[1] ?? null) : null;
  }
  return String(new Date(t).getUTCFullYear());
}

/** Trim a string to a non-empty value, or `null`. */
function clean(value: string | null | undefined): string | null {
  if (value == null) return null;
  const t = value.trim();
  return t === "" ? null : t;
}

/**
 * Derive a usable href from a reference's URL. Returns the as-entered URL when it
 * already carries a scheme, prefixes a bare `host/path` with `https://`, and
 * returns `null` for an empty/unusable value — never throwing, so a malformed URL
 * degrades to "no link" rather than an error.
 */
function hrefOf(url: string | null): string | null {
  const u = clean(url);
  if (!u) return null;
  // Already absolute (http/https/file/…): use verbatim.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u) || /^mailto:/i.test(u)) return u;
  // A scheme-less host (e.g. "example.com/x"): assume https.
  if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(u)) return `https://${u}`;
  return null;
}

/** Human labels for a source tier (the badge's leading phrase). */
const TIER_LABEL: Record<ReliabilityTier, string> = {
  primary: "Primary source",
  secondary: "Secondary source",
  tertiary: "Tertiary source",
};

/** Human labels for a source type (the badge's leading phrase when no tier is set). */
const SOURCE_TYPE_LABEL: Record<SourceType, string> = {
  paper: "Paper",
  book: "Book",
  article: "Article",
  docs: "Docs",
  reference: "Reference",
  blog: "Blog",
  forum: "Forum",
  video: "Video",
  dataset: "Dataset",
  personal_note: "Personal note",
  other: "Source",
};

/**
 * Assemble the presentation-ready {@link ReliabilitySummary} from the raw reliability
 * fields, or `null` when ALL of them are absent (no badge — the unchanged render). The
 * `label` reads calmly: the tier (or the source type when there is no tier) leads, the
 * confidence follows ("Primary source · high confidence"); a low confidence / a notes
 * string sets `hasUncertainty` so the badge tints + the note shows. Framework-free.
 */
function summarizeReliability(
  sourceType: SourceType | null,
  tier: ReliabilityTier | null,
  confidence: ConfidenceLevel | null,
  notesRaw: string | null,
): ReliabilitySummary | null {
  const type = isSourceType(sourceType) ? sourceType : null;
  const reliabilityTier = isReliabilityTier(tier) ? tier : null;
  const conf = isConfidenceLevel(confidence) ? confidence : null;
  const notes = clean(notesRaw);
  // No reliability metadata at all → no badge (the pre-T091 render is unchanged).
  if (!type && !reliabilityTier && !conf && !notes) return null;

  const parts: string[] = [];
  // The tier leads; if no tier, the source type leads instead; else nothing leads.
  if (reliabilityTier) parts.push(TIER_LABEL[reliabilityTier]);
  else if (type) parts.push(SOURCE_TYPE_LABEL[type]);
  if (conf) parts.push(`${conf} confidence`);
  // If only notes are set (no type/tier/confidence), label the badge "Source notes".
  const label = parts.length > 0 ? parts.join(" · ") : "Source notes";
  // Low confidence OR a caveat note is an uncertainty cue.
  const hasUncertainty = conf === "low" || notes != null;

  return {
    tier: reliabilityTier,
    confidence: conf,
    sourceType: type,
    label,
    notes,
    hasUncertainty,
  };
}

/**
 * Assemble the presentation-ready {@link FormattedSourceRef} from a {@link SourceRef}.
 * Pure + framework-free: the citation omits missing parts cleanly, the year is
 * appended only when it parses, and the href is `null` when there is no usable URL.
 * When nothing about the source resolves, `hasSource` is `false` so the renderer
 * shows a calm placeholder instead of a broken reference. The T091 reliability summary
 * is `null` when the source carries no reliability metadata (no badge).
 */
export function formatSourceRef(ref: SourceRef | null | undefined): FormattedSourceRef {
  const r = ref ?? EMPTY_SOURCE_REF;
  const author = clean(r.author);
  const title = clean(r.sourceTitle);
  const year = yearOf(r.publishedAt);
  const href = hrefOf(r.url);
  const locationLabel = clean(r.locationLabel);
  const snippet = clean(r.snippet);
  const reliability = summarizeReliability(
    r.sourceType,
    r.reliabilityTier,
    r.confidence,
    r.reliabilityNotes,
  );

  // "Author. Title (Year)." — each piece appears only when present.
  const parts: string[] = [];
  if (author) parts.push(author);
  if (title) parts.push(year ? `${title} (${year})` : title);
  else if (year) parts.push(`(${year})`);
  const citation = parts.join(". ");

  const hasSource =
    author != null ||
    title != null ||
    year != null ||
    href != null ||
    locationLabel != null ||
    snippet != null ||
    reliability != null ||
    clean(r.sourceElementId) != null;

  return { citation, locationLabel, href, snippet, hasSource, reliability };
}
