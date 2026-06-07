import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readStyles(): string {
  return readFileSync(resolve(import.meta.dirname, "styles.css"), "utf8");
}

describe("site CSS contract", () => {
  it("imports local IBM Plex fonts and canonical design tokens", () => {
    const css = readStyles();

    expect(css).toContain('@import "@fontsource/ibm-plex-sans/400.css";');
    expect(css).toContain('@import "@fontsource/ibm-plex-serif/400.css";');
    expect(css).toContain('@import "@fontsource/ibm-plex-mono/400.css";');
    expect(css).toContain('@import "../../../design/tokens.css";');
    expect(css).not.toContain("fonts.googleapis.com");
  });

  it("keeps the distillation flow linear at the tablet breakpoint", () => {
    const css = readStyles();

    expect(css).toContain("@media (max-width: 900px)");
    expect(css).toContain(".distill {\n    grid-template-columns: 1fr;\n  }");
  });
});
