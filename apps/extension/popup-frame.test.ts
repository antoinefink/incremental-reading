import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function html(file: string): string {
  return readFileSync(new URL(file, import.meta.url), "utf8");
}

function cssRule(selector: string): string {
  const css = readFileSync(new URL("./src/tokens.css", import.meta.url), "utf8");
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{(?<body>[^}]+)\\}`));
  return match?.groups?.body ?? "";
}

describe("extension popup frame styling", () => {
  it("does not draw a second rounded frame inside Chrome's native popup", () => {
    const page = cssRule(".popup-page");
    const shell = cssRule(".popup-shell");

    expect(page).toContain("background: var(--surface);");
    expect(shell).toContain("width: 100%;");
    expect(shell).toContain("border: 0;");
    expect(shell).toContain("border-radius: 0;");
    expect(shell).toContain("box-shadow: none;");
  });

  it("uses high-density brand images inside popup and options chrome", () => {
    const brandSrcset =
      'srcset="icons/icon-64.png 64w, icons/icon-128.png 128w, icons/icon-256.png 256w"';

    expect(html("./popup.html")).toContain(brandSrcset);
    expect(html("./popup.html")).toContain('sizes="26px"');

    expect(html("./options.html")).toContain(brandSrcset);
    expect(html("./options.html")).toContain('sizes="34px"');
  });
});
