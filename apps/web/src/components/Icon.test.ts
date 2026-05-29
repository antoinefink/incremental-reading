import { describe, expect, it } from "vitest";
import { iconNames } from "./Icon";

/**
 * Unit test (T003) — guards the icon-map wiring without rendering React, so it
 * runs in the default node Vitest environment. Keeps the `apps/web` Vitest
 * project non-empty (so `make test` always has a web test to run) and protects
 * the load-bearing scheduler icons + the seven nav route icons from regressing.
 */
describe("Icon map", () => {
  it("includes the load-bearing scheduler icons (FSRS vs attention)", () => {
    expect(iconNames).toContain("brain");
    expect(iconNames).toContain("gauge");
  });

  it("covers every icon used by the sidebar nav", () => {
    for (const name of ["layers", "queue", "inbox", "review", "search", "settings"]) {
      expect(iconNames).toContain(name);
    }
  });

  it("has no duplicate names", () => {
    expect(new Set(iconNames).size).toBe(iconNames.length);
  });
});
