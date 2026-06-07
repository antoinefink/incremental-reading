/* @vitest-environment jsdom */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { iconNames, iconSvg, isIconName } from "./icons";
import { PIPELINE_STEPS } from "./site";

describe("iconSvg", () => {
  it("renders a known design icon as a line svg", () => {
    const svg = iconSvg("extract", 20);
    const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
    const element = parsed.querySelector("svg");

    expect(element?.getAttribute("width")).toBe("20");
    expect(element?.getAttribute("height")).toBe("20");
    expect(element?.getAttribute("stroke")).toBe("currentColor");
    expect(element?.getAttribute("stroke-width")).toBe("1.75");
    expect(parsed.querySelectorAll("path").length).toBeGreaterThan(0);
  });

  it("renders unknown icon names as harmless empty svgs", () => {
    const svg = iconSvg("not-a-real-icon", 18);
    const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");

    expect(parsed.querySelector("svg")?.getAttribute("width")).toBe("18");
    expect(parsed.querySelector("path")).toBeNull();
    expect(parsed.querySelector("circle")).toBeNull();
    expect(parsed.querySelector("rect")).toBeNull();
  });

  it("keeps every data-icon in the static page resolvable", () => {
    const html = readFileSync(resolve(import.meta.dirname, "../index.html"), "utf8");
    const parsed = new DOMParser().parseFromString(html, "text/html");
    const names = Array.from(
      parsed.querySelectorAll<HTMLElement>("[data-icon]"),
      (node) => node.dataset.icon ?? "",
    );
    const missing = names.filter((name) => !isIconName(name));

    expect(names.length).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });

  it("exports a stable typed icon name set", () => {
    expect(iconNames).toContain("brain");
    expect(iconNames).toContain("gauge");
    expect(iconNames).toContain("download");
  });

  it("does not keep unused icon definitions in the static site bundle", () => {
    const html = readFileSync(resolve(import.meta.dirname, "../index.html"), "utf8");
    const parsed = new DOMParser().parseFromString(html, "text/html");
    const staticNames = Array.from(
      parsed.querySelectorAll<HTMLElement>("[data-icon]"),
      (node) => node.dataset.icon ?? "",
    );
    const runtimeNames = PIPELINE_STEPS.map((step) => step.icon);
    const usedNames = new Set([...staticNames, ...runtimeNames]);

    expect(iconNames.filter((name) => !usedNames.has(name))).toEqual([]);
  });
});
