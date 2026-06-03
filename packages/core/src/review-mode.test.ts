import { describe, expect, it } from "vitest";
import type { ElementId } from "./ids";
import {
  DEFAULT_RANDOM_AUDIT_SIZE,
  isReviewModeKind,
  MAX_REVIEW_MODE_DECK,
  REVIEW_MODE_KINDS,
  REVIEW_MODE_LABEL,
  type ReviewModeSelector,
  reviewModeLabel,
} from "./review-mode";

describe("REVIEW_MODE_KINDS", () => {
  it("is the closed set of eight kinds", () => {
    expect(REVIEW_MODE_KINDS).toEqual([
      "concept",
      "source",
      "branch",
      "search",
      "semantic",
      "stale",
      "leech",
      "random",
    ]);
  });

  it("has a label for every kind", () => {
    for (const kind of REVIEW_MODE_KINDS) {
      expect(REVIEW_MODE_LABEL[kind]).toBeTruthy();
    }
  });
});

describe("isReviewModeKind", () => {
  it("accepts every known kind", () => {
    for (const kind of REVIEW_MODE_KINDS) {
      expect(isReviewModeKind(kind)).toBe(true);
    }
  });

  it("rejects unknown / non-string values", () => {
    expect(isReviewModeKind("daily")).toBe(false);
    expect(isReviewModeKind("")).toBe(false);
    expect(isReviewModeKind(null)).toBe(false);
    expect(isReviewModeKind(undefined)).toBe(false);
    expect(isReviewModeKind(7)).toBe(false);
    expect(isReviewModeKind({ kind: "concept" })).toBe(false);
  });
});

describe("reviewModeLabel", () => {
  it("returns the calm label for a known kind", () => {
    expect(reviewModeLabel("concept")).toBe("Concept");
    expect(reviewModeLabel("leech")).toBe("Leeches");
    expect(reviewModeLabel("random")).toBe("Random audit");
  });

  it("falls back to a calm 'Review' for an unknown kind (never throws)", () => {
    expect(reviewModeLabel("nonsense")).toBe("Review");
    expect(reviewModeLabel("")).toBe("Review");
  });
});

describe("ReviewModeSelector discriminant", () => {
  it("pairs each kind with its one parameter (compile + runtime shape)", () => {
    const concept: ReviewModeSelector = {
      kind: "concept",
      conceptId: "c1" as ElementId,
    };
    const source: ReviewModeSelector = { kind: "source", sourceId: "s1" as ElementId };
    const branch: ReviewModeSelector = { kind: "branch", rootId: "r1" as ElementId };
    const search: ReviewModeSelector = { kind: "search", query: "spaced repetition" };
    const semantic: ReviewModeSelector = { kind: "semantic", query: "memory" };
    const stale: ReviewModeSelector = { kind: "stale" };
    const leech: ReviewModeSelector = { kind: "leech" };
    const random: ReviewModeSelector = { kind: "random", size: 10, seed: 42 };

    expect(concept.kind).toBe("concept");
    if (concept.kind === "concept") expect(concept.conceptId).toBe("c1");
    if (source.kind === "source") expect(source.sourceId).toBe("s1");
    if (branch.kind === "branch") expect(branch.rootId).toBe("r1");
    if (search.kind === "search") expect(search.query).toBe("spaced repetition");
    if (semantic.kind === "semantic") expect(semantic.query).toBe("memory");
    expect(stale.kind).toBe("stale");
    expect(leech.kind).toBe("leech");
    if (random.kind === "random") {
      expect(random.size).toBe(10);
      expect(random.seed).toBe(42);
    }
  });

  it("allows random without a seed (the seed is optional, descriptor-borne)", () => {
    const random: ReviewModeSelector = { kind: "random", size: 5 };
    if (random.kind === "random") expect(random.seed).toBeUndefined();
  });
});

describe("constants", () => {
  it("caps a deck at a sane bound and the default audit fits under it", () => {
    expect(MAX_REVIEW_MODE_DECK).toBeGreaterThan(0);
    expect(DEFAULT_RANDOM_AUDIT_SIZE).toBeGreaterThan(0);
    expect(DEFAULT_RANDOM_AUDIT_SIZE).toBeLessThanOrEqual(MAX_REVIEW_MODE_DECK);
  });
});
