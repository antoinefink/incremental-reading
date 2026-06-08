/// <reference types="node" />

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const cssPath =
  [
    path.join(process.cwd(), "apps/web/src/review/review.css"),
    path.join(process.cwd(), "src/review/review.css"),
  ].find((candidate) => existsSync(candidate)) ?? "";
const css = readFileSync(cssPath, "utf8");

function cssBlock(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`).exec(css);
  const body = match?.groups?.body;
  if (!body) throw new Error(`Missing CSS block for ${selector}`);
  return body;
}

describe("review CSS", () => {
  it("keeps the review card container flat instead of shadowed", () => {
    const card = cssBlock(".rcard");

    expect(card).toContain("border: 1px solid var(--border);");
    expect(card).not.toMatch(/\bbox-shadow\s*:/);
  });
});
