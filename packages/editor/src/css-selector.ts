/**
 * Shared CSS attribute-selector helpers for targeting a block by its stable id.
 *
 * Block ids are ULIDs (alphanumeric, no special characters), so the escaping is
 * purely defensive — but factoring it into ONE place means the read-point jump
 * ({@link buildBlockSelector} via `read-point.ts`) and the jump-to-source path
 * (`jump-to-source.ts`) can never drift if the selector logic ever changes.
 */

import { BLOCK_ID_DOM_ATTR } from "./block-id";

/**
 * Escape a value for safe use inside a CSS attribute selector (`[attr="…"]`).
 * Prefers the platform `CSS.escape` and falls back to escaping quotes/backslashes
 * (the only characters that would break the `="…"` form) when it is unavailable
 * (e.g. a non-DOM test environment).
 */
export function cssEscape(value: string): string {
  const cssApi = (globalThis as { CSS?: { escape?: (s: string) => string } }).CSS;
  if (cssApi?.escape) return cssApi.escape(value);
  return value.replace(/["\\]/g, "\\$&");
}

/** The `[data-block-id="…"]` selector that matches a block's rendered DOM node. */
export function buildBlockSelector(blockId: string): string {
  return `[${BLOCK_ID_DOM_ATTR}="${cssEscape(blockId)}"]`;
}
