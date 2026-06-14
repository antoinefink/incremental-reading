/// <reference types="node" />

/**
 * CSS contract for the redesigned Weekly Review stylesheet (U5 — Weekly Review
 * redesign). Mirrors the repo's CSS-contract-test precedent
 * (`apps/web/src/pages/queue/queue-css.test.ts`, `apps/web/src/styles-css.test.ts`):
 * read `weekly-review.css` from disk as text and pin the token-only + key-class
 * contract.
 *
 * The point is to guard against regressing to the old hard-coded-hex
 * `var(--x, #hex)` fallback pattern: every color must come from a design token,
 * so the surface themes in both light and dark.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const cssPath =
  [
    path.join(process.cwd(), "apps/web/src/weekly/weekly-review.css"),
    path.join(process.cwd(), "src/weekly/weekly-review.css"),
  ].find((candidate) => existsSync(candidate)) ?? "";
const css = readFileSync(cssPath, "utf8");

describe("weekly review CSS", () => {
  it("loads the stylesheet from disk", () => {
    expect(cssPath).not.toBe("");
    expect(css.length).toBeGreaterThan(0);
  });

  it("contains no hard-coded color hex literals", () => {
    // `#rgb`, `#rrggbb`, `#rgba`, `#rrggbbaa` — the regression guard against the
    // old `var(--x, #hex)` fallback pattern. All color comes from tokens.
    const hexMatches = css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    expect(hexMatches).toEqual([]);
  });

  it("references design tokens for color (var(--…))", () => {
    expect(css).toContain("var(--");
  });

  it("uses no raw rgb()/hsl()/oklch() color literals as values", () => {
    // Token-based theming only. `color-mix(in oklch, var(--…) …)` is allowed —
    // it mixes tokens, it is not a raw color literal — so it must NOT trip these
    // assertions. We therefore look for `rgb(`/`hsl(`/`oklch(` used *directly* as
    // a color value, not the `in oklch` color-space keyword inside `color-mix()`.
    expect(css).not.toMatch(/\brgba?\(/);
    expect(css).not.toMatch(/\bhsla?\(/);
    // `oklch(` as a literal color (e.g. `color: oklch(...)`) is disallowed, but
    // the `in oklch` color-space argument of `color-mix()` is fine.
    expect(css).not.toMatch(/(?<!in\s)\boklch\(/);
  });

  it("declares the key structural classes the markup depends on", () => {
    for (const selector of [
      ".wk-funnel",
      ".wk-sec",
      ".wk-flag",
      ".wk-decision",
      ".wk-seg",
      ".wk-prog",
      ".banner",
      ".btn",
      ".prio-dot",
    ]) {
      expect(css).toContain(selector);
    }
  });
});
