/**
 * sanitizeArticleHtml tests (T060) — the load-bearing security boundary.
 *
 * Asserts the allowlist drops scripts / styles / iframes / remote images / forms
 * / event handlers / `javascript:` URLs and keeps only the constrained tag set,
 * including already-local `article-image://` refs, and that sanitizing is
 * idempotent (sanitizing twice == once).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sanitizeArticleHtml } from "./sanitize";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const fixture = (name: string): string => readFileSync(path.join(fixturesDir, name), "utf8");

describe("sanitizeArticleHtml", () => {
  it("strips scripts, styles, iframes, remote images, svg, and forms entirely", () => {
    const dirty = `
      <h1>Title</h1>
      <script>alert('x')</script>
      <style>body{color:red}</style>
      <iframe src="https://evil.test"></iframe>
      <img src="https://tracker.test/p.gif" alt="px" />
      <svg><circle/></svg>
      <form action="/x"><input/></form>
      <p>Body text.</p>`;
    const clean = sanitizeArticleHtml(dirty);
    expect(clean).not.toMatch(/<script/i);
    expect(clean).not.toMatch(/<style/i);
    expect(clean).not.toMatch(/<iframe/i);
    expect(clean).not.toMatch(/<img/i);
    expect(clean).not.toMatch(/<svg/i);
    expect(clean).not.toMatch(/<form/i);
    expect(clean).not.toMatch(/alert\(/);
    expect(clean).toContain("Body text.");
    expect(clean).toContain("Title");
  });

  it("allows only already-local article-image refs with safe image attrs", () => {
    const clean = sanitizeArticleHtml(`
      <p>
        <img
          src="article-image://src_1/asset-1"
          alt=" Figure
          one "
          title="  Local figure  "
          width="640"
          height="480"
          srcset="https://remote.test/a.png 2x"
          loading="eager"
          onerror="steal()"
          style="width:100vw"
        />
      </p>`);

    expect(clean).toContain("<img");
    expect(clean).toContain('src="article-image://src_1/asset-1"');
    expect(clean).toContain('alt="Figure one"');
    expect(clean).toContain('title="Local figure"');
    expect(clean).toContain('width="640"');
    expect(clean).toContain('height="480"');
    expect(clean).not.toMatch(/srcset|loading|onerror|style=/i);
  });

  it("drops malformed or non-local image refs", () => {
    const clean = sanitizeArticleHtml(`
      <img src="https://remote.test/a.png" alt="remote" />
      <img src="//remote.test/a.png" alt="protocol relative" />
      <img src="file:///etc/passwd" alt="file" />
      <img src="data:image/png;base64,aaa" alt="data" />
      <img src="article-image://src_1/../asset_1" alt="traversal" />
      <img src="article-image://src_1/asset%2F1" alt="encoded slash" />
      <img src="article-image://src_1" alt="missing asset" />
    `);

    expect(clean).not.toMatch(/<img/i);
    expect(clean).not.toMatch(/remote\.test|file:\/\/|data:image|article-image:\/\//i);
  });

  it("removes inline event handlers and style attributes", () => {
    const clean = sanitizeArticleHtml(
      `<p onclick="steal()" style="font-size:40px" class="x" id="y">Hi</p>`,
    );
    expect(clean).not.toMatch(/onclick/i);
    expect(clean).not.toMatch(/style=/i);
    expect(clean).not.toMatch(/class=/i);
    expect(clean).not.toMatch(/id=/i);
    expect(clean).toContain("Hi");
  });

  it("drops javascript: links but keeps safe http(s)/mailto links", () => {
    const clean = sanitizeArticleHtml(
      `<p><a href="javascript:alert(1)">bad</a> <a href="https://example.com/safe">good</a> ` +
        `<a href="mailto:a@b.co">mail</a></p>`,
    );
    expect(clean).not.toMatch(/javascript:/i);
    expect(clean).toContain('href="https://example.com/safe"');
    expect(clean).toContain('href="mailto:a@b.co"');
    // The text of the dropped link is preserved.
    expect(clean).toContain("bad");
  });

  it("keeps only allowlisted tags (unknown tags drop, text stays)", () => {
    const clean = sanitizeArticleHtml(
      `<section><h2>H</h2><table><tr><td>cell</td></tr></table><p><strong>B</strong> <u>U</u></p></section>`,
    );
    expect(clean).not.toMatch(/<section/i);
    expect(clean).not.toMatch(/<table/i);
    expect(clean).not.toMatch(/<td/i);
    expect(clean).toContain("<h2>H</h2>");
    expect(clean).toContain("<strong>B</strong>");
    expect(clean).toContain("<u>U</u>");
    expect(clean).toContain("cell");
  });

  it("is idempotent — sanitizing twice equals once", () => {
    const dirty = `<h1>T</h1><script>x()</script><p style="x">a <a href="javascript:1">b</a></p>`;
    const once = sanitizeArticleHtml(dirty);
    const twice = sanitizeArticleHtml(once);
    expect(twice).toBe(once);
  });

  it("strips every disallowed tag from the dirty-article fixture while keeping the prose", () => {
    // The fixture is the spec's "page with disallowed tags (script/style/iframe/img)".
    const clean = sanitizeArticleHtml(fixture("dirty-article.html"));
    expect(clean).not.toMatch(/<script/i);
    expect(clean).not.toMatch(/<style/i);
    expect(clean).not.toMatch(/<iframe/i);
    expect(clean).not.toMatch(/<img/i);
    expect(clean).not.toMatch(/<svg/i);
    expect(clean).not.toMatch(/<form/i);
    expect(clean).not.toMatch(/<input/i);
    expect(clean).not.toMatch(/onclick/i);
    expect(clean).not.toMatch(/style=/i);
    expect(clean).not.toMatch(/class=/i);
    expect(clean).not.toMatch(/javascript:/i);
    expect(clean).not.toMatch(/window\.__tracked/);
    expect(clean).not.toMatch(/alert\(/);
    // The safe prose + safe link survive.
    expect(clean).toContain("inline event handler that must be stripped");
    expect(clean).toContain('href="https://example.com/safe"');
    expect(clean).toContain("A final clean paragraph survives intact.");
  });
});
