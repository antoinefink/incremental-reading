import { describe, expect, it } from "vitest";
import { formatDifficulty, formatStability } from "./formatFsrs";

describe("formatStability", () => {
  it("truncates the raw FSRS double to one decimal under 10 days", () => {
    // The exact value from the screenshots that overflowed the box.
    expect(formatStability(4.88681033)).toBe("4.9");
    expect(formatStability(0.4)).toBe("0.4");
    expect(formatStability(9.94)).toBe("9.9");
  });

  it("drops a trailing .0 so whole-day values read cleanly", () => {
    expect(formatStability(4)).toBe("4");
    expect(formatStability(4.0001)).toBe("4");
    expect(formatStability(9.96)).toBe("10"); // rounds up across the boundary
  });

  it("shows a whole number at 10+ days where the fractional day is noise", () => {
    expect(formatStability(10)).toBe("10");
    expect(formatStability(12.34)).toBe("12");
    expect(formatStability(364.7)).toBe("365");
  });

  it("clamps non-positive / non-finite input to 0", () => {
    expect(formatStability(0)).toBe("0");
    expect(formatStability(-3)).toBe("0");
    expect(formatStability(Number.NaN)).toBe("0");
    expect(formatStability(Number.POSITIVE_INFINITY)).toBe("0");
  });

  it("never returns a string longer than a handful of characters", () => {
    for (const v of [4.88681033, 7.37018264, 0.123456789, 999.99999]) {
      expect(formatStability(v).length).toBeLessThanOrEqual(4);
    }
  });
});

describe("formatDifficulty", () => {
  it("truncates the raw FSRS double to one decimal", () => {
    expect(formatDifficulty(7.37018264)).toBe("7.4");
    expect(formatDifficulty(1.25)).toBe("1.3");
  });

  it("drops a trailing .0 and clamps to the 0–10 scale", () => {
    expect(formatDifficulty(5)).toBe("5");
    expect(formatDifficulty(10)).toBe("10");
    expect(formatDifficulty(10.0001)).toBe("10");
    expect(formatDifficulty(12)).toBe("10"); // clamped
  });

  it("clamps non-positive / non-finite input to 0", () => {
    expect(formatDifficulty(0)).toBe("0");
    expect(formatDifficulty(-1)).toBe("0");
    expect(formatDifficulty(Number.NaN)).toBe("0");
  });
});
