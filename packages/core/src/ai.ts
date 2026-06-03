/**
 * AI-assisted distillation domain contract (T093).
 *
 * The framework-agnostic shapes for the on-device AI _formulation_ layer: the seven
 * actions a user can run over a selected source span (explain / simplify / suggest
 * Q&A / suggest cloze / detect ambiguity / propose prerequisites / summarize), the
 * provider-agnostic seam every concrete provider implements ({@link AiProvider}), the
 * request/suggestion shapes that cross the worker boundary, and the typed errors.
 *
 * This module is intentionally dependency-free — no `fs`, no Electron, no SQLite, no
 * `@interleave/db` (like `job.ts` / `source-ref.ts`). The concrete providers (the
 * local model, the user's own-key HTTP call, the managed proxy) live main/worker-side
 * and import THIS contract; tests inject a `FakeAiProvider` that returns a canned
 * {@link AiSuggestion} — never a live model or network call.
 *
 * ## Why a single `complete(request)` seam (the provider abstraction, justified)
 *
 * One narrow `complete(request)` interface keeps the local-model / own-key /
 * managed-proxy choice SWAPPABLE, keeps the call site (the `ai` worker dispatch)
 * provider-agnostic, and makes the provider TRIVIALLY MOCKABLE in tests (a
 * `FakeAiProvider` returns a fixed suggestion — no model, no network). This is the
 * same "inject the heavy capability behind a narrow interface" discipline the runner's
 * `WorkerForkFactory` and the embedding worker's model loader already use.
 *
 * ## Invariants this contract encodes
 *
 * - AI output is ALWAYS a DRAFT. An {@link AiSuggestion} is inert text + (for the
 *   card-shaped actions) structured {@link DraftCard}s. Nothing here schedules a card,
 *   activates an element, or touches FSRS — the approve-to-card step (main-side) mints
 *   a PARKED, un-due `card_draft` only on the user's explicit approval.
 * - GROUNDING is separate from the model's output (T094). The verbatim source span
 *   (`sourceText`) the action ran over is carried distinct from the generated `text`,
 *   so we always know "the model said X _about_ this exact source text".
 * - The provider is OFF BY DEFAULT. `selectProvider(settings)` throws
 *   {@link AiDisabledError} when AI is disabled; an unavailable local model / managed
 *   proxy throws {@link AiProviderError} / {@link AiProxyUnavailableError} so the
 *   surface degrades to a calm disabled state, never a crash.
 *
 * This module stays dependency-free (no `zod`/`fs`/Electron/SQLite). The Zod schema
 * MIRRORS used for IPC + worker-payload validation live in the contract layer
 * (`apps/desktop/src/shared/contract.ts`), built from the closed tuples + bounds
 * exported here — so the validation and the domain union can never drift.
 */

/**
 * The seven AI formulation actions a user can run over a selected span. Each maps to
 * a prompt template + a suggestion {@link AiSuggestionKind} the worker produces:
 *  - `explain` / `simplify` / `summarize` → `text` (copy-or-insert only, no card);
 *  - `suggest_qa` → `card_qa` (a Q&A {@link DraftCard});
 *  - `suggest_cloze` → `card_cloze` (a cloze {@link DraftCard});
 *  - `detect_ambiguity` → `text` (a critique of ambiguous wording);
 *  - `propose_prerequisites` → `prerequisite_list` (prerequisite concepts to learn first).
 */
export const AI_ACTION_TYPES = [
  "explain",
  "simplify",
  "suggest_qa",
  "suggest_cloze",
  "detect_ambiguity",
  "propose_prerequisites",
  "summarize",
] as const;

/** One AI formulation action — one of {@link AI_ACTION_TYPES}. */
export type AiActionType = (typeof AI_ACTION_TYPES)[number];

/** Type guard: is `value` one of the {@link AI_ACTION_TYPES}? */
export function isAiActionType(value: unknown): value is AiActionType {
  return typeof value === "string" && (AI_ACTION_TYPES as readonly string[]).includes(value);
}

/**
 * Which provider runs the model. `local` runs the bundled/downloaded on-device model
 * in the DB-free worker; `anthropic`/`openai` call the user's OWN key endpoint from
 * the worker; `managed_proxy` is the OFF-by-default first-party route (disclosed).
 */
export const AI_PROVIDER_KINDS = ["local", "anthropic", "openai", "managed_proxy"] as const;

/** An AI provider kind — one of {@link AI_PROVIDER_KINDS}. */
export type AiProviderKind = (typeof AI_PROVIDER_KINDS)[number];

/** Type guard: is `value` one of the {@link AI_PROVIDER_KINDS}? */
export function isAiProviderKind(value: unknown): value is AiProviderKind {
  return typeof value === "string" && (AI_PROVIDER_KINDS as readonly string[]).includes(value);
}

/** The shape of a model-produced suggestion. */
export const AI_SUGGESTION_KINDS = ["text", "card_qa", "card_cloze", "prerequisite_list"] as const;

/** A suggestion kind — one of {@link AI_SUGGESTION_KINDS}. */
export type AiSuggestionKind = (typeof AI_SUGGESTION_KINDS)[number];

/** The persisted lifecycle of an `ai_suggestions` row. */
export const AI_SUGGESTION_STATUSES = ["draft", "approved", "dismissed"] as const;

/** A suggestion status — one of {@link AI_SUGGESTION_STATUSES}. */
export type AiSuggestionStatus = (typeof AI_SUGGESTION_STATUSES)[number];

/**
 * A structured card draft a card-shaped action ({@link AiActionType} `suggest_qa` /
 * `suggest_cloze`) produces. It is INERT — it never becomes an active card until the
 * user explicitly approves it (main-side `approveCard` mints a parked, un-due
 * `card_draft`). `kind` matches the existing `CardKind` (`qa` | `cloze`).
 */
export interface DraftCard {
  readonly kind: "qa" | "cloze";
  /** Q&A prompt (for `qa`). */
  readonly prompt?: string;
  /** Q&A answer (for `qa`). */
  readonly answer?: string;
  /** Canonical `{{c1::answer}}` cloze text (for `cloze`). */
  readonly cloze?: string;
}

/**
 * One AI request: the action + the VERBATIM selected source span (the grounding) +
 * optional surrounding context. The provider's `complete` is the only method that
 * calls a model; the span is what every suggestion links back to (T094).
 */
export interface AiRequest {
  readonly action: AiActionType;
  /** The verbatim selected source text — the grounding the suggestion is made about. */
  readonly sourceText: string;
  /** Optional surrounding extract/source context, to improve the formulation. */
  readonly context?: string;
}

/**
 * One model-produced suggestion. `text` is the model's GENERATED output (never the
 * source quote — that is the request's `sourceText`, stored separately); `cards` is
 * the structured drafts for the card-shaped actions.
 */
export interface AiSuggestion {
  readonly kind: AiSuggestionKind;
  /** The model's generated text (NOT the source). */
  readonly text: string;
  /** Structured card drafts for the card-shaped actions; absent/empty otherwise. */
  readonly cards?: readonly DraftCard[];
}

/**
 * The provider-agnostic seam. The ONLY method that calls a model. A concrete provider
 * (local model / own-key HTTP / managed proxy) implements `complete`; a `FakeAiProvider`
 * implements it with a canned suggestion for tests (no model, no network).
 */
export interface AiProvider {
  readonly kind: AiProviderKind;
  /** Generate suggestions for one request. The ONLY method that calls a model. */
  complete(request: AiRequest, signal?: AbortSignal): Promise<AiSuggestion>;
}

// --- typed errors -----------------------------------------------------------

/** Thrown when an AI action is attempted while `aiEnabled = false` (off by default). */
export class AiDisabledError extends Error {
  readonly code = "ai_disabled" as const;
  constructor(message = "AI assistance is disabled — turn it on in Settings") {
    super(message);
    this.name = "AiDisabledError";
  }
}

/**
 * A general provider failure (the model could not load, a non-2xx own-key HTTP
 * response, a malformed completion). Carries a stable `code` so the worker posts a
 * routable error and the surface degrades to a calm message rather than a crash.
 */
export class AiProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AiProviderError";
  }
}

/**
 * Thrown by the {@link AiProviderKind} `managed_proxy` provider until the first-party
 * `/ai/complete` route ships (T093 only declares the kind + the disclosure UX). Until
 * then the toggle explains the proxy is not yet available — keeping "no first-party
 * server in the loop by default" honest.
 */
export class AiProxyUnavailableError extends AiProviderError {
  constructor(
    message = "The managed AI proxy is not yet available — configure your own API key instead",
  ) {
    super("ai_proxy_unavailable", message);
    this.name = "AiProxyUnavailableError";
  }
}

/** Max characters of selected source text one action may run over (bounds the prompt). */
export const AI_SOURCE_TEXT_MAX = 8_000;
/** Max characters of optional context. */
export const AI_CONTEXT_MAX = 8_000;

/**
 * Whether an action produces a card-shaped suggestion (so the approve-to-card step is
 * offered). `explain`/`simplify`/`detect_ambiguity`/`propose_prerequisites`/`summarize`
 * are copy-or-insert only.
 */
export function actionProducesCard(action: AiActionType): boolean {
  return action === "suggest_qa" || action === "suggest_cloze";
}

/** The suggestion kind a given action yields (the worker labels its result with this). */
export function suggestionKindForAction(action: AiActionType): AiSuggestionKind {
  switch (action) {
    case "suggest_qa":
      return "card_qa";
    case "suggest_cloze":
      return "card_cloze";
    case "propose_prerequisites":
      return "prerequisite_list";
    default:
      return "text";
  }
}
