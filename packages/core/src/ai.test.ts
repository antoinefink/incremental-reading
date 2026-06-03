/**
 * AI domain contract tests (T093) — the action/provider unions, the typed errors,
 * and the action→suggestion-kind mapping. Framework-agnostic; no model, no network.
 */

import { describe, expect, it } from "vitest";
import {
  AI_ACTION_TYPES,
  AI_PROVIDER_KINDS,
  AI_SUGGESTION_KINDS,
  AI_SUGGESTION_STATUSES,
  type AiActionType,
  AiDisabledError,
  AiProviderError,
  AiProxyUnavailableError,
  actionProducesCard,
  isAiActionType,
  isAiProviderKind,
  suggestionKindForAction,
} from "./ai";

describe("AI action union", () => {
  it("has exactly the seven formulation actions", () => {
    expect([...AI_ACTION_TYPES]).toEqual([
      "explain",
      "simplify",
      "suggest_qa",
      "suggest_cloze",
      "detect_ambiguity",
      "propose_prerequisites",
      "summarize",
    ]);
  });

  it("guards a valid action and rejects an unknown one", () => {
    expect(isAiActionType("explain")).toBe(true);
    expect(isAiActionType("suggest_qa")).toBe(true);
    expect(isAiActionType("delete_everything")).toBe(false);
    expect(isAiActionType(42)).toBe(false);
    expect(isAiActionType(null)).toBe(false);
  });
});

describe("AI provider kinds", () => {
  it("are local / anthropic / openai / managed_proxy", () => {
    expect([...AI_PROVIDER_KINDS]).toEqual(["local", "anthropic", "openai", "managed_proxy"]);
  });

  it("guards a valid kind and rejects an unknown one", () => {
    expect(isAiProviderKind("local")).toBe(true);
    expect(isAiProviderKind("managed_proxy")).toBe(true);
    expect(isAiProviderKind("gemini")).toBe(false);
  });
});

describe("suggestion kinds + statuses", () => {
  it("are the four shapes and three statuses", () => {
    expect([...AI_SUGGESTION_KINDS]).toEqual([
      "text",
      "card_qa",
      "card_cloze",
      "prerequisite_list",
    ]);
    expect([...AI_SUGGESTION_STATUSES]).toEqual(["draft", "approved", "dismissed"]);
  });
});

describe("action → suggestion-kind mapping", () => {
  it("maps the card-shaped actions to card kinds and the rest to text", () => {
    expect(suggestionKindForAction("suggest_qa")).toBe("card_qa");
    expect(suggestionKindForAction("suggest_cloze")).toBe("card_cloze");
    expect(suggestionKindForAction("propose_prerequisites")).toBe("prerequisite_list");
    const textActions: AiActionType[] = ["explain", "simplify", "detect_ambiguity", "summarize"];
    for (const a of textActions) expect(suggestionKindForAction(a)).toBe("text");
  });

  it("only the card-shaped actions produce a card draft", () => {
    expect(actionProducesCard("suggest_qa")).toBe(true);
    expect(actionProducesCard("suggest_cloze")).toBe(true);
    expect(actionProducesCard("explain")).toBe(false);
    expect(actionProducesCard("summarize")).toBe(false);
  });
});

describe("typed errors", () => {
  it("AiDisabledError carries the stable code", () => {
    const err = new AiDisabledError();
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("ai_disabled");
    expect(err.name).toBe("AiDisabledError");
  });

  it("AiProviderError carries a routable code", () => {
    const err = new AiProviderError("ai_api_error", "boom");
    expect(err.code).toBe("ai_api_error");
    expect(err.message).toBe("boom");
  });

  it("AiProxyUnavailableError is an AiProviderError with the proxy code", () => {
    const err = new AiProxyUnavailableError();
    expect(err).toBeInstanceOf(AiProviderError);
    expect(err.code).toBe("ai_proxy_unavailable");
  });
});
