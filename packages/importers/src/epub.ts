/**
 * EPUB → constrained-ProseMirror parse transforms (T067) — PURE + I/O-free.
 *
 * An `.epub` is a ZIP container of XHTML chapters + an OPF package descriptor +
 * a nav/ncx table of contents. This module unzips it, reads the OPF spine (the
 * reading order), resolves chapter titles from the nav, and maps each chapter's
 * XHTML to the SAME constrained `PlainTextConversion` shape the HTML/PDF importers
 * produce — REUSING `sanitizeArticleHtml` + `htmlToProseMirrorDoc` (EPUB XHTML is
 * the same constrained tag set, so no second sanitizer/DOM is needed).
 *
 * It is framework-agnostic and fixture-testable: NO `fs`, NO network, NO Electron.
 * The orchestrating `EpubImportService` (Electron main) reads the file, streams
 * `original.epub` into the vault, and runs the one transactional DB mutation — this
 * package only transforms bytes.
 *
 * ## Dependency choices (justified)
 *
 *  - **`fflate`** for the ZIP container: tiny, dependency-free, pure-JS, bundles
 *    cleanly into `main.cjs` (no native bindings). The bytes are already in memory
 *    (main read the file), so `unzipSync(buffer)` → `{ path: Uint8Array }` is the
 *    simplest correct fit. Chosen over `jszip` (heavier, promise-only) and `adm-zip`
 *    (filesystem-oriented). A future huge-book path could switch to fflate's
 *    streaming API; v1 reads the whole archive (tens of MB at most).
 *  - **`fast-xml-parser`** for the OPF/container/ncx XML: pure-JS, no native deps,
 *    and gives a typed object tree that is far cleaner to walk for the spine order +
 *    manifest href resolution than DOM querying. The chapter XHTML *bodies* still go
 *    through `linkedom` via `htmlToProseMirrorDoc` (which already depends on it) — we
 *    do NOT add a second HTML DOM.
 *
 * ## Footnotes (the roadmap names them — preserved, not dropped)
 *
 * The constrained schema has no superscript mark and no inter-document links, so an
 * EPUB footnote (an `<a epub:type="noteref" href="#fnN">` reference pointing at an
 * `<aside epub:type="footnote" id="fnN">` body, EPUB3; or a plain in-chapter anchor,
 * EPUB2) is preserved by (a) keeping the in-text reference as a bracketed `[n]`
 * marker in the paragraph text and (b) appending the note BODIES as an endnotes
 * section at the bottom of the chapter doc (an `hr` + a "Notes" heading + one
 * paragraph `[n] …` per note). This keeps the note CONTENT + its anchor position —
 * more useful for extraction than a dead superscript link. A note whose target body
 * lives in ANOTHER spine item (a shared endnotes file) is resolved best-effort: the
 * `[n]` marker stays and the note surfaces in whichever chapter OWNS its body. This
 * runs on the parsed DOM (pure), so it is unit-testable on a fixture.
 *
 * ## DRM
 *
 * A DRM-protected EPUB (`META-INF/encryption.xml`) cannot be parsed; `parseEpub`
 * throws `EpubParseError("drm", …)` and imports nothing. We never circumvent DRM.
 */

import type { BlockId, PlainTextConversion } from "@interleave/core";
import { type BlockIdMinter, newBlockId } from "@interleave/editor/block-ids";
import { XMLParser } from "fast-xml-parser";
import { unzipSync } from "fflate";
import { parseHTML } from "linkedom";
import { htmlToProseMirrorDoc } from "./html-to-prosemirror";
import { sanitizeArticleHtml } from "./sanitize";

/** The closed set of EPUB parse-failure reasons the service maps to a message. */
export type EpubParseErrorCode = "not_a_zip" | "no_opf" | "no_spine" | "empty_book" | "drm";

/** A typed EPUB parse failure carrying a `code` the import service maps to a message. */
export class EpubParseError extends Error {
  readonly code: EpubParseErrorCode;
  constructor(code: EpubParseErrorCode, message: string) {
    super(message);
    this.name = "EpubParseError";
    this.code = code;
  }
}

/** Book-level metadata read from the OPF `<metadata>` (any field may be `null`). */
export interface ParsedEpubMetadata {
  readonly title: string | null;
  readonly author: string | null;
  readonly language: string | null;
  /** ISO-ish publication date string from `dc:date`, or `null`. */
  readonly publishedAt: string | null;
  /** The `dc:identifier` (ISBN/UUID/URN), or `null`. */
  readonly identifier: string | null;
}

/** One reading unit of the book (a spine item), pre-conversion. */
export interface ParsedEpubChapter {
  /** 0-based spine position — the chapter's "page" ordinal in the book. */
  readonly order: number;
  /** OPF-relative href (used for footnote target resolution). */
  readonly href: string;
  /** Chapter title from the nav/ncx, else `null`. */
  readonly title: string | null;
  /** The raw chapter (X)HTML, pre-sanitize. */
  readonly xhtml: string;
}

/** The result of {@link parseEpub}: book metadata + spine-ordered chapters. */
export interface ParsedEpub {
  readonly metadata: ParsedEpubMetadata;
  readonly chapters: readonly ParsedEpubChapter[];
}

/** A resolved footnote: its display marker + its (plain-text) body. */
export interface ParsedFootnote {
  /** The bracketed marker shown in-text + before the endnote body (e.g. `1`). */
  readonly marker: string;
  /** The note's flattened text content. */
  readonly text: string;
}

/** {@link chapterToProseMirror} output: a conversion plus any lifted footnotes. */
export type ChapterConversion = PlainTextConversion & {
  readonly footnotes: readonly ParsedFootnote[];
};

// --- minimal DOM shapes (lib-agnostic) ------------------------------------
//
// linkedom's `parseHTML` returns standard-DOM-shaped objects, but this module is
// also compiled under the Electron MAIN tsconfig (whose `lib` excludes `DOM`), so we
// describe ONLY the element/document members we touch via local interfaces rather
// than relying on the global `Element`/`Document` ambient types — mirroring how
// `html-to-prosemirror.ts` uses its own `MinimalNode` shape.

/** The shared queryable surface of both an element and the document root. */
interface DomQueryable {
  querySelectorAll(selectors: string): ArrayLike<DomEl>;
  readonly innerHTML?: string;
}

/** The minimal node surface we read for sibling text (footnote-marker spacing). */
interface DomNode {
  readonly textContent: string | null;
}

interface DomEl extends DomQueryable {
  getAttribute(name: string): string | null;
  readonly textContent: string | null;
  readonly nextSibling: DomNode | null;
  remove(): void;
  replaceWith(node: unknown): void;
}

interface DomDoc extends DomQueryable {
  querySelector(selectors: string): DomEl | null;
  getElementById(id: string): DomEl | null;
  createTextNode(text: string): unknown;
  readonly documentElement?: DomEl | null;
}

/** Cast linkedom's `parseHTML(...)` result to our minimal document shape. */
function asDoc(parsed: { document: unknown }): DomDoc {
  return parsed.document as DomDoc;
}

// --- container / OPF / nav parsing ----------------------------------------

const OPF_CONTAINER_PATH = "META-INF/container.xml";
const ENCRYPTION_PATH = "META-INF/encryption.xml";

/**
 * One shared XML parser config: keep attributes (prefixed `@_`), do not coerce
 * values to numbers (ids/dates must stay strings), and always materialize repeated
 * elements as arrays (so a single `<itemref>` and many `<itemref>` walk the same way).
 */
const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseAttributeValue: false,
  parseTagValue: false,
  isArray: (name) =>
    name === "itemref" ||
    name === "item" ||
    name === "navPoint" ||
    name === "reference" ||
    name === "dc:identifier" ||
    name === "dc:creator" ||
    name === "dc:date",
});

/** Decode a zip entry's bytes as UTF-8 text. */
function decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

/** The first non-empty string among the candidates (handles XML text/array shapes). */
function firstText(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") {
    const t = value.trim();
    return t.length > 0 ? t : null;
  }
  if (Array.isArray(value)) {
    for (const v of value) {
      const t = firstText(v);
      if (t) return t;
    }
    return null;
  }
  if (typeof value === "object") {
    // fast-xml-parser stores element text under `#text` when attributes are present.
    return firstText((value as Record<string, unknown>)["#text"]);
  }
  return null;
}

/**
 * Resolve a manifest/href path RELATIVE to the directory of `basePath`, normalized
 * to a POSIX, `..`-collapsed key matching the zip entry paths (which use `/`).
 */
function resolveHref(basePath: string, href: string): string {
  const baseDir = basePath.includes("/") ? basePath.slice(0, basePath.lastIndexOf("/")) : "";
  // Strip a fragment (`chapter.xhtml#fn1` → `chapter.xhtml`) before resolving.
  const clean = href.split("#")[0] ?? href;
  const parts = (baseDir ? `${baseDir}/${clean}` : clean).split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

/** Find the OPF package path from `META-INF/container.xml`. */
function findOpfPath(files: Record<string, Uint8Array>): string {
  const containerBytes = files[OPF_CONTAINER_PATH];
  if (!containerBytes) throw new EpubParseError("no_opf", "The EPUB has no container.xml.");
  const container = xml.parse(decode(containerBytes)) as Record<string, unknown>;
  const root = container.container as Record<string, unknown> | undefined;
  const rootfiles = root?.rootfiles as Record<string, unknown> | undefined;
  const rootfile = rootfiles?.rootfile as Record<string, unknown> | undefined;
  const fullPath = rootfile?.["@_full-path"];
  if (typeof fullPath !== "string" || fullPath.length === 0) {
    throw new EpubParseError("no_opf", "The EPUB container declares no OPF package.");
  }
  return fullPath;
}

/** Read `<metadata>` into the typed {@link ParsedEpubMetadata}. */
function readMetadata(pkg: Record<string, unknown>): ParsedEpubMetadata {
  const metadata = (pkg.metadata ?? {}) as Record<string, unknown>;
  return {
    title: firstText(metadata["dc:title"] ?? metadata.title),
    author: firstText(metadata["dc:creator"] ?? metadata.creator),
    language: firstText(metadata["dc:language"] ?? metadata.language),
    publishedAt: firstText(metadata["dc:date"] ?? metadata.date),
    identifier: firstText(metadata["dc:identifier"] ?? metadata.identifier),
  };
}

/** A manifest entry: its id → resolved zip path + media type. */
interface ManifestItem {
  readonly id: string;
  readonly path: string;
  readonly mediaType: string;
  readonly properties: string;
}

/** Build the id → manifest-item map (hrefs resolved relative to the OPF dir). */
function readManifest(pkg: Record<string, unknown>, opfPath: string): Map<string, ManifestItem> {
  const manifest = (pkg.manifest ?? {}) as Record<string, unknown>;
  const items = (manifest.item ?? []) as Record<string, unknown>[];
  const map = new Map<string, ManifestItem>();
  for (const item of items) {
    const id = item["@_id"];
    const href = item["@_href"];
    if (typeof id !== "string" || typeof href !== "string") continue;
    map.set(id, {
      id,
      path: resolveHref(opfPath, href),
      mediaType: typeof item["@_media-type"] === "string" ? item["@_media-type"] : "",
      properties: typeof item["@_properties"] === "string" ? item["@_properties"] : "",
    });
  }
  return map;
}

/** The ordered list of manifest item-ids the spine declares (reading order). */
function readSpine(pkg: Record<string, unknown>): string[] {
  const spine = pkg.spine as Record<string, unknown> | undefined;
  const itemrefs = (spine?.itemref ?? []) as Record<string, unknown>[];
  const ids: string[] = [];
  for (const ref of itemrefs) {
    const idref = ref["@_idref"];
    // `linear="no"` items (often a cover) are still reading units; keep them in order.
    if (typeof idref === "string") ids.push(idref);
  }
  return ids;
}

/**
 * Resolve a chapter-href → title map from the EPUB3 nav doc (`nav[epub:type=toc]`)
 * or the EPUB2 `toc.ncx`. Best-effort: a book with no nav returns an empty map and
 * chapters fall back to a synthesized "Chapter N" title.
 */
function readTitleMap(
  pkg: Record<string, unknown>,
  manifest: Map<string, ManifestItem>,
  files: Record<string, Uint8Array>,
): Map<string, string> {
  const titles = new Map<string, string>();

  // EPUB3: the manifest item carrying `properties="nav"` is the XHTML nav doc.
  const navItem = [...manifest.values()].find((m) => m.properties.split(/\s+/).includes("nav"));
  if (navItem) {
    const navBytes = files[navItem.path];
    if (navBytes) {
      collectNavXhtmlTitles(decode(navBytes), navItem.path, titles);
    }
  }

  // EPUB2 (or as a fallback): the NCX referenced by `spine[toc]` → manifest item.
  const spine = pkg.spine as Record<string, unknown> | undefined;
  const tocId = spine?.["@_toc"];
  const ncxItem =
    typeof tocId === "string"
      ? manifest.get(tocId)
      : [...manifest.values()].find((m) => m.mediaType === "application/x-dtbncx+xml");
  if (ncxItem) {
    const ncxBytes = files[ncxItem.path];
    if (ncxBytes) collectNcxTitles(decode(ncxBytes), ncxItem.path, titles);
  }

  return titles;
}

/** Walk an EPUB3 nav XHTML's `<a href>` anchors into a resolved-path → text map. */
function collectNavXhtmlTitles(navXhtml: string, navPath: string, out: Map<string, string>): void {
  const document = asDoc(parseHTML(navXhtml));
  // Prefer the toc nav if present, else any anchors in the doc.
  const navs = Array.from(document.querySelectorAll("nav"));
  const tocNav: DomEl | DomDoc =
    navs.find((n) => (n.getAttribute("epub:type") ?? n.getAttribute("type")) === "toc") ??
    navs[0] ??
    document;
  for (const anchor of Array.from(tocNav.querySelectorAll("a"))) {
    const href = anchor.getAttribute("href");
    const text = (anchor.textContent ?? "").replace(/\s+/g, " ").trim();
    if (!href || text.length === 0) continue;
    const resolved = resolveHref(navPath, href);
    if (!out.has(resolved)) out.set(resolved, text);
  }
}

/** Walk an EPUB2 NCX `navMap` into a resolved-path → text map. */
function collectNcxTitles(ncxXml: string, ncxPath: string, out: Map<string, string>): void {
  const parsed = xml.parse(ncxXml) as Record<string, unknown>;
  const ncx = parsed.ncx as Record<string, unknown> | undefined;
  const navMap = ncx?.navMap as Record<string, unknown> | undefined;
  const walk = (points: unknown): void => {
    const arr = Array.isArray(points) ? points : points ? [points] : [];
    for (const raw of arr) {
      const point = raw as Record<string, unknown>;
      const label = point.navLabel as Record<string, unknown> | undefined;
      const text = firstText(label?.text);
      const content = point.content as Record<string, unknown> | undefined;
      const src = content?.["@_src"];
      if (typeof src === "string" && text) {
        const resolved = resolveHref(ncxPath, src);
        if (!out.has(resolved)) out.set(resolved, text);
      }
      if (point.navPoint) walk(point.navPoint);
    }
  };
  walk(navMap?.navPoint);
}

/**
 * Parse an EPUB byte buffer into book metadata + spine-ordered chapters. PURE: no
 * `fs`/network/Electron. Throws a typed {@link EpubParseError} on a non-ZIP / no-OPF
 * / no-spine / empty / DRM-protected archive (the service maps `code` to a message).
 */
export function parseEpub(bytes: Uint8Array): ParsedEpub {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new EpubParseError("not_a_zip", "That file is not a valid EPUB (not a ZIP archive).");
  }

  // DRM check — a present `encryption.xml` means the content is encrypted.
  if (files[ENCRYPTION_PATH]) {
    throw new EpubParseError("drm", "This EPUB is DRM-protected and cannot be imported.");
  }

  const opfPath = findOpfPath(files);
  const opfBytes = files[opfPath];
  if (!opfBytes) {
    throw new EpubParseError("no_opf", "The EPUB's OPF package file is missing.");
  }
  const parsed = xml.parse(decode(opfBytes)) as Record<string, unknown>;
  const pkg = parsed.package as Record<string, unknown> | undefined;
  if (!pkg) throw new EpubParseError("no_opf", "The EPUB OPF package is malformed.");

  const metadata = readMetadata(pkg);
  const manifest = readManifest(pkg, opfPath);
  const spineIds = readSpine(pkg);
  if (spineIds.length === 0) {
    throw new EpubParseError("no_spine", "The EPUB declares no reading order (empty spine).");
  }
  const titleMap = readTitleMap(pkg, manifest, files);

  const chapters: ParsedEpubChapter[] = [];
  let order = 0;
  for (const idref of spineIds) {
    const item = manifest.get(idref);
    if (!item) continue;
    const bytes2 = files[item.path];
    if (!bytes2) continue;
    chapters.push({
      order,
      href: item.path,
      title: titleMap.get(item.path) ?? null,
      xhtml: decode(bytes2),
    });
    order += 1;
  }

  if (chapters.length === 0) {
    throw new EpubParseError("empty_book", "The EPUB has no readable chapter content.");
  }

  return { metadata, chapters };
}

// --- chapter → ProseMirror (with footnote lifting) ------------------------

/** A node we treat as a footnote BODY (EPUB3 `aside epub:type=footnote`, etc.). */
function isFootnoteBody(el: DomEl): boolean {
  const type = el.getAttribute("epub:type") ?? el.getAttribute("role") ?? "";
  return /\b(footnote|endnote|rearnote|note)\b/.test(type);
}

/** A reference anchor pointing at a same-document note (`epub:type=noteref`). */
function isNoteRef(el: DomEl): boolean {
  const type = el.getAttribute("epub:type") ?? el.getAttribute("role") ?? "";
  return /\b(noteref|backlink)\b/.test(type);
}

/**
 * Lift footnotes OUT of a chapter's XHTML, returning the body XHTML with each
 * note reference replaced by a bracketed `[n]` marker and the note bodies removed,
 * plus the ordered list of `{ marker, text }` notes (to render as an endnotes
 * section). Operates on a linkedom DOM (pure).
 *
 * Strategy:
 *  1. Collect footnote BODIES (elements whose `epub:type`/`role` is a note kind, OR
 *     the targets of in-doc `<a href="#id">` note references) keyed by their `id`.
 *  2. Walk note REFERENCES (`epub:type=noteref`, or `<a href="#id">` to a collected
 *     body) in document order, assigning each a sequential number, replacing the
 *     anchor with a `[n]` text marker.
 *  3. Remove the note-body elements from the flow (they become the endnotes section).
 */
function liftFootnotes(xhtml: string): { bodyHtml: string; notes: ParsedFootnote[] } {
  const document = asDoc(parseHTML(xhtml));
  const body: DomEl | DomDoc = document.querySelector("body") ?? document;

  // 1. Index candidate note bodies by id.
  const noteBodies = new Map<string, DomEl>();
  for (const el of Array.from(body.querySelectorAll("aside, [epub\\:type], [role], li, div, p"))) {
    const id = el.getAttribute("id");
    if (id && isFootnoteBody(el)) noteBodies.set(id, el);
  }

  // Also treat as a note body any element that is the in-doc target of an `<a>`
  // whose own text is a bare number / dagger-style marker (common EPUB2 pattern).
  const anchors = Array.from(body.querySelectorAll("a"));
  for (const a of anchors) {
    const href = a.getAttribute("href") ?? "";
    if (!href.startsWith("#")) continue;
    const targetId = href.slice(1);
    if (noteBodies.has(targetId)) continue;
    const target = targetId ? document.getElementById(targetId) : null;
    const refText = (a.textContent ?? "").trim();
    if (target && isFootnoteBody(target) && /^[0-9*†‡§¶[\]().]+$/.test(refText)) {
      noteBodies.set(targetId, target);
    }
  }

  // 2. Walk references in document order, numbering them.
  const notes: ParsedFootnote[] = [];
  const numberByTarget = new Map<string, number>();
  let counter = 0;

  for (const a of anchors) {
    const href = a.getAttribute("href") ?? "";
    const targetId = href.startsWith("#") ? href.slice(1) : "";
    const refersToNote = (targetId && noteBodies.has(targetId)) || isNoteRef(a);
    if (!refersToNote) continue;

    // Assign (or reuse) this note's number.
    let n = targetId ? numberByTarget.get(targetId) : undefined;
    if (n === undefined) {
      counter += 1;
      n = counter;
      if (targetId) numberByTarget.set(targetId, n);
      const bodyEl = targetId ? noteBodies.get(targetId) : null;
      const text = bodyEl ? cleanNoteText(bodyEl) : (a.getAttribute("title") ?? "").trim();
      notes.push({ marker: String(n), text });
    }
    // Replace the anchor with a bracketed marker text node. Drop the trailing
    // space when the marker butts up against trailing punctuation (e.g. a period
    // right after the reference) so the body reads `…practice[1].` not `…[1] .`.
    const after = (a.nextSibling?.textContent ?? "").trimStart();
    const trailingSpace = /^[.,;:!?)\]}]/.test(after) ? "" : " ";
    const marker = document.createTextNode(`[${n}]${trailingSpace}`);
    a.replaceWith(marker);
  }

  // 3. Remove note-body elements from the flow (they live in the endnotes section).
  for (const el of noteBodies.values()) {
    el.remove();
  }

  // Serialize the EDITED DOM. linkedom always synthesizes a `<body>` for any XHTML
  // chapter, so `body.innerHTML` is the normal path; fall back to the edited document
  // element (never the original `xhtml`, which would discard the note removals above).
  const bodyHtml = body.innerHTML ?? document.documentElement?.innerHTML ?? "";
  return { bodyHtml, notes };
}

/** Flatten a note body element to clean plain text, stripping a leading back-marker. */
function cleanNoteText(el: DomEl): string {
  const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
  // Drop a leading "1." / "1" / "*" back-reference marker the note body may repeat.
  return text.replace(/^[0-9*†‡§¶]+[.)\]]?\s*/, "").trim();
}

/**
 * Convert one parsed chapter to the constrained `{ doc, plainText, blocks }`
 * conversion (validating against `buildSchema()`), lifting footnotes into an
 * endnotes section at the bottom and preserving `[n]` markers in the body. The
 * `mint` minter is threaded so a single book import can mint stable block ids
 * across all chapters without collision.
 */
export function chapterToProseMirror(
  chapter: ParsedEpubChapter,
  mint: BlockIdMinter = newBlockId,
): ChapterConversion {
  const { bodyHtml, notes } = liftFootnotes(chapter.xhtml);

  // Build the endnotes XHTML (appended to the chapter body before sanitize) so the
  // note CONTENT + anchors survive a schema with no superscript/links.
  let html = bodyHtml;
  if (notes.length > 0) {
    const noteParas = notes
      .map((note) => `<p>[${escapeHtml(note.marker)}] ${escapeHtml(note.text)}</p>`)
      .join("");
    html = `${bodyHtml}<hr /><h2>Notes</h2>${noteParas}`;
  }

  const sanitized = sanitizeArticleHtml(html);
  const conversion = htmlToProseMirrorDoc(sanitized, mint);
  return { ...conversion, footnotes: notes };
}

/** Minimal HTML-text escaping for the endnotes section we synthesize. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Re-export the block-id type so consumers do not reach into `@interleave/editor`. */
export type { BlockId };
