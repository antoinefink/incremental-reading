/// <reference types="node" />

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const stylesPath =
  [
    path.join(process.cwd(), "apps/web/src/styles.css"),
    path.join(process.cwd(), "src/styles.css"),
  ].find((candidate) => existsSync(candidate)) ?? "";
const stylesCss = readFileSync(stylesPath, "utf8");

function cssBlock(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`).exec(stylesCss);
  const body = match?.groups?.body;
  if (!body) throw new Error(`Missing CSS block for ${selector}`);
  return body;
}

function cssRule(selector: string): string {
  return `${selector} {${cssBlock(selector)}}`;
}

function cssBetween(startToken: string, endToken: string): string {
  const start = stylesCss.indexOf(startToken);
  const end = stylesCss.indexOf(endToken, start);
  if (start === -1 || end === -1) throw new Error(`Missing CSS range ${startToken} → ${endToken}`);
  return stylesCss.slice(start, end);
}

describe("global styles", () => {
  it("locks scrolling to the app shell instead of the document body", () => {
    const rootFrame = cssBlock("html,\nbody,\n#root");

    expect(rootFrame).toContain("height: 100%;");
    expect(rootFrame).toContain("overflow: hidden;");
    expect(rootFrame).toContain("overscroll-behavior: none;");
  });

  it("keeps native date picker icons visible in dark mode", () => {
    const dateInput = cssBlock('input[type="date"]');
    const darkDateInput = cssBlock('[data-theme="dark"] input[type="date"]');
    const indicator = cssBlock('input[type="date"]::-webkit-calendar-picker-indicator');

    expect(dateInput).toContain("color-scheme: light;");
    expect(darkDateInput).toContain("color-scheme: dark;");
    expect(indicator).toContain("cursor: pointer;");
    expect(indicator).toContain("opacity: 0.72;");
  });

  it("sets pointer cursors for enabled button controls and disabled cursors for inactive ones", () => {
    const cursorLayer = cssBetween("@layer base {", "/* Native date inputs");
    const enabledButton = cssBlock(':where(button:not(:disabled):not([aria-disabled="true"]))');
    const enabledRoleButton = cssBlock(':where([role="button"]:not([aria-disabled="true"]))');
    const disabledButton = cssBlock(":where(button:disabled)");
    const ariaDisabledButton = cssBlock(':where(button[aria-disabled="true"])');
    const disabledRoleButton = cssBlock(':where([role="button"][aria-disabled="true"])');

    expect(cursorLayer).toContain(':where(button:not(:disabled):not([aria-disabled="true"]))');
    expect(cursorLayer).toContain(':where([role="button"]:not([aria-disabled="true"]))');
    expect(cursorLayer).toContain(":where(button:disabled)");
    expect(cursorLayer).toContain(':where(button[aria-disabled="true"])');
    expect(cursorLayer).toContain(':where([role="button"][aria-disabled="true"])');
    expect(enabledButton).toContain("cursor: pointer;");
    expect(enabledRoleButton).toContain("cursor: pointer;");
    expect(disabledButton).toContain("cursor: not-allowed;");
    expect(ariaDisabledButton).toContain("cursor: not-allowed;");
    expect(disabledRoleButton).toContain("cursor: not-allowed;");
  });

  it("applies the button cursor baseline to enabled and inactive controls", () => {
    const style = document.createElement("style");
    style.textContent = `
      ${cssRule(':where(button:not(:disabled):not([aria-disabled="true"]))')}
      ${cssRule(':where([role="button"]:not([aria-disabled="true"]))')}
      ${cssRule(":where(button:disabled)")}
      ${cssRule(':where(button[aria-disabled="true"])')}
      ${cssRule(':where([role="button"][aria-disabled="true"])')}
    `;
    document.head.append(style);
    const fixture = document.createElement("div");

    const enabledButton = document.createElement("button");
    const disabledButton = document.createElement("button");
    disabledButton.disabled = true;
    const ariaDisabledButton = document.createElement("button");
    ariaDisabledButton.setAttribute("aria-disabled", "true");
    const roleButton = document.createElement("div");
    roleButton.setAttribute("role", "button");
    const disabledRoleButton = document.createElement("div");
    disabledRoleButton.setAttribute("role", "button");
    disabledRoleButton.setAttribute("aria-disabled", "true");

    fixture.append(
      enabledButton,
      disabledButton,
      ariaDisabledButton,
      roleButton,
      disabledRoleButton,
    );
    document.body.append(fixture);

    expect(getComputedStyle(enabledButton).cursor).toBe("pointer");
    expect(getComputedStyle(roleButton).cursor).toBe("pointer");
    expect(getComputedStyle(disabledButton).cursor).toBe("not-allowed");
    expect(getComputedStyle(ariaDisabledButton).cursor).toBe("not-allowed");
    expect(getComputedStyle(disabledRoleButton).cursor).toBe("not-allowed");

    style.remove();
    fixture.remove();
  });
});
