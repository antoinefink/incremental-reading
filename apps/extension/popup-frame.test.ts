import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

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
});
