/**
 * extractArticle tests (T060) — fixture-driven.
 *
 * Pins the readability stage: a real article yields a title/byline + non-empty
 * raw HTML; a JS-only SPA shell + a thin landing page yield little/no content
 * (the caller then falls back to the page title — exercised in the service test).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractArticle } from "./readability";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const fixture = (name: string): string => readFileSync(path.join(fixturesDir, name), "utf8");

describe("extractArticle", () => {
  it("extracts the title, byline, lang, and non-empty content from a real article", () => {
    const art = extractArticle(fixture("article.html"), { url: "https://example.com/spacing" });
    expect(art.title).toContain("Spacing Effect");
    expect(art.byline).toContain("Ebbinghaus");
    expect(art.lang).toBe("en");
    expect(art.contentHtml.length).toBeGreaterThan(0);
    expect(art.contentHtml).toContain("spacing effect");
    expect(art.pageTitle).toContain("Spacing Effect");
  });

  it("returns an empty content + null title for a JS-only SPA shell", () => {
    const art = extractArticle(fixture("empty-spa.html"), { url: "https://example.com/app" });
    expect(art.contentHtml).toBe("");
    expect(art.title).toBeNull();
    expect(art.byline).toBeNull();
    // The page <title> is still available as a fallback for the source title.
    expect(art.pageTitle).toBe("JS App");
  });

  it("yields only thin content for a non-article landing page", () => {
    const art = extractArticle(fixture("non-article.html"), { url: "https://example.com/" });
    // A landing page has no real article body — far shorter than the real article.
    expect(art.contentHtml.length).toBeLessThan(400);
    expect(art.pageTitle).toContain("Memory Lab");
  });

  it("is pure: the same HTML produces the same extraction", () => {
    const html = fixture("article.html");
    const a = extractArticle(html, { url: "https://example.com/x" });
    const b = extractArticle(html, { url: "https://example.com/x" });
    expect(b).toEqual(a);
  });
});
