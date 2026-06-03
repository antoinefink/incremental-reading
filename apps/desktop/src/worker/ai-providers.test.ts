/**
 * AI providers tests (T093) — the worker-side provider seam.
 *
 * NO model, NO network: these test the pure prompt/suggestion builders + the
 * env-driven provider factory + the reserved-stub providers (which throw without ever
 * calling out). The own-key providers' HTTP paths are exercised via an injected `fetch`
 * fake (no live endpoint).
 */

import { AiProviderError, AiProxyUnavailableError } from "@interleave/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AnthropicProvider,
  buildPrompt,
  buildSuggestion,
  LocalModelProvider,
  ManagedProxyProvider,
  OpenAiProvider,
  resolveProviderFromEnv,
} from "./ai-providers";

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.INTERLEAVE_AI_API_KEY;
  delete process.env.INTERLEAVE_AI_MODEL_DIR;
});

describe("buildPrompt", () => {
  it("prepends the action instruction + wraps the source text", () => {
    const prompt = buildPrompt({ action: "summarize", sourceText: "Hello world." });
    expect(prompt).toContain("Summarize");
    expect(prompt).toContain("Hello world.");
  });

  it("appends optional context", () => {
    const prompt = buildPrompt({ action: "explain", sourceText: "X", context: "surrounding" });
    expect(prompt).toContain("surrounding");
  });
});

describe("buildSuggestion", () => {
  it("parses a Q&A JSON object into a draft card", () => {
    const s = buildSuggestion("suggest_qa", '{"prompt": "What?", "answer": "This."}');
    expect(s.kind).toBe("card_qa");
    expect(s.cards).toEqual([{ kind: "qa", prompt: "What?", answer: "This." }]);
  });

  it("parses a fenced cloze JSON object into a draft card", () => {
    const s = buildSuggestion("suggest_cloze", '```json\n{"cloze": "The {{c1::answer}}."}\n```');
    expect(s.kind).toBe("card_cloze");
    expect(s.cards).toEqual([{ kind: "cloze", cloze: "The {{c1::answer}}." }]);
  });

  it("degrades a card action with unparseable text to a plain-text suggestion (still a draft)", () => {
    const s = buildSuggestion("suggest_qa", "not json at all");
    expect(s.kind).toBe("card_qa");
    expect(s.cards).toBeUndefined();
    expect(s.text).toBe("not json at all");
  });

  it("returns a text suggestion for the non-card actions", () => {
    const s = buildSuggestion("explain", "an explanation");
    expect(s.kind).toBe("text");
    expect(s.cards).toBeUndefined();
  });
});

describe("resolveProviderFromEnv", () => {
  it("returns the provider matching the payload kind", () => {
    const base = { action: "explain", request: { action: "explain", sourceText: "x" } } as const;
    expect(resolveProviderFromEnv({ ...base, providerKind: "anthropic" })).toBeInstanceOf(
      AnthropicProvider,
    );
    expect(resolveProviderFromEnv({ ...base, providerKind: "openai" })).toBeInstanceOf(
      OpenAiProvider,
    );
    expect(resolveProviderFromEnv({ ...base, providerKind: "managed_proxy" })).toBeInstanceOf(
      ManagedProxyProvider,
    );
    expect(resolveProviderFromEnv({ ...base, providerKind: "local" })).toBeInstanceOf(
      LocalModelProvider,
    );
  });
});

describe("reserved-stub providers throw (never call out)", () => {
  it("the local model provider throws a typed AiProviderError", async () => {
    const provider = new LocalModelProvider("");
    await expect(provider.complete({ action: "explain", sourceText: "x" })).rejects.toBeInstanceOf(
      AiProviderError,
    );
  });

  it("the managed proxy throws AiProxyUnavailableError", async () => {
    const provider = new ManagedProxyProvider();
    await expect(provider.complete({ action: "explain", sourceText: "x" })).rejects.toBeInstanceOf(
      AiProxyUnavailableError,
    );
  });
});

describe("own-key providers call the user's endpoint (injected fetch — no live network)", () => {
  it("Anthropic posts to the messages API and parses the completion", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ content: [{ type: "text", text: "an explanation" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const provider = new AnthropicProvider("sk-user-key");
    const s = await provider.complete({ action: "explain", sourceText: "X" });
    expect(s.kind).toBe("text");
    expect(s.text).toBe("an explanation");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("api.anthropic.com");
    // The user's own key rides the request header — never our server.
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("sk-user-key");
  });

  it("throws AiProviderError without a key", async () => {
    const provider = new OpenAiProvider("");
    await expect(provider.complete({ action: "explain", sourceText: "x" })).rejects.toBeInstanceOf(
      AiProviderError,
    );
  });
});
