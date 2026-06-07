/// <reference types="node" />

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const shellCssPath =
  [
    path.join(process.cwd(), "apps/web/src/shell/shell.css"),
    path.join(process.cwd(), "src/shell/shell.css"),
  ].find((candidate) => existsSync(candidate)) ?? "";
const shellCss = readFileSync(shellCssPath, "utf8");

function cssBlock(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`).exec(shellCss);
  const body = match?.groups?.body;
  if (!body) throw new Error(`Missing CSS block for ${selector}`);
  return body;
}

describe("shell styles", () => {
  it("keeps route scrolling inside the shell work area", () => {
    const page = cssBlock(".shell-page");

    expect(page).toContain("overflow-y: auto;");
    expect(page).toContain("min-height: 0;");
    expect(page).toContain("overscroll-behavior: contain;");
  });
});
