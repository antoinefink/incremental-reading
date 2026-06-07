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
 * `hr`, `br`, `a` (href only, `http(s)`/`mailto`), `img` (local
 * `article-image://<source_id>/<asset_id>` only), `strong`/`b`, `em`/`i`, `u`.
 * Everything else is dropped (its inner text kept), and `script`/`style`/
 * `iframe`/`svg`/`form` are removed ENTIRELY (text and all). Pure + idempotent:
 * sanitizing already-sanitized HTML returns the same string.
 */

import sanitizeHtml from "sanitize-html";

const ARTICLE_IMAGE_SRC_RE = /^article-image:\/\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/;
const MAX_IMAGE_DIMENSION = 20_000;
const MAX_IMAGE_TEXT_ATTR_LENGTH = 500;

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
  "img",
  "strong",
  "b",
  "em",
  "i",
  "u",
] as const;

function replaceControlCharacters(value: string): string {
  return Array.from(value, (char) => {
    const code = char.charCodeAt(0);
    return code < 0x20 || code === 0x7f ? " " : char;
  }).join("");
}

function cleanImageTextAttr(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const text = replaceControlCharacters(value)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_IMAGE_TEXT_ATTR_LENGTH);
  return text.length > 0 ? text : undefined;
}

function cleanImageDimension(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const raw = value.trim();
  if (!/^[1-9]\d{0,4}$/.test(raw)) return undefined;
  const dimension = Number.parseInt(raw, 10);
  return dimension <= MAX_IMAGE_DIMENSION ? String(dimension) : undefined;
}

function cleanImageAttributes(attribs: Record<string, string | undefined>): Record<string, string> {
  const src = attribs.src?.trim();
  if (!src || !ARTICLE_IMAGE_SRC_RE.test(src)) return {};

  const alt = cleanImageTextAttr(attribs.alt);
  const title = cleanImageTextAttr(attribs.title);
  const width = cleanImageDimension(attribs.width);
  const height = cleanImageDimension(attribs.height);

  return {
    src,
    ...(alt ? { alt } : {}),
    ...(title ? { title } : {}),
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
  };
}

/**
 * The sanitize-html options. Only `<a href>` and local `<img>` metadata keep
 * attributes. Links allow `http`/`https`/`mailto`; images allow only
 * `article-image://source/asset` refs that have already been rewritten main-side.
 * Tags carrying executable / styling content are removed wholesale
 * (`nonTextTags`), so no script, style, iframe, svg, or form survives even as
 * text.
 */
const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [...ALLOWED_TAGS],
  allowedAttributes: { a: ["href"], img: ["src", "alt", "title", "width", "height"] },
  // Allow only safe schemes; `data:`/`javascript:`/`vbscript:` are rejected.
  allowedSchemes: ["http", "https", "mailto", "article-image"],
  allowedSchemesByTag: { a: ["http", "https", "mailto"], img: ["article-image"] },
  // Drop a link whose scheme is not allowed rather than keeping a dead `href`.
  allowProtocolRelative: false,
  transformTags: {
    img: (tagName, attribs) => ({
      tagName,
      attribs: cleanImageAttributes(attribs),
    }),
  },
  exclusiveFilter: (frame) => {
    if (frame.tag !== "img") return false;
    return !ARTICLE_IMAGE_SRC_RE.test(frame.attribs.src ?? "");
  },
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
