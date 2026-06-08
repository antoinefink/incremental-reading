/// <reference types="node" />

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const refBlockCssPath =
  [
    path.join(process.cwd(), "apps/web/src/components/ref-block.css"),
    path.join(process.cwd(), "src/components/ref-block.css"),
  ].find((candidate) => existsSync(candidate)) ?? "";
const refBlockCss = readFileSync(refBlockCssPath, "utf8");

function cssBlock(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`).exec(refBlockCss);
  const body = match?.groups?.body;
  if (!body) throw new Error(`Missing CSS block for ${selector}`);
  return body;
}

describe("ref block CSS", () => {
  it("keeps source context quotes block-level with modest tokenized top spacing", () => {
    const quote = cssBlock(".refblock__quote");

    expect(quote).toContain("display: block;");
    expect(quote).toContain("margin-top: var(--s-2, 6px);");
  });
});
