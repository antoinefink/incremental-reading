/**
 * Cloze parsing / serialization (T034).
 *
 * A **cloze** card hides one or more answer spans inside a sentence and asks the
 * user to recall them. The canonical, persisted form is the Anki-style **numbered**
 * marker `{{c1::answer}}` (stored in `cards.cloze`) — numbering makes a multi-cloze
 * card unambiguous and lets siblings (same number revealed together) be grouped.
 *
 * This module is the **structured-metadata source of truth** the M6 spec calls for:
 * `cards.cloze` (the canonical numbered text) is the single persisted field, and the
 * structured model (deletion count + ordered `c1..cN` index → answer spans) is
 * derived deterministically from it by {@link parseCloze}. That avoids a new DB
 * column / migration and keeps the text editable. The cloze deletion spans are ALSO
 * persisted as `cloze` `document_marks` on the card body (the renderer wires that via
 * the existing `documents.marks.add` surface), but those marks are derived from this
 * same parse — this is the authority.
 *
 * It is framework-agnostic (no React, no DB) so the parser + serializer + preview
 * helper are unit-testable in isolation and reusable by the renderer, the card-quality
 * heuristics (T035 reads `clozeCount`), and later analytics.
 *
 * ## Input dialects (both accepted; output is always canonical)
 *
 * - **Numbered** `{{c1::answer}}` / `{{c2::answer}}` — the canonical form.
 * - **Bare** `{{answer}}` — the design-kit prototype's simple form. On parse these
 *   are AUTO-NUMBERED left-to-right into fresh sequential indices, so the kit's
 *   `{{a}} {{b}}` becomes `c1`/`c2` and {@link serializeCloze} round-trips to the
 *   canonical numbered text. Numbered and bare markers may be mixed: explicit
 *   numbers are honoured; bare markers fill the next unused index.
 */

/** The canonical numbered cloze marker, e.g. `{{c1::skill-acquisition efficiency}}`. */
const NUMBERED_MARKER = /\{\{c(\d+)::([\s\S]*?)\}\}/;
/** The bare cloze marker (no number), e.g. `{{the hippocampus}}`. */
const BARE_MARKER = /\{\{([\s\S]*?)\}\}/;
/** Splits text into literal segments and cloze markers (numbered OR bare), in order. */
const SPLIT_MARKERS = /(\{\{c\d+::[\s\S]*?\}\}|\{\{[\s\S]*?\}\})/g;

/** One parsed cloze deletion. */
export interface ClozeDeletion {
  /** The 1-based cloze index (`c1` → `1`). Multiple deletions can share an index. */
  readonly index: number;
  /** The answer text inside the marker (whitespace-trimmed). */
  readonly answer: string;
  /** Character offset where the deletion's answer begins in the RENDERED prompt text. */
  readonly start: number;
  /** Character offset where the deletion's answer ends in the RENDERED prompt text. */
  readonly end: number;
}

/** The structured cloze model derived from canonical `{{c1::answer}}` text. */
export interface ParsedCloze {
  /** The canonical numbered text the model serializes back to. */
  readonly raw: string;
  /**
   * The prompt text with every marker replaced by its answer (answers inline).
   * Deletion `start`/`end` offsets index into THIS string, so a card body seeded
   * from `rendered` can anchor `cloze` document_marks at those exact ranges.
   */
  readonly rendered: string;
  /** Every deletion, in document order (a grouped index appears once per occurrence). */
  readonly deletions: readonly ClozeDeletion[];
  /** The number of DISTINCT cloze indices (grouped `c1` repeats count once). */
  readonly clozeCount: number;
}

/** The placeholder shown for a hidden deletion in the preview, matching the kit. */
export const CLOZE_PLACEHOLDER = "[ … ]" as const;

/** True when `text` contains at least one (numbered or bare) cloze marker. */
export function hasClozeMarker(text: string): boolean {
  // Use the NON-global single-marker patterns: a global regex carries `lastIndex`
  // state across `.test()` calls, which would make repeated checks flaky.
  return NUMBERED_MARKER.test(text) || BARE_MARKER.test(text);
}

/**
 * Parse cloze text into the structured model AND its canonical numbered form.
 *
 * Numbered markers keep their explicit index; bare markers are auto-numbered into
 * the next unused index (left-to-right). Offsets are computed against the RENDERED
 * prompt text (markers replaced by their answer), so they line up with what the
 * reader/preview shows and with the `document_marks` ranges the card body stores.
 * Malformed/empty markers (`{{}}`, `{{   }}`) are dropped — they carry no answer.
 */
export function parseCloze(text: string): ParsedCloze {
  const segments = text.split(SPLIT_MARKERS);
  const deletions: ClozeDeletion[] = [];
  const used = new Set<number>();
  // Track the highest explicit index so auto-numbered bare markers never collide.
  let maxSeen = 0;
  for (const seg of segments) {
    const numbered = seg.match(/^\{\{c(\d+)::([\s\S]*?)\}\}$/);
    if (numbered) maxSeen = Math.max(maxSeen, Number.parseInt(numbered[1] ?? "0", 10));
  }

  let rendered = "";
  let nextAuto = 1;
  for (const seg of segments) {
    if (seg.length === 0) continue;
    const numbered = seg.match(/^\{\{c(\d+)::([\s\S]*?)\}\}$/);
    const bare = numbered ? null : seg.match(/^\{\{([\s\S]*?)\}\}$/);
    if (numbered) {
      const index = Number.parseInt(numbered[1] ?? "0", 10);
      const answer = (numbered[2] ?? "").trim();
      if (index <= 0 || answer.length === 0) continue;
      const start = rendered.length;
      rendered += answer;
      deletions.push({ index, answer, start, end: rendered.length });
      used.add(index);
    } else if (bare) {
      const answer = (bare[1] ?? "").trim();
      if (answer.length === 0) continue;
      // Assign the next unused index above any explicit number already present.
      while (used.has(nextAuto) || nextAuto <= maxSeen) nextAuto += 1;
      const index = nextAuto;
      const start = rendered.length;
      rendered += answer;
      deletions.push({ index, answer, start, end: rendered.length });
      used.add(index);
    } else {
      // Literal text segment (including a malformed/empty marker we skip above).
      rendered += seg;
    }
  }

  const raw = serializeFromDeletionsAndSegments(segments);
  return { raw, rendered, deletions, clozeCount: used.size };
}

/**
 * Re-emit canonical numbered text from the original split segments, replacing every
 * marker (numbered or bare) with its canonical `{{cN::answer}}` form and dropping
 * empty markers. Bare markers are auto-numbered consistently with {@link parseCloze}.
 */
function serializeFromDeletionsAndSegments(segments: readonly string[]): string {
  const used = new Set<number>();
  let maxSeen = 0;
  for (const seg of segments) {
    const numbered = seg.match(/^\{\{c(\d+)::([\s\S]*?)\}\}$/);
    if (numbered) maxSeen = Math.max(maxSeen, Number.parseInt(numbered[1] ?? "0", 10));
  }
  let nextAuto = 1;
  let out = "";
  for (const seg of segments) {
    if (seg.length === 0) continue;
    const numbered = seg.match(/^\{\{c(\d+)::([\s\S]*?)\}\}$/);
    const bare = numbered ? null : seg.match(/^\{\{([\s\S]*?)\}\}$/);
    if (numbered) {
      const index = Number.parseInt(numbered[1] ?? "0", 10);
      const answer = (numbered[2] ?? "").trim();
      if (index <= 0 || answer.length === 0) continue;
      out += `{{c${index}::${answer}}}`;
      used.add(index);
    } else if (bare) {
      const answer = (bare[1] ?? "").trim();
      if (answer.length === 0) continue;
      while (used.has(nextAuto) || nextAuto <= maxSeen) nextAuto += 1;
      out += `{{c${nextAuto}::${answer}}}`;
      used.add(nextAuto);
    } else {
      out += seg;
    }
  }
  return out;
}

/**
 * Serialize a parsed model back to canonical numbered text. The model's `raw` is
 * already canonical (parse normalizes), so this returns it — exposed as the public
 * inverse of {@link parseCloze} for callers that hold a {@link ParsedCloze}.
 */
export function serializeCloze(model: ParsedCloze): string {
  return model.raw;
}

/**
 * Normalize any accepted cloze dialect to canonical numbered text in one step
 * (parse + serialize). Used main-side / by the renderer before persisting so
 * `cards.cloze` is always `{{c1::…}}` form.
 */
export function canonicalizeCloze(text: string): string {
  return parseCloze(text).raw;
}

/** One span of the rendered cloze prompt — literal text or a (hidden/revealed) deletion. */
export interface ClozeSpan {
  /** `text` for literal copy; `deletion` for a `{{cN::…}}` span. */
  readonly kind: "text" | "deletion";
  /** Literal text, the answer (when revealed), or the placeholder (when hidden). */
  readonly content: string;
  /** The cloze index for a `deletion` span; `null` for literal text. */
  readonly index: number | null;
  /** Whether this deletion is shown as its answer (`true`) or the placeholder (`false`). */
  readonly revealed: boolean;
}

/** Options for {@link renderClozePrompt}. */
export interface RenderClozeOptions {
  /**
   * Reveal a SINGLE deletion index (its answer is shown; all others stay hidden) —
   * the per-card front when that index is the one being tested. Omit to keep all
   * deletions hidden.
   */
  readonly revealIndex?: number;
  /** Reveal ALL deletions at once (the preview's "reveal answers" toggle). */
  readonly revealAll?: boolean;
}

/**
 * Render cloze text into ordered spans the preview/reader draws. Each `{{cN::…}}`
 * becomes a `deletion` span shown either as its answer (when revealed) or the
 * `[ … ]` placeholder; literal text is passed through verbatim. This is the helper
 * the {@link ParsedCloze}-driven UI uses instead of ad-hoc regex in the component.
 */
export function renderClozePrompt(text: string, options: RenderClozeOptions = {}): ClozeSpan[] {
  const segments = text.split(SPLIT_MARKERS);
  const used = new Set<number>();
  let maxSeen = 0;
  for (const seg of segments) {
    const numbered = seg.match(/^\{\{c(\d+)::([\s\S]*?)\}\}$/);
    if (numbered) maxSeen = Math.max(maxSeen, Number.parseInt(numbered[1] ?? "0", 10));
  }
  let nextAuto = 1;
  const spans: ClozeSpan[] = [];
  for (const seg of segments) {
    if (seg.length === 0) continue;
    const numbered = seg.match(/^\{\{c(\d+)::([\s\S]*?)\}\}$/);
    const bare = numbered ? null : seg.match(/^\{\{([\s\S]*?)\}\}$/);
    if (numbered || bare) {
      let index: number;
      let answer: string;
      if (numbered) {
        index = Number.parseInt(numbered[1] ?? "0", 10);
        answer = (numbered[2] ?? "").trim();
      } else {
        answer = (bare?.[1] ?? "").trim();
        while (used.has(nextAuto) || nextAuto <= maxSeen) nextAuto += 1;
        index = nextAuto;
      }
      if (index <= 0 || answer.length === 0) {
        // Malformed/empty marker — render as literal so nothing silently vanishes.
        spans.push({ kind: "text", content: seg, index: null, revealed: false });
        continue;
      }
      used.add(index);
      const revealed = options.revealAll === true || options.revealIndex === index;
      spans.push({
        kind: "deletion",
        content: revealed ? answer : CLOZE_PLACEHOLDER,
        index,
        revealed,
      });
    } else {
      spans.push({ kind: "text", content: seg, index: null, revealed: false });
    }
  }
  return spans;
}
