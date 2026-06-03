import type { IsoTimestamp } from "@interleave/core";
import { describe, expect, it } from "vitest";
import { addDays, MS_PER_DAY } from "./date-util";

describe("date-util", () => {
  it("exposes the canonical UTC day length", () => {
    expect(MS_PER_DAY).toBe(86_400_000);
  });

  it("adds positive, fractional, zero, and negative day offsets", () => {
    const start = "2026-06-03T12:00:00.000Z" as IsoTimestamp;
    expect(addDays(start, 1)).toBe("2026-06-04T12:00:00.000Z");
    expect(addDays(start, 0.25)).toBe("2026-06-03T18:00:00.000Z");
    expect(addDays(start, 0)).toBe(start);
    expect(addDays(start, -2)).toBe("2026-06-01T12:00:00.000Z");
  });

  it("rejects invalid timestamp input instead of returning Invalid Date", () => {
    expect(() => addDays("not-a-date" as IsoTimestamp, 1)).toThrow(/invalid ISO timestamp/);
  });
});
