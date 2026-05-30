/**
 * Queue jitter tests (T029).
 *
 * The daily-queue order is deterministic in the read; the renderer adds a STABLE,
 * seeded ±10–20% shuffle so the user isn't trapped in one topic. These assert the
 * two properties that matter: it is STABLE within a seed (re-running never
 * reshuffles), and it VARIES across days (a different seed reorders). It must never
 * drop or duplicate a row.
 */

import { describe, expect, it } from "vitest";
import { daySeed, jitterOrder } from "./jitter";

const rows = Array.from({ length: 12 }, (_, i) => ({ id: `row-${i}` }));

describe("jitterOrder", () => {
  it("is stable for a fixed seed (re-renders never reshuffle)", () => {
    const a = jitterOrder(rows, { seed: "2026-05-30" });
    const b = jitterOrder(rows, { seed: "2026-05-30" });
    expect(a.map((r) => r.id)).toEqual(b.map((r) => r.id));
  });

  it("preserves the full set (no dropped or duplicated rows)", () => {
    const out = jitterOrder(rows, { seed: "2026-05-30" });
    expect(out).toHaveLength(rows.length);
    expect(new Set(out.map((r) => r.id)).size).toBe(rows.length);
  });

  it("varies the order across days (different seeds)", () => {
    // A larger list makes an adjacent swap statistically certain between two days,
    // while the small jitter still preserves the gross priority order.
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `row-${i}` }));
    const monday = jitterOrder(many, { seed: "2026-05-30" }).map((r) => r.id);
    const tuesday = jitterOrder(many, { seed: "2026-05-31" }).map((r) => r.id);
    expect(monday).not.toEqual(tuesday);
  });

  it("does not scramble a strong priority gap (small jitter amount)", () => {
    // With the default 0.15 amount the offset is bounded to ~±1 rank, so the
    // top-ranked row stays near the front — it never sinks toward the middle.
    const out = jitterOrder(rows, { seed: "x", amount: 0.15 });
    const firstIndex = out.findIndex((r) => r.id === "row-0");
    expect(firstIndex).toBeLessThan(4);
  });

  it("daySeed is the YYYY-MM-DD prefix", () => {
    expect(daySeed(new Date("2026-05-30T18:22:00.000Z"))).toBe("2026-05-30");
  });
});
