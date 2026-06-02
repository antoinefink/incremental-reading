/**
 * HTML-file import helper (T068) — the thin composition for importing a local
 * `.html`/`.htm` file as a constrained ProseMirror document.
 *
 * HTML import REUSES the exact transforms T060 shipped for URL import — there is no
 * new parsing code here. An imported `.html` file is UNTRUSTED (it renders in the
 * reader), so it goes through `sanitizeArticleHtml` (the load-bearing security
 * boundary: no scripts/styles/iframes/event-handlers/`javascript:` survive) BEFORE
 * `htmlToProseMirrorDoc`, and the constrained-schema validation is the final
 * backstop. This module just packages the two-call composition + an HTML `<title>`
 * extraction so the main-side service has ONE call.
 *
 * Pure: no network, no `fs`, no Electron.
 */

import type { PlainTextConversion } from "@interleave/core";
import { type BlockIdMinter, newBlockId } from "@interleave/editor/block-ids";
import { parseHTML } from "linkedom";
import { htmlToProseMirrorDoc } from "./html-to-prosemirror";
import { sanitizeArticleHtml } from "./sanitize";

/**
 * Extract the document `<title>` from raw HTML (before sanitizing, which drops the
 * `<head>`), or `null` when absent/empty. Used as a title fallback for an imported
 * `.html` file that lacks a leading heading.
 */
export function extractHtmlTitle(html: string): string | null {
  try {
    const { document } = parseHTML(html);
    const title = document.querySelector("title")?.textContent ?? null;
    const trimmed = title?.trim() ?? "";
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Convert a local HTML file's contents into the constrained
 * `{ doc, plainText, blocks }` `PlainTextConversion`: sanitize, then map to the
 * constrained ProseMirror schema with stable block ids. Empty/garbage HTML → a
 * valid empty doc.
 *
 * @param html the raw HTML file contents (untrusted).
 * @param mint optional block-id minter (defaults to the editor's ULID minter).
 */
export function htmlFileToProseMirrorDoc(
  html: string,
  mint: BlockIdMinter = newBlockId,
): PlainTextConversion {
  return htmlToProseMirrorDoc(sanitizeArticleHtml(html), mint);
}
