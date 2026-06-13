/**
 * Shape-aware extract staging (T122).
 *
 * This module is deliberately persistence-agnostic: callers provide the text plus
 * reconstruction shape signals, and the pure classifier decides whether the extract
 * can safely skip to `atomic_statement` or must remain a `raw_extract`.
 */

export const EXTRACT_SHAPE_HEURISTIC_VERSION = "extract-shape.v1" as const;

export type ExtractShapeBlockType =
  | "paragraph"
  | "heading"
  | "blockquote"
  | "listItem"
  | "bulletList"
  | "orderedList"
  | "codeBlock"
  | "image"
  | "math"
  | "media"
  | "horizontalRule"
  | "table"
  | "unknown"
  | (string & {});

export type ExtractShapeClassification = "atomic_ready" | "not_atomic_ready";

export type ExtractShapeStage = "atomic_statement" | "raw_extract";

export const EXTRACT_SHAPE_REASON_CODES = [
  "single_atomic_statement",
  "simple_formula",
  "empty_text",
  "too_short",
  "too_long",
  "too_many_chars",
  "multiple_sentences",
  "multiple_paragraphs",
  "multiple_blocks",
  "list_block",
  "code_block",
  "media_block",
  "non_text_block",
  "fallback_used",
  "reconstruction_failed",
  "title_or_heading",
  "dangling_pronoun",
  "fragment",
  "malformed_formula",
  "contextless_formula",
] as const;

export type ExtractShapeReasonCode = (typeof EXTRACT_SHAPE_REASON_CODES)[number];

export interface ExtractShapeInput {
  /** Plain text after caller-side reconstruction/normalization. */
  readonly normalizedText: string;
  /** Number of logical paragraphs in the reconstructed selection. */
  readonly paragraphCount: number;
  /** Number of top-level reconstructed blocks in the selection. */
  readonly blockCount: number;
  /** Top-level block types represented in the selection, in document order. */
  readonly blockTypes: readonly ExtractShapeBlockType[];
  /** True when any selected/reconstructed block is a list or list item. */
  readonly hasList: boolean;
  /** True when any selected/reconstructed block is code. */
  readonly hasCode: boolean;
  /** True when the selection includes a math node or formula-shaped text. */
  readonly hasMath: boolean;
  /** True when the selection includes media or another non-text payload. */
  readonly hasMedia: boolean;
  /** True when the caller reconstructed from rich document structure. */
  readonly rich: boolean;
  /** True when the caller fell back to plain selected text. */
  readonly fallback: boolean;
  /** True when rich reconstruction failed or was incomplete. */
  readonly reconstructionFailed: boolean;
}

export interface ExtractShapeInputSignals {
  readonly hasList: boolean;
  readonly hasCode: boolean;
  readonly hasMath: boolean;
  readonly hasMedia: boolean;
  readonly rich: boolean;
  readonly fallback: boolean;
  readonly reconstructionFailed: boolean;
}

export interface ExtractShapeStats {
  readonly normalizedCharCount: number;
  readonly wordCount: number;
  readonly sentenceCount: number;
  readonly paragraphCount: number;
  readonly blockCount: number;
  readonly blockTypes: readonly ExtractShapeBlockType[];
}

export interface ExtractShapeResult {
  readonly heuristicVersion: typeof EXTRACT_SHAPE_HEURISTIC_VERSION;
  readonly classification: ExtractShapeClassification;
  readonly stage: ExtractShapeStage;
  readonly reasonCodes: readonly ExtractShapeReasonCode[];
  readonly stats: ExtractShapeStats;
  /** Text-free structural signals that explain conservative birth-stage decisions. */
  readonly inputSignals: ExtractShapeInputSignals;
  /**
   * Stable, deterministic hash of the normalized structured input. This is safe
   * for operation-log metadata but is not intended for cryptographic use.
   */
  readonly normalizedInputHash: string;
}

const ATOMIC_MIN_WORDS = 4;
const ATOMIC_MAX_WORDS = 40;
const ATOMIC_MAX_CHARS = 280;

const LIST_BLOCK_TYPES = new Set<string>(["listItem", "bulletList", "orderedList"]);
const CODE_BLOCK_TYPES = new Set<string>(["codeBlock"]);
const MEDIA_BLOCK_TYPES = new Set<string>(["image", "media", "video", "audio", "embed", "iframe"]);
const NON_TEXT_BLOCK_TYPES = new Set<string>(["horizontalRule", "table"]);

const DANGLING_PRONOUN_RE =
  /^(it|this|that|these|those|they|them|he|she|we|its|their|his|her|which)\b/i;

const FINITE_VERB_RE =
  /\b(is|are|was|were|be|being|been|am|has|have|had|does|do|did|can|could|will|would|should|must|may|might|means|mean|equals|equal|defines|define|describes|describe|contains|contain|requires|require|converts|convert|supports|support|strengthens|strengthen|stores|store|transmits|transmit|causes|cause|produces|produce|depends|depend|reduces|reduce|increases|increase|prevents|prevent|forms|form|occurs|occur|belongs|belong|consists|consist)\b/i;

const INFLECTED_VERB_RE = /\b[A-Za-z]{4,}(ates|izes|ises|ifies|ifies|uces|mits|verts|ains)\b/i;

const STANDALONE_FORMULA_RE = /^[A-Za-z0-9πΠσΣλΛθΘμ∞+\-*/^=().,\s_{}[\]]+$/;

export function classifyExtractShape(input: ExtractShapeInput): ExtractShapeResult {
  const normalizedText = normalizeText(input.normalizedText);
  const blockTypes = normalizeBlockTypes(input.blockTypes);
  const inputSignals: ExtractShapeInputSignals = {
    hasList: input.hasList || blockTypes.some((type) => LIST_BLOCK_TYPES.has(type)),
    hasCode: input.hasCode || blockTypes.some((type) => CODE_BLOCK_TYPES.has(type)),
    hasMath: input.hasMath,
    hasMedia: input.hasMedia || blockTypes.some((type) => MEDIA_BLOCK_TYPES.has(type)),
    rich: input.rich,
    fallback: input.fallback,
    reconstructionFailed: input.reconstructionFailed,
  };
  const stats: ExtractShapeStats = {
    normalizedCharCount: normalizedText.length,
    wordCount: countWords(normalizedText),
    sentenceCount: countSentences(normalizedText),
    paragraphCount: normalizeCount(input.paragraphCount),
    blockCount: normalizeCount(input.blockCount),
    blockTypes,
  };
  const normalizedInputHash = hashNormalizedInput(input, normalizedText, blockTypes, stats);
  const reasons: ExtractShapeReasonCode[] = [];

  if (normalizedText.length === 0) reasons.push("empty_text");
  if (inputSignals.fallback) reasons.push("fallback_used");
  if (inputSignals.reconstructionFailed) reasons.push("reconstruction_failed");
  if (inputSignals.hasList) reasons.push("list_block");
  if (inputSignals.hasCode) reasons.push("code_block");
  if (inputSignals.hasMedia) reasons.push("media_block");
  if (blockTypes.some((type) => NON_TEXT_BLOCK_TYPES.has(type))) reasons.push("non_text_block");
  if (blockTypes.includes("heading")) reasons.push("title_or_heading");
  if (stats.paragraphCount !== 1) reasons.push("multiple_paragraphs");
  if (stats.blockCount !== 1) reasons.push("multiple_blocks");
  if (stats.sentenceCount > 1) reasons.push("multiple_sentences");
  if (stats.normalizedCharCount > ATOMIC_MAX_CHARS) reasons.push("too_many_chars");
  if (stats.wordCount > ATOMIC_MAX_WORDS) reasons.push("too_long");

  const formula = analyzeFormula(normalizedText, inputSignals.hasMath);
  if (formula === "simple") {
    return finish(reasons, "simple_formula", stats, inputSignals, normalizedInputHash);
  }
  if (formula === "malformed") reasons.push("malformed_formula");
  if (formula === "contextless") reasons.push("contextless_formula");

  if (stats.wordCount < ATOMIC_MIN_WORDS) reasons.push("too_short");
  if (DANGLING_PRONOUN_RE.test(normalizedText)) reasons.push("dangling_pronoun");
  if (looksLikeFragment(normalizedText)) reasons.push("fragment");

  return finish(reasons, "single_atomic_statement", stats, inputSignals, normalizedInputHash);
}

function finish(
  reasons: readonly ExtractShapeReasonCode[],
  successReason: ExtractShapeReasonCode,
  stats: ExtractShapeStats,
  inputSignals: ExtractShapeInputSignals,
  normalizedInputHash: string,
): ExtractShapeResult {
  const uniqueReasons = [...new Set(reasons)];
  const isAtomic = uniqueReasons.length === 0;

  return {
    heuristicVersion: EXTRACT_SHAPE_HEURISTIC_VERSION,
    classification: isAtomic ? "atomic_ready" : "not_atomic_ready",
    stage: isAtomic ? "atomic_statement" : "raw_extract",
    reasonCodes: isAtomic ? [successReason] : uniqueReasons,
    stats,
    inputSignals,
    normalizedInputHash,
  };
}

function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeBlockTypes(
  blockTypes: readonly ExtractShapeBlockType[],
): readonly ExtractShapeBlockType[] {
  return blockTypes.map((type) => String(type).trim()).filter(Boolean) as ExtractShapeBlockType[];
}

function normalizeCount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function countWords(text: string): number {
  return text.match(/[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)*/g)?.length ?? 0;
}

function countSentences(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;

  const masked = trimmed
    .replace(/\b(?:e\.g|i\.e)\./gi, (match) => match.replace(/\./g, "<DOT>"))
    .replace(/\b(?:Dr|Mr|Mrs|Ms|Prof|Sr|Jr|St|vs|etc|Fig|Eq|No)\./gi, (match) =>
      match.replace(/\./g, "<DOT>"),
    )
    .replace(/(\d)\.(\d)/g, "$1<DOT>$2");

  return masked.match(/[.!?]+(?=\s|$)/g)?.length ?? 1;
}

function analyzeFormula(
  text: string,
  hasMath: boolean,
): "simple" | "malformed" | "contextless" | "not_formula" {
  const formulaText = stripMathDelimiters(text.replace(/[.!?]$/, "").trim());
  const formulaish = formulaText.includes("=") || hasMath;

  if (!formulaish) return "not_formula";
  if (!formulaText.includes("=")) return "malformed";
  if (!STANDALONE_FORMULA_RE.test(formulaText)) return "not_formula";

  const parts = formulaText.split("=");
  if (parts.length !== 2) return "malformed";

  const [left = "", right = ""] = parts.map((part) => part.trim());
  if (!left || !right) return "malformed";
  if (!isBalancedFormula(left) || !isBalancedFormula(right)) return "malformed";
  if (/[+\-*/^=]$/.test(left) || /^[+\-*/^=]/.test(right) || /[+\-*/^=]$/.test(right)) {
    return "malformed";
  }

  const leftHasSymbol = /[A-Za-zπΠσΣλΛθΘμ]/.test(left);
  const rightHasSymbol = /[A-Za-zπΠσΣλΛθΘμ]/.test(right);
  if (!leftHasSymbol || !rightHasSymbol) return "malformed";

  const rightHasStructure = /[\d^*/+\-()]|[A-Za-z]{2,}/.test(right);
  const bothSidesGenericSingles = /^[a-z]$/.test(left) && /^[a-z]$/.test(right);
  if (!rightHasStructure || bothSidesGenericSingles) return "contextless";

  return "simple";
}

function stripMathDelimiters(text: string): string {
  if (text.startsWith("$$") && text.endsWith("$$") && text.length > 4) {
    return text.slice(2, -2).trim();
  }
  if (text.startsWith("$") && text.endsWith("$") && text.length > 2) {
    return text.slice(1, -1).trim();
  }
  return text;
}

function isBalancedFormula(text: string): boolean {
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const stack: string[] = [];

  for (const char of text) {
    if (pairs[char]) {
      stack.push(pairs[char]);
    } else if ((char === ")" || char === "]" || char === "}") && stack.pop() !== char) {
      return false;
    }
  }

  return stack.length === 0;
}

function looksLikeFragment(text: string): boolean {
  if (!text) return true;
  if (/[,;:–-]\s*$/.test(text)) return true;
  if (/^[a-z]/.test(text)) return true;
  if (!hasFiniteVerb(text)) return true;

  return false;
}

function hasFiniteVerb(text: string): boolean {
  return FINITE_VERB_RE.test(text) || INFLECTED_VERB_RE.test(text);
}

function hashNormalizedInput(
  input: ExtractShapeInput,
  normalizedText: string,
  blockTypes: readonly ExtractShapeBlockType[],
  stats: ExtractShapeStats,
): string {
  const canonical = JSON.stringify({
    normalizedText,
    paragraphCount: stats.paragraphCount,
    blockCount: stats.blockCount,
    blockTypes,
    hasList: input.hasList,
    hasCode: input.hasCode,
    hasMath: input.hasMath,
    hasMedia: input.hasMedia,
    rich: input.rich,
    fallback: input.fallback,
    reconstructionFailed: input.reconstructionFailed,
  });

  return `fnv1a32:${fnv1a32(canonical)}`;
}

function fnv1a32(value: string): string {
  let hash = 0x811c9dc5;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return (hash >>> 0).toString(16).padStart(8, "0");
}
