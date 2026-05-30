/**
 * Import/process balance rule tests (T046) — the pure judgment.
 *
 * `judgeBalance` is the single tunable decision behind the balance banner. These
 * pin the contract the banner + the domain `computeBalance` both depend on:
 *  - a quiet week (below the floor) never alarms, however lopsided;
 *  - imports above the floor that exceed processed output by the factor → `warn`;
 *  - a severe gap (≥ factor × DANGER_MULTIPLIER, or imports with zero output) → `danger`;
 *  - a balanced/productive week → `ok`;
 *  - the factor is clamped (a malformed setting can't disable/over-trigger it).
 */

import { describe, expect, it } from "vitest";
import {
  clampFactor,
  DANGER_MULTIPLIER,
  DEFAULT_IMPORT_BALANCE_FACTOR,
  IMPORT_BALANCE_FACTOR_MAX,
  IMPORT_BALANCE_FACTOR_MIN,
  IMPORT_BALANCE_FLOOR,
  judgeBalance,
} from "./balance";

describe("judgeBalance (T046)", () => {
  it("never alarms on a quiet week below the import floor, however lopsided", () => {
    // 4 imports, 0 output: a high ratio, but below the floor of 5 → ok.
    const j = judgeBalance({ sourcesImported: 4, extractsCreated: 0, cardsCreated: 0 });
    expect(j.imbalanced).toBe(false);
    expect(j.severity).toBe("ok");
  });

  it("warns when imports exceed processed output by the factor (above the floor)", () => {
    // 12 imports vs 4 output → ratio 3; warn threshold = 4 × 1.5 = 6; danger = 12.
    // 12 >= 12 hits danger exactly, so use 10 imports for a clean warn (10 >= 6, < 12).
    const j = judgeBalance({ sourcesImported: 10, extractsCreated: 2, cardsCreated: 2 });
    expect(j.severity).toBe("warn");
    expect(j.imbalanced).toBe(true);
    expect(j.processedOutput).toBe(4);
  });

  it("escalates to danger when imports exceed processed output by factor × DANGER_MULTIPLIER", () => {
    // 4 output → danger threshold = 4 × 1.5 × 2 = 12; 12 imports → danger.
    const j = judgeBalance({ sourcesImported: 12, extractsCreated: 2, cardsCreated: 2 });
    expect(j.severity).toBe("danger");
    expect(j.imbalanced).toBe(true);
  });

  it("flags zero-output weeks above the floor: warn near the floor, danger at 2× the floor", () => {
    const warn = judgeBalance({ sourcesImported: 6, extractsCreated: 0, cardsCreated: 0 });
    expect(warn.severity).toBe("warn");
    expect(warn.imbalanced).toBe(true);

    const danger = judgeBalance({
      sourcesImported: IMPORT_BALANCE_FLOOR * DANGER_MULTIPLIER,
      extractsCreated: 0,
      cardsCreated: 0,
    });
    expect(danger.severity).toBe("danger");
  });

  it("stays ok on a balanced/productive week (output keeps pace with imports)", () => {
    // 8 imports vs 10 output → ratio < 1; below the warn threshold → ok.
    const j = judgeBalance({ sourcesImported: 8, extractsCreated: 6, cardsCreated: 4 });
    expect(j.imbalanced).toBe(false);
    expect(j.severity).toBe("ok");
  });

  it("respects the boundary either side of the warn threshold", () => {
    // output = 4 → warn threshold = 6. 5 imports (≥ floor, < 6) → ok; 6 → warn.
    const below = judgeBalance({ sourcesImported: 5, extractsCreated: 2, cardsCreated: 2 });
    expect(below.severity).toBe("ok");
    const at = judgeBalance({ sourcesImported: 6, extractsCreated: 2, cardsCreated: 2 });
    expect(at.severity).toBe("warn");
  });

  it("a higher factor makes the warning less sensitive", () => {
    const counts = { sourcesImported: 7, extractsCreated: 3, cardsCreated: 0 };
    // factor 1.5 → threshold 4.5 → 7 ≥ 4.5 → warn.
    expect(judgeBalance(counts, 1.5).severity).toBe("warn");
    // factor 3 → threshold 9 → 7 < 9 → ok.
    expect(judgeBalance(counts, 3).severity).toBe("ok");
  });

  it("clamps a malformed factor into the documented bounds (can't disable the rule)", () => {
    expect(clampFactor(Number.NaN)).toBe(DEFAULT_IMPORT_BALANCE_FACTOR);
    expect(clampFactor(0)).toBe(IMPORT_BALANCE_FACTOR_MIN);
    expect(clampFactor(1000)).toBe(IMPORT_BALANCE_FACTOR_MAX);
    expect(clampFactor(2)).toBe(2);
    // An absurdly large factor still can't push a 0-output week above the floor to ok.
    const j = judgeBalance({ sourcesImported: 20, extractsCreated: 0, cardsCreated: 0 }, 999);
    expect(j.imbalanced).toBe(true);
  });
});
