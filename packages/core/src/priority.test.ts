import { describe, expect, it } from "vitest";
import {
  clamp01,
  DEFAULT_PRIORITY,
  isPriorityLabel,
  PRIORITY_LABEL_VALUE,
  PRIORITY_LABELS,
  type PriorityLabel,
  priorityFromLabel,
  priorityToLabel,
} from "./index";

/**
 * Priority conversion tests (T005).
 *
 * Priority is stored numerically and surfaced as A/B/C/D. The numeric store and
 * the label UI must never drift, so we test BOTH directions, the round-trip, the
 * bucket boundaries, and out-of-range clamping.
 */
describe("priorityFromLabel (label → number)", () => {
  it("maps each label to its representative numeric value", () => {
    expect(priorityFromLabel("A")).toBe(0.875);
    expect(priorityFromLabel("B")).toBe(0.625);
    expect(priorityFromLabel("C")).toBe(0.375);
    expect(priorityFromLabel("D")).toBe(0.125);
  });

  it("agrees with the PRIORITY_LABEL_VALUE table for every label", () => {
    for (const label of PRIORITY_LABELS) {
      expect(priorityFromLabel(label)).toBe(PRIORITY_LABEL_VALUE[label]);
    }
  });

  it("produces values that all sit in the unit interval", () => {
    for (const label of PRIORITY_LABELS) {
      const value = priorityFromLabel(label);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});

describe("priorityToLabel (number → label)", () => {
  it("buckets representative band midpoints to the right label", () => {
    expect(priorityToLabel(0.9)).toBe("A");
    expect(priorityToLabel(0.6)).toBe("B");
    expect(priorityToLabel(0.4)).toBe("C");
    expect(priorityToLabel(0.1)).toBe("D");
  });

  it("treats the lower threshold of each band as inclusive", () => {
    expect(priorityToLabel(0.75)).toBe("A");
    expect(priorityToLabel(0.5)).toBe("B");
    expect(priorityToLabel(0.25)).toBe("C");
    expect(priorityToLabel(0)).toBe("D");
  });

  it("clamps and labels out-of-range values instead of returning undefined", () => {
    expect(priorityToLabel(1.5)).toBe("A");
    expect(priorityToLabel(-0.5)).toBe("D");
    expect(priorityToLabel(Number.NaN)).toBe("D");
  });
});

describe("priority round-trip", () => {
  it("label → number → label is stable for every label", () => {
    for (const label of PRIORITY_LABELS) {
      const roundTripped: PriorityLabel = priorityToLabel(priorityFromLabel(label));
      expect(roundTripped).toBe(label);
    }
  });
});

describe("isPriorityLabel", () => {
  it("accepts the four canonical labels and rejects anything else", () => {
    expect(isPriorityLabel("A")).toBe(true);
    expect(isPriorityLabel("D")).toBe(true);
    expect(isPriorityLabel("E")).toBe(false);
    expect(isPriorityLabel("a")).toBe(false);
    expect(isPriorityLabel(0.875)).toBe(false);
    expect(isPriorityLabel(null)).toBe(false);
  });
});

describe("DEFAULT_PRIORITY", () => {
  it("defaults freshly imported material to the C band", () => {
    expect(DEFAULT_PRIORITY).toBe(PRIORITY_LABEL_VALUE.C);
    expect(priorityToLabel(DEFAULT_PRIORITY)).toBe("C");
  });
});

describe("clamp01", () => {
  it("passes through values already in range", () => {
    expect(clamp01(0)).toBe(0);
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(1)).toBe(1);
  });

  it("clamps below 0 and above 1, and maps NaN to 0", () => {
    expect(clamp01(-2)).toBe(0);
    expect(clamp01(42)).toBe(1);
    expect(clamp01(Number.NaN)).toBe(0);
  });
});
