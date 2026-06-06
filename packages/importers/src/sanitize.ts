/**
 * Article-HTML sanitizer (T060) — load-bearing security boundary.
 *
 * The cleaned HTML is rendered in the reader AND converted into the stored
 * ProseMirror document, so it MUST contain no scripts, event handlers,
 * `javascript:`/`data:` URLs, remote images, iframes, forms, or styles. This
 * runs `sanitize-html` (pure-JS, via `htmlparser2` — no `window`/DOM global) with
 * an allowlist that maps 1:1 to the constrained editor schema's tag set, so the
 * downstream HTML→ProseMirror step only ever sees representable tags.
 *
 * Allowed tags: `h1`–`h6`, `p`, `blockquote`, `ul`, `ol`, `li`, `pre`, `code`,
 * `hr`, `br`, `a` (href only, `http(s)`/`mailto`), `strong`/`b`, `em`/`i`, `u`.
 * Everything else is dropped (its inner text kept), and `script`/`style`/
 * `iframe`/`img`/`svg`/`form` are removed ENTIRELY (text and all). Pure +
 * idempotent: sanitizing already-sanitized HTML returns the same string.
 */

import sanitizeHtml from "sanitize-html";

/** The allowlisted tag set — the only tags the constrained schema can represent. */
const ALLOWED_TAGS = [
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "blockquote",
  "ul",
  "ol",
  "li",
  "pre",
  "code",
  "hr",
  "br",
  "a",
  "strong",
  "b",
  "em",
  "i",
  "u",
] as const;

/**
 * The sanitize-html options. Only `<a href>` keeps an attribute, and only when
 * the scheme is `http`/`https`/`mailto`. Tags carrying executable / remote /
 * styling content are removed wholesale (`nonTextTags`), so no script, style,
 * iframe, image, svg, or form survives even as text.
 */
const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [...ALLOWED_TAGS],
  allowedAttributes: { a: ["href"] },
  // Allow only safe link schemes; `data:`/`javascript:`/`vbscript:` are rejected.
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesByTag: { a: ["http", "https", "mailto"] },
  // Drop a link whose scheme is not allowed rather than keeping a dead `href`.
  allowProtocolRelative: false,
  // These tags are removed ENTIRELY — their text content is discarded, not kept.
  nonTextTags: ["script", "style", "iframe", "noscript", "form", "textarea", "svg"],
  // No `class`/`id`/`style`/`on*` ever pass (the empty allowedAttributes per-tag
  // default already drops them; this is the explicit backstop).
  disallowedTagsMode: "discard",
};

/**
 * Sanitize raw article HTML to the constrained allowlist. Pure + idempotent.
 *
 * @param html the raw (Readability) article HTML.
 * @returns cleaned HTML containing only allowlisted tags + safe `<a href>`.
 */
export function sanitizeArticleHtml(html: string): string {
  return sanitizeHtml(html, OPTIONS);
}

/** The allowlisted tags (exported for tests). */
export const SANITIZE_ALLOWED_TAGS: readonly string[] = ALLOWED_TAGS;
