/**
 * Tests for the source-reference citation formatter (T043). `formatSourceRef` is
 * the one place the refblock's citation/location/href are assembled, reused by
 * review / extract view / inspector / library — so it must omit missing fields
 * cleanly, derive a usable href, and degrade gracefully to the orphan case.
 */

import { describe, expect, it } from "vitest";
import {
  CONFIDENCE_LEVELS,
  EMPTY_SOURCE_REF,
  formatSourceRef,
  isConfidenceLevel,
  isReliabilityTier,
  isSourceType,
  RELIABILITY_TIERS,
  SOURCE_TYPES,
  type SourceRef,
} from "./source-ref";

const FULL: SourceRef = {
  sourceElementId: "src-1",
  sourceTitle: "On the Measure of Intelligence",
  url: "https://arxiv.org/abs/1911.01547",
  author: "François Chollet",
  publishedAt: "2019-11-05T00:00:00.000Z",
  locationLabel: "Definition · ¶ 4",
  snippet: "Intelligence is skill-acquisition efficiency.",
  sourceType: null,
  reliabilityTier: null,
  confidence: null,
  reliabilityNotes: null,
};

describe("formatSourceRef", () => {
  it("assembles a citation from author / title / year", () => {
    const out = formatSourceRef(FULL);
    expect(out.citation).toBe("François Chollet. On the Measure of Intelligence (2019)");
    expect(out.locationLabel).toBe("Definition · ¶ 4");
    expect(out.href).toBe("https://arxiv.org/abs/1911.01547");
    expect(out.snippet).toBe("Intelligence is skill-acquisition efficiency.");
    expect(out.hasSource).toBe(true);
  });

  it("omits missing fields cleanly", () => {
    const out = formatSourceRef({ ...FULL, author: null });
    expect(out.citation).toBe("On the Measure of Intelligence (2019)");

    const noYear = formatSourceRef({ ...FULL, publishedAt: null });
    expect(noYear.citation).toBe("François Chollet. On the Measure of Intelligence");

    const titleOnly = formatSourceRef({
      ...EMPTY_SOURCE_REF,
      sourceTitle: "Some Title",
    });
    expect(titleOnly.citation).toBe("Some Title");
    expect(titleOnly.hasSource).toBe(true);
  });

  it("derives a year from a loose date string without aggressive reformatting", () => {
    expect(formatSourceRef({ ...EMPTY_SOURCE_REF, publishedAt: "2019" }).citation).toBe("(2019)");
    expect(formatSourceRef({ ...EMPTY_SOURCE_REF, publishedAt: "Nov 5, 2019" }).citation).toBe(
      "(2019)",
    );
    // A non-date string yields no year (and no throw).
    expect(formatSourceRef({ ...EMPTY_SOURCE_REF, publishedAt: "soon" }).citation).toBe("");
  });

  it("produces a usable href from a URL (and prefixes a scheme-less host)", () => {
    expect(formatSourceRef({ ...EMPTY_SOURCE_REF, url: "https://x.com/a" }).href).toBe(
      "https://x.com/a",
    );
    expect(formatSourceRef({ ...EMPTY_SOURCE_REF, url: "example.com/path" }).href).toBe(
      "https://example.com/path",
    );
    expect(formatSourceRef({ ...EMPTY_SOURCE_REF, url: "http://incompleteideas.net/x" }).href).toBe(
      "http://incompleteideas.net/x",
    );
    // An unusable / empty URL degrades to no link (never throws).
    expect(formatSourceRef({ ...EMPTY_SOURCE_REF, url: "not a url" }).href).toBeNull();
    expect(formatSourceRef({ ...EMPTY_SOURCE_REF, url: "  " }).href).toBeNull();
  });

  it("returns a calm orphan result when everything is null", () => {
    const out = formatSourceRef(null);
    expect(out.citation).toBe("");
    expect(out.href).toBeNull();
    expect(out.locationLabel).toBeNull();
    expect(out.snippet).toBeNull();
    expect(out.hasSource).toBe(false);

    const empty = formatSourceRef(EMPTY_SOURCE_REF);
    expect(empty.hasSource).toBe(false);
  });

  it("trims blank-but-present fields to the orphan case", () => {
    const out = formatSourceRef({
      ...EMPTY_SOURCE_REF,
      sourceTitle: "   ",
      author: "",
      snippet: "  ",
    });
    expect(out.citation).toBe("");
    expect(out.snippet).toBeNull();
    expect(out.hasSource).toBe(false);
  });
});

describe("formatSourceRef — reliability (T091)", () => {
  it("omits the reliability summary cleanly when all fields are null", () => {
    expect(formatSourceRef(FULL).reliability).toBeNull();
    expect(formatSourceRef(EMPTY_SOURCE_REF).reliability).toBeNull();
  });

  it("a source with ONLY reliability data still resolves (hasSource true, badge shown)", () => {
    const out = formatSourceRef({
      ...EMPTY_SOURCE_REF,
      reliabilityTier: "primary",
      confidence: "high",
    });
    expect(out.hasSource).toBe(true);
    expect(out.reliability).not.toBeNull();
    expect(out.reliability?.label).toBe("Primary source · high confidence");
    expect(out.reliability?.hasUncertainty).toBe(false);
  });

  it("assembles the tier + confidence label for each combination", () => {
    for (const tier of RELIABILITY_TIERS) {
      for (const confidence of CONFIDENCE_LEVELS) {
        const out = formatSourceRef({ ...EMPTY_SOURCE_REF, reliabilityTier: tier, confidence });
        const tierWord = { primary: "Primary", secondary: "Secondary", tertiary: "Tertiary" }[tier];
        expect(out.reliability?.label).toBe(`${tierWord} source · ${confidence} confidence`);
        expect(out.reliability?.tier).toBe(tier);
        expect(out.reliability?.confidence).toBe(confidence);
      }
    }
  });

  it("leads with the source type when no tier is set", () => {
    const out = formatSourceRef({
      ...EMPTY_SOURCE_REF,
      sourceType: "personal_note",
      confidence: "medium",
    });
    expect(out.reliability?.label).toBe("Personal note · medium confidence");
    expect(out.reliability?.sourceType).toBe("personal_note");
  });

  it("sets hasUncertainty for LOW confidence", () => {
    const out = formatSourceRef({
      ...EMPTY_SOURCE_REF,
      reliabilityTier: "secondary",
      confidence: "low",
    });
    expect(out.reliability?.label).toBe("Secondary source · low confidence");
    expect(out.reliability?.hasUncertainty).toBe(true);
  });

  it("sets hasUncertainty + carries notes when a reliability note is present", () => {
    const out = formatSourceRef({
      ...EMPTY_SOURCE_REF,
      reliabilityTier: "primary",
      confidence: "high",
      reliabilityNotes: "  Pre-print; not yet peer reviewed.  ",
    });
    expect(out.reliability?.hasUncertainty).toBe(true);
    expect(out.reliability?.notes).toBe("Pre-print; not yet peer reviewed.");
  });

  it("labels a notes-only source 'Source notes' (no type/tier/confidence)", () => {
    const out = formatSourceRef({
      ...EMPTY_SOURCE_REF,
      reliabilityNotes: "Author has a known bias.",
    });
    expect(out.reliability?.label).toBe("Source notes");
    expect(out.reliability?.hasUncertainty).toBe(true);
  });

  it("blank notes do not create a reliability summary on their own", () => {
    expect(
      formatSourceRef({ ...EMPTY_SOURCE_REF, reliabilityNotes: "   " }).reliability,
    ).toBeNull();
  });
});

describe("reliability tuple guards (T091)", () => {
  it("isSourceType / isReliabilityTier / isConfidenceLevel accept their tuple members", () => {
    for (const v of SOURCE_TYPES) expect(isSourceType(v)).toBe(true);
    for (const v of RELIABILITY_TIERS) expect(isReliabilityTier(v)).toBe(true);
    for (const v of CONFIDENCE_LEVELS) expect(isConfidenceLevel(v)).toBe(true);
  });

  it("rejects non-members / non-strings", () => {
    expect(isSourceType("bogus")).toBe(false);
    expect(isReliabilityTier("quaternary")).toBe(false);
    expect(isConfidenceLevel("maybe")).toBe(false);
    expect(isSourceType(null)).toBe(false);
    expect(isReliabilityTier(42)).toBe(false);
    expect(isConfidenceLevel(undefined)).toBe(false);
  });
});
