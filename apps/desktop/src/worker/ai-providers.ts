/**
 * AI providers (T093) — run in the DB-FREE `utilityProcess` worker, off-main.
 *
 * The worker computes an AI suggestion OFF the main thread (a local-model inference OR
 * the user's own-key HTTP call) and posts the plain {@link AiSuggestion} back; MAIN
 * persists the inert `ai_suggestions` DRAFT row. This module owns the model/network
 * compute ONLY — it imports NO `@interleave/db`, `better-sqlite3`, repository, or
 * `DbService`. The secrets (the user's API key, the provider kind, the model dir) reach
 * the worker via the FORK-ENV seam (`INTERLEAVE_AI_API_KEY` / `INTERLEAVE_AI_PROVIDER` /
 * `INTERLEAVE_AI_MODEL_DIR`), baked into the one long-lived worker at construction —
 * NEVER in the persisted `jobs` payload (the same secret-handling discipline as
 * `INTERLEAVE_ASSETS_DIR`).
 *
 * ## Provider/model decision (built to the spec)
 *
 * - **Own-key (Anthropic / OpenAI) = the recommended WORKING generation path.** A plain
 *   HTTPS call from the worker using the user's key; works immediately, predictable
 *   quality, keeps AI strictly opt-in. {@link AnthropicProvider} / {@link OpenAiProvider}.
 * - **The local instruction model = the EXPLICITLY-EXPERIMENTAL option, shipped here as
 *   a RESERVED not-yet-available STUB.** A usable on-device instruction model is a
 *   materially bigger, less-certain bet than T087's embedding model (tens-to-hundreds of
 *   MB to a few GB; CPU-only quality is uneven), pinned to `node-llama-cpp` running
 *   `Llama-3.2-3B-Instruct` Q4_K_M GGUF (~2 GB int4, the `aiLocalModelId` default). To
 *   keep the milestone buildable without committing the LLM infra now, the
 *   {@link LocalModelProvider} throws a typed `AiProviderError` ("local model not yet
 *   available — configure an own-key provider") until the `node-llama-cpp` integration
 *   lands — exactly like {@link ManagedProxyProvider} throws `AiProxyUnavailableError`.
 *   The drafts-only + off-by-default + degrade-gracefully invariants fully contain the
 *   residual risk: an absent/stubbed local model just means the action is disabled or
 *   routed to own-key — it can NEVER produce an unapproved or bad active card.
 * - **Managed proxy = off by default, declared not built.** {@link ManagedProxyProvider}
 *   throws `AiProxyUnavailableError` until the first-party `/ai/complete` route lands.
 *
 * Tests inject a `FakeAiProvider` (a canned {@link AiSuggestion}) — no model, no network.
 */

import {
  type AiActionType,
  type AiProvider,
  AiProviderError,
  type AiProviderKind,
  AiProxyUnavailableError,
  type AiRequest,
  type AiSuggestion,
  type DraftCard,
  suggestionKindForAction,
} from "@interleave/core";

/** The non-secret AI job payload MAIN enqueues + persists (NO key — see the module doc). */
export interface AiJobPayload {
  readonly action: AiActionType;
  readonly providerKind: AiProviderKind;
  readonly request: AiRequest;
}

/** Resolve the AI provider from the worker's fork-env (the key/provider/model dir). */
export function resolveProviderFromEnv(payload: AiJobPayload): AiProvider {
  // E2E SEAM (honored only in the unpackaged build): `INTERLEAVE_AI_FAKE=1` injects a
  // deterministic canned provider so the Electron E2E exercises the full AI flow with
  // NO live model / network. Mirrors the `INTERLEAVE_*_IMPORT_PATH` test escapes.
  if (process.env.INTERLEAVE_AI_FAKE === "1") {
    return new FakeAiProvider(payload.providerKind);
  }
  // The provider kind the payload carries is the configured one; the env-baked
  // INTERLEAVE_AI_PROVIDER is a cross-check (they agree when AI is enabled).
  const kind = payload.providerKind;
  const apiKey = process.env.INTERLEAVE_AI_API_KEY ?? "";
  const modelDir = process.env.INTERLEAVE_AI_MODEL_DIR ?? "";
  switch (kind) {
    case "anthropic":
      return new AnthropicProvider(apiKey);
    case "openai":
      return new OpenAiProvider(apiKey);
    case "managed_proxy":
      return new ManagedProxyProvider();
    default:
      return new LocalModelProvider(modelDir);
  }
}

/**
 * A deterministic FAKE provider (E2E / test seam) — returns a canned suggestion per
 * action with NO model and NO network. Used by the Electron E2E via
 * `INTERLEAVE_AI_FAKE=1`, and importable directly by unit tests. For the card-shaped
 * actions it returns a well-formed {@link DraftCard} so the approve-to-card path is
 * exercised end-to-end.
 */
export class FakeAiProvider implements AiProvider {
  constructor(readonly kind: AiProviderKind = "anthropic") {}

  complete(request: AiRequest): Promise<AiSuggestion> {
    const kind = suggestionKindForAction(request.action);
    if (request.action === "suggest_qa") {
      return Promise.resolve({
        kind,
        text: `Q&A drafted from: ${request.sourceText.slice(0, 40)}`,
        cards: [
          {
            kind: "qa",
            prompt: "What does the selected text describe?",
            answer: request.sourceText.slice(0, 60),
          },
        ],
      });
    }
    if (request.action === "suggest_cloze") {
      return Promise.resolve({
        kind,
        text: "Cloze drafted",
        cards: [
          { kind: "cloze", cloze: `The {{c1::${request.sourceText.slice(0, 24)}}} matters.` },
        ],
      });
    }
    return Promise.resolve({
      kind,
      text: `[${request.action}] ${request.sourceText.slice(0, 60)}`,
    });
  }
}

/**
 * The OWN-KEY Anthropic provider — a plain HTTPS call to the Messages API using the
 * user's key (read from the fork env, NEVER the payload). Best-effort parse of the
 * completion into a {@link DraftCard} for the card-shaped actions.
 */
export class AnthropicProvider implements AiProvider {
  readonly kind = "anthropic" as const;
  constructor(private readonly apiKey: string) {}

  async complete(request: AiRequest, signal?: AbortSignal): Promise<AiSuggestion> {
    if (!this.apiKey) {
      throw new AiProviderError("ai_no_api_key", "Anthropic provider selected but no API key set");
    }
    const prompt = buildPrompt(request);
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-3-5-haiku-latest",
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      }),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      throw new AiProviderError(
        "ai_api_error",
        `Anthropic API returned ${response.status} ${response.statusText}`,
      );
    }
    const json = (await response.json()) as {
      content?: Array<{ type?: string; text?: string }>;
    };
    const text = (json.content ?? [])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("\n")
      .trim();
    return buildSuggestion(request.action, text);
  }
}

/** The OWN-KEY OpenAI provider — a plain HTTPS call to the Chat Completions API. */
export class OpenAiProvider implements AiProvider {
  readonly kind = "openai" as const;
  constructor(private readonly apiKey: string) {}

  async complete(request: AiRequest, signal?: AbortSignal): Promise<AiSuggestion> {
    if (!this.apiKey) {
      throw new AiProviderError("ai_no_api_key", "OpenAI provider selected but no API key set");
    }
    const prompt = buildPrompt(request);
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
      }),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      throw new AiProviderError(
        "ai_api_error",
        `OpenAI API returned ${response.status} ${response.statusText}`,
      );
    }
    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = (json.choices?.[0]?.message?.content ?? "").trim();
    return buildSuggestion(request.action, text);
  }
}

/**
 * The local on-device instruction model — RESERVED STUB (T093). Pinned to
 * `node-llama-cpp` running `Llama-3.2-3B-Instruct` Q4_K_M GGUF (~2 GB int4), it would
 * run in THIS worker (DB-free, off-main) once the integration lands. Until then it
 * throws a typed `AiProviderError` so the disabled-state UX routes a freshly-enabling
 * user to an own-key provider — it can never silently produce a card.
 */
export class LocalModelProvider implements AiProvider {
  readonly kind = "local" as const;
  // The model dir is reserved for the eventual node-llama-cpp GGUF load.
  constructor(readonly modelDir: string) {}

  complete(_request: AiRequest, _signal?: AbortSignal): Promise<AiSuggestion> {
    return Promise.reject(
      new AiProviderError(
        "ai_local_unavailable",
        "The local AI model is not yet available — configure an own-key provider (Anthropic/OpenAI) in Settings",
      ),
    );
  }
}

/** The first-party managed proxy — declared, not built (T093). Throws until the route lands. */
export class ManagedProxyProvider implements AiProvider {
  readonly kind = "managed_proxy" as const;
  complete(_request: AiRequest, _signal?: AbortSignal): Promise<AiSuggestion> {
    return Promise.reject(new AiProxyUnavailableError());
  }
}

/** Build the model prompt for one action over the selected span. Plain + framework-free. */
export function buildPrompt(request: AiRequest): string {
  const instruction = ACTION_INSTRUCTIONS[request.action];
  const context = request.context ? `\n\nSurrounding context:\n${request.context}` : "";
  return `${instruction}\n\nSource text:\n"""\n${request.sourceText}\n"""${context}`;
}

/** The per-action instruction prepended to the source text. */
const ACTION_INSTRUCTIONS: Record<AiActionType, string> = {
  explain: "Explain the following source text clearly and concisely for a learner.",
  simplify: "Rewrite the following source text in simpler, plainer language.",
  suggest_qa:
    "Write ONE atomic question-and-answer flashcard from the source text. " +
    'Respond ONLY as JSON: {"prompt": "...", "answer": "..."}.',
  suggest_cloze:
    "Write ONE atomic cloze-deletion flashcard from the source text using {{c1::answer}} syntax. " +
    'Respond ONLY as JSON: {"cloze": "..."}.',
  detect_ambiguity:
    "Identify any ambiguous pronouns, vague terms, or unclear references in the source text.",
  propose_prerequisites:
    "List the prerequisite concepts a learner should understand before this source text.",
  summarize: "Summarize the following source text in two or three sentences.",
};

/**
 * Build the {@link AiSuggestion} from the model's raw text. For the card-shaped actions
 * it best-effort-parses the JSON object into a {@link DraftCard}; a parse failure
 * degrades to a plain-text suggestion (still a draft — never an active card). The
 * suggestion `kind` always matches the action ({@link suggestionKindForAction}).
 */
export function buildSuggestion(action: AiActionType, rawText: string): AiSuggestion {
  const kind = suggestionKindForAction(action);
  if (action === "suggest_qa") {
    const card = parseQaCard(rawText);
    if (card) return { kind, text: rawText, cards: [card] };
  }
  if (action === "suggest_cloze") {
    const card = parseClozeCard(rawText);
    if (card) return { kind, text: rawText, cards: [card] };
  }
  return { kind, text: rawText };
}

/** Extract the first JSON object from a model response (handles ```json fences). */
function extractJsonObject(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? (fenced[1] ?? "") : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function parseQaCard(text: string): DraftCard | null {
  const obj = extractJsonObject(text);
  if (!obj) return null;
  const prompt = typeof obj.prompt === "string" ? obj.prompt.trim() : "";
  const answer = typeof obj.answer === "string" ? obj.answer.trim() : "";
  if (prompt.length === 0 && answer.length === 0) return null;
  return { kind: "qa", prompt, answer };
}

function parseClozeCard(text: string): DraftCard | null {
  const obj = extractJsonObject(text);
  if (!obj) return null;
  const cloze = typeof obj.cloze === "string" ? obj.cloze.trim() : "";
  if (cloze.length === 0) return null;
  return { kind: "cloze", cloze };
}
