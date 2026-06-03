import { describe, expect, it } from "vitest";
import { HELP_BODIES } from "./help-bodies";
import {
  HELP_BY_SLUG,
  HELP_CATEGORIES,
  HELP_GLOSSARY,
  HELP_POPULAR,
  HELP_SPECIAL,
  relatedSlugs,
  searchHelp,
} from "./help-data";

describe("help-data integrity", () => {
  it("every popular + glossary slug resolves to a real article", () => {
    for (const slug of HELP_POPULAR) expect(HELP_BY_SLUG[slug], slug).toBeTruthy();
    for (const [, , slug] of HELP_GLOSSARY) expect(HELP_BY_SLUG[slug], slug).toBeTruthy();
  });

  it("every related-articles link points at a real slug", () => {
    for (const slug of Object.keys(HELP_BY_SLUG)) {
      for (const rel of relatedSlugs(slug)) {
        expect(HELP_BY_SLUG[rel], `${slug} → ${rel}`).toBeTruthy();
      }
    }
  });

  it("every shipped/partial/planned article (except the two reference pages) has an authored body", () => {
    const missing: string[] = [];
    for (const cat of HELP_CATEGORIES) {
      for (const [slug] of cat.arts) {
        if (!HELP_BODIES[slug]) missing.push(slug);
      }
    }
    expect(missing, `articles still on the stub: ${missing.join(", ")}`).toEqual([]);
  });

  it("the two reference pages are special (rendered from registry, not bodies)", () => {
    for (const s of HELP_SPECIAL) {
      expect(HELP_BY_SLUG[s.slug]?.special).toBe(true);
      expect(HELP_BODIES[s.slug]).toBeUndefined();
    }
  });

  it("every authored body slug is a known article", () => {
    for (const slug of Object.keys(HELP_BODIES)) {
      expect(HELP_BY_SLUG[slug], slug).toBeTruthy();
    }
  });

  it("article bodies only use the supported block shapes", () => {
    const figures = new Set(["pipeline", "schedulers", "extract-vs-hl"]);
    for (const [slug, blocks] of Object.entries(HELP_BODIES)) {
      for (const b of blocks) {
        if (b.type === "p" || b.type === "h2") expect(typeof b.text, slug).toBe("string");
        else if (b.type === "ul") expect(Array.isArray(b.items), slug).toBe(true);
        else if (b.type === "callout") expect(typeof b.text, slug).toBe("string");
        else if (b.type === "figure")
          expect(figures.has(b.figure), `${slug}:${b.figure}`).toBe(true);
        else throw new Error(`${slug}: unexpected block ${JSON.stringify(b)}`);
      }
    }
  });
});

describe("searchHelp", () => {
  it("matches by title keyword", () => {
    const r = searchHelp("extract");
    expect(r.length).toBeGreaterThan(0);
    expect(r.some((a) => a.slug === "extracts-vs-highlights" || a.slug === "extracting")).toBe(
      true,
    );
  });

  it("resolves the synonym alias map (the words users actually type)", () => {
    expect(searchHelp("anki")[0]?.slug).toBe("migrating-readwise-kindle-anki");
    expect(searchHelp("restore")[0]?.slug).toBe("using-trash");
    expect(searchHelp("too many cards")[0]?.slug).toBe("review-budget");
    expect(searchHelp("dark mode")[0]?.slug).toBe("interface-settings");
  });

  it("returns nothing for an empty query and a tidy miss for nonsense", () => {
    expect(searchHelp("")).toEqual([]);
    expect(searchHelp("   ")).toEqual([]);
    expect(searchHelp("zzzzzznotahelparticle")).toEqual([]);
  });

  it("caps results", () => {
    expect(searchHelp("a").length).toBeLessThanOrEqual(12);
  });
});
