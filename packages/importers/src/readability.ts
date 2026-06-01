/**
 * Article extraction via Mozilla Readability over a headless DOM (T060).
 *
 * Pure transform: given a page's raw HTML string + its URL, parse it into a DOM
 * with `linkedom` (a small pure-JS `Document`, chosen over jsdom so the whole
 * thing bundles cleanly into the Electron `main.cjs`), then run
 * `@mozilla/readability` to pull out the readable article. Returns the article's
 * *raw* readable HTML (pre-sanitize) plus its title/byline/lang/excerpt/siteName.
 *
 * No network, no `fs`, no Electron — the orchestrating `UrlImportService` (main
 * side) does the fetch + vault write; this module just transforms HTML→article.
 * When Readability cannot find an article (a landing page, an empty SPA shell),
 * `contentHtml` is `""` and `title`/`byline` are `null`; the caller decides the
 * fallback (it still creates the source, see the spec's edge handling).
 */

import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

/** Options for {@link extractArticle}. */
export interface ExtractArticleOptions {
  /** The page's URL (used by Readability to resolve relative links / metadata). */
  readonly url: string;
}

/** The readable article Readability extracted (raw HTML, pre-sanitize). */
export interface ExtractedArticle {
  /** The article title, or `null` when Readability found no article. */
  readonly title: string | null;
  /** The byline / author line, or `null`. */
  readonly byline: string | null;
  /** The document language (`<html lang>`), or `null`. */
  readonly lang: string | null;
  /** The article's RAW readable HTML (sanitize before storing/converting); `""` when none. */
  readonly contentHtml: string;
  /** A short text excerpt, or `null`. */
  readonly excerpt: string | null;
  /** The publishing site's name, or `null`. */
  readonly siteName: string | null;
  /** The page's `<title>` (independent of Readability), or `null` — a title fallback. */
  readonly pageTitle: string | null;
}

/** Trim a string to `null` when it is empty/whitespace, else the trimmed value. */
function nullIfEmpty(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Extract the readable article from a page's raw HTML.
 *
 * Idempotent + pure: same input → same output, no side effects. Readability is
 * given a CLONE-able DOM (linkedom builds a fresh one per call), so the source
 * HTML string is never mutated.
 */
export function extractArticle(html: string, opts: ExtractArticleOptions): ExtractedArticle {
  // linkedom's `parseHTML` returns a `Document`-like object Readability accepts.
  const { document } = parseHTML(html);

  // Give Readability the page URL so it can resolve relative links + site
  // metadata: inject a `<base href>` when the document lacks one. (linkedom does
  // not derive a base URL from `parseHTML`, so relative `href`/`src` would
  // otherwise stay relative.)
  if (opts.url && document.head && !document.querySelector("base")) {
    try {
      const base = document.createElement("base");
      base.setAttribute("href", opts.url);
      document.head.appendChild(base);
    } catch {
      // A DOM that rejects the base tag is harmless — Readability still runs.
    }
  }

  const pageTitle = nullIfEmpty(document.querySelector("title")?.textContent ?? null);
  const lang = nullIfEmpty(document.documentElement?.getAttribute("lang") ?? null);

  let parsed: ReturnType<Readability["parse"]> = null;
  try {
    // Readability mutates the DOM it is given; linkedom's doc is disposable per call.
    parsed = new Readability(document as unknown as Document).parse();
  } catch {
    // A malformed DOM Readability chokes on ⇒ treat as "no article" (caller falls back).
    parsed = null;
  }

  if (!parsed) {
    return {
      title: null,
      byline: null,
      lang,
      contentHtml: "",
      excerpt: null,
      siteName: null,
      pageTitle,
    };
  }

  return {
    title: nullIfEmpty(parsed.title),
    byline: nullIfEmpty(parsed.byline),
    lang: nullIfEmpty(parsed.lang) ?? lang,
    contentHtml: parsed.content ?? "",
    excerpt: nullIfEmpty(parsed.excerpt),
    siteName: nullIfEmpty(parsed.siteName),
    pageTitle,
  };
}
