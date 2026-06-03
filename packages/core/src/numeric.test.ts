import { describe, expect, it } from "vitest";
import { clamp01 } from "./numeric";

describe("clamp01", () => {
  it("keeps values inside the unit interval unchanged", () => {
    expect(clamp01(0)).toBe(0);
    expect(clamp01(0.4)).toBe(0.4);
    expect(clamp01(1)).toBe(1);
  });

  it("clamps values outside the unit interval", () => {
    expect(clamp01(-0.01)).toBe(0);
    expect(clamp01(-Infinity)).toBe(0);
    expect(clamp01(1.01)).toBe(1);
    expect(clamp01(Infinity)).toBe(1);
  });

  it("treats NaN as zero", () => {
    expect(clamp01(Number.NaN)).toBe(0);
  });
});
