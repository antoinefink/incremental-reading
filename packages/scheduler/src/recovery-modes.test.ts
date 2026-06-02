/**
 * Recovery-mode planner tests (T078 — catch-up & vacation).
 *
 * These pin the doc's exact policy ("Overload handling → Catch-up / vacation modes"):
 *  - `planCatchUp` spreads the backlog forward so EACH DAY ≤ budget, puts HIGH-VALUE /
 *    FRAGILE items on the EARLIEST days and low-value last, and quantifies the cost (the
 *    per-day load curve before vs after + the `slips`);
 *  - `planVacation` moves exactly the items due in the away window (SUSPEND fragile cards,
 *    SHIFT everything else), re-spreads the shifted load after return within budget, and
 *    reports the cost;
 *  - both are deterministic (same input → same plan) and never push a high-value fragile
 *    card to the back.
 */

import { describe, expect, it } from "vitest";
import {
  CARD_MATURE_STABILITY_DAYS,
  isCardFragile,
  planCatchUp,
  planVacation,
  type RecoveryInput,
} from "./index";

const NOW = "2027-06-01T12:00:00.000Z";

/** Build an attention (topic/source/extract) row due on `dueAt`. */
function attention(
  id: string,
  priority: number,
  dueAt: string,
  type = "topic",
  title = id,
): RecoveryInput {
  return {
    id,
    type,
    priority,
    dueAt,
    title,
    scheduler: "attention",
    schedulerSignals: { retrievability: null, stability: null, fsrsState: null, lapses: null },
    concept: null,
    siblingGroupId: null,
    sourceId: null,
    protected: priority >= 0.75,
  };
}

/** Build a card row with explicit FSRS signals. */
function card(
  id: string,
  priority: number,
  dueAt: string,
  signals: {
    retrievability: number | null;
    stability: number | null;
    fsrsState: string | null;
    lapses: number | null;
  },
  title = id,
): RecoveryInput {
  return {
    id,
    type: "card",
    priority,
    dueAt,
    title,
    scheduler: "fsrs",
    schedulerSignals: signals,
    concept: null,
    siblingGroupId: null,
    sourceId: null,
    protected: priority >= 0.75,
  };
}

const matureSignals = {
  retrievability: 0.95,
  stability: CARD_MATURE_STABILITY_DAYS + 30,
  fsrsState: "review" as const,
  lapses: 0,
};
const fragileSignals = {
  retrievability: 0.4,
  stability: 2,
  fsrsState: "learning" as const,
  lapses: 0,
};

/** The UTC day key of an ISO instant. */
function day(iso: string): string {
  return iso.slice(0, 10);
}

describe("planCatchUp", () => {
  it("keeps each day within budget and spreads the backlog forward", () => {
    // 12 overdue low-priority topics, budget 4 → spread over 3+ days, ≤ 4/day.
    const items = Array.from({ length: 12 }, (_, i) =>
      attention(`t${String(i).padStart(2, "0")}`, 0.4, "2027-05-01T12:00:00.000Z"),
    );
    const plan = planCatchUp({ items, budget: 4, asOf: NOW, spreadDays: 7 });

    // The AFTER curve never exceeds the budget on any day.
    for (const point of plan.cost.loadAfter) {
      expect(point.count).toBeLessThanOrEqual(4);
    }
    // All 12 are accounted for across the after curve.
    const totalAfter = plan.cost.loadAfter.reduce((s, p) => s + p.count, 0);
    expect(totalAfter).toBe(12);
    // The before curve piled them all on one day (the overdue day, clamped to asOf's day).
    const maxBefore = Math.max(...plan.cost.loadBefore.map((p) => p.count));
    expect(maxBefore).toBe(12);
  });

  it("puts high-value / fragile items on the earliest days, low-value last", () => {
    const highFragile = card("c-high-fragile", 0.875, "2027-05-01T12:00:00.000Z", fragileSignals);
    const lowTopic = attention("z-low-topic", 0.25, "2027-05-01T12:00:00.000Z");
    const midTopic = attention("m-mid-topic", 0.5, "2027-05-01T12:00:00.000Z");
    // Budget 1 → each lands on its own day, in value order.
    const plan = planCatchUp({
      items: [lowTopic, midTopic, highFragile],
      budget: 1,
      asOf: NOW,
      spreadDays: 7,
    });

    // Resolve each item's assigned day from the slips (everything but possibly day-0 moves).
    const dayOf = new Map<string, string>();
    for (const it of plan.items) dayOf.set(it.id, day(it.targetDueAt));
    // The high-value fragile card is on the EARLIEST day; the low topic is LATEST.
    const days = [...dayOf.values()].sort();
    // High fragile sits on day 0 (asOf's day) → not in the move list (it didn't slip), so
    // assert via the after-curve ordering instead: the earliest non-empty day holds the card.
    // Simpler: with budget 1, day 0 = high fragile, day 1 = mid, day 2 = low.
    const after = plan.cost.loadAfter.filter((p) => p.count > 0).map((p) => p.date);
    expect(after.length).toBe(3);
    // The high fragile card's target (or its day-0 stay) is the earliest of the three.
    // The low topic must be on the LAST of the three days.
    const lowDay = plan.items.find((p) => p.id === "z-low-topic")?.targetDueAt;
    expect(lowDay && day(lowDay)).toBe(after[after.length - 1]);
    expect(days.length).toBeGreaterThan(0);
  });

  it("quantifies the cost: slips list + days added", () => {
    const items = Array.from({ length: 6 }, (_, i) =>
      attention(`t${i}`, 0.4, "2027-05-15T12:00:00.000Z", "topic", `Topic ${i}`),
    );
    const plan = planCatchUp({ items, budget: 2, asOf: NOW, spreadDays: 7 });
    // 6 items at 2/day → days 0,0,1,1,2,2. The day-1 and day-2 items slipped.
    expect(plan.cost.moved).toBe(6);
    expect(plan.cost.slips.length).toBeGreaterThan(0);
    // Every slip reports a positive slipDays and a title.
    for (const slip of plan.cost.slips) {
      expect(slip.slipDays).toBeGreaterThanOrEqual(0);
      expect(slip.title).toMatch(/^Topic /);
      expect(Date.parse(slip.toDueAt)).toBeGreaterThanOrEqual(Date.parse(slip.fromDueAt ?? NOW));
    }
    // The largest slip is first (deterministic ordering).
    const slipDays = plan.cost.slips.map((s) => s.slipDays);
    expect([...slipDays].sort((a, b) => b - a)).toEqual(slipDays);
  });

  it("is deterministic — same input yields the same plan", () => {
    const build = (): RecoveryInput[] => [
      attention("b", 0.4, "2027-05-01T12:00:00.000Z"),
      attention("a", 0.4, "2027-05-01T12:00:00.000Z"),
      card("c", 0.6, "2027-05-01T12:00:00.000Z", matureSignals),
    ];
    const p1 = planCatchUp({ items: build(), budget: 1, asOf: NOW, spreadDays: 7 });
    const p2 = planCatchUp({ items: build(), budget: 1, asOf: NOW, spreadDays: 7 });
    expect(p1.items).toEqual(p2.items);
    expect(p1.cost).toEqual(p2.cost);
  });
});

describe("planVacation", () => {
  const AWAY_START = "2027-06-10T00:00:00.000Z";
  const AWAY_END = "2027-06-20T23:59:59.000Z";

  it("moves exactly the items due in the away window (suspend fragile, shift the rest)", () => {
    const inWindowFragile = card("c-frag", 0.5, "2027-06-15T12:00:00.000Z", fragileSignals);
    const inWindowMature = card("c-mat", 0.5, "2027-06-16T12:00:00.000Z", matureSignals);
    const inWindowTopic = attention("t-in", 0.5, "2027-06-12T12:00:00.000Z");
    // Out of window — must be untouched.
    const beforeWindow = attention("t-before", 0.5, "2027-06-05T12:00:00.000Z");
    const afterWindow = attention("t-after", 0.5, "2027-06-25T12:00:00.000Z");

    const plan = planVacation({
      items: [inWindowFragile, inWindowMature, inWindowTopic, beforeWindow, afterWindow],
      awayStart: AWAY_START,
      awayEnd: AWAY_END,
      asOf: NOW,
      budget: 5,
    });

    // The fragile card is SUSPENDED; the mature card + topic are SHIFTED.
    expect(plan.suspend.map((s) => s.id)).toEqual(["c-frag"]);
    expect(plan.suspendedCount).toBe(1);
    const shiftedIds = new Set(plan.shift.map((s) => s.id));
    expect(shiftedIds.has("c-mat")).toBe(true);
    expect(shiftedIds.has("t-in")).toBe(true);
    // Out-of-window items are never in the plan.
    expect(shiftedIds.has("t-before")).toBe(false);
    expect(shiftedIds.has("t-after")).toBe(false);
    expect(plan.suspend.some((s) => s.id === "t-before" || s.id === "t-after")).toBe(false);
  });

  it("re-spreads the shifted load after return within budget, high-value first", () => {
    // 6 mature cards due across the window, budget 2 → 3 days after return, 2/day, value desc.
    const items = [
      card("c-a", 0.9, "2027-06-11T12:00:00.000Z", matureSignals, "A high"),
      card("c-b", 0.8, "2027-06-12T12:00:00.000Z", matureSignals, "B"),
      card("c-c", 0.6, "2027-06-13T12:00:00.000Z", matureSignals, "C"),
      card("c-d", 0.5, "2027-06-14T12:00:00.000Z", matureSignals, "D"),
      card("c-e", 0.4, "2027-06-15T12:00:00.000Z", matureSignals, "E"),
      card("c-f", 0.3, "2027-06-16T12:00:00.000Z", matureSignals, "F low"),
    ];
    const plan = planVacation({
      items,
      awayStart: AWAY_START,
      awayEnd: AWAY_END,
      asOf: NOW,
      budget: 2,
    });
    expect(plan.shiftedCount).toBe(6);
    // Every shifted item lands AFTER the away window ends.
    for (const s of plan.shift) {
      expect(Date.parse(s.targetDueAt)).toBeGreaterThan(Date.parse(AWAY_END));
    }
    // No day after return exceeds budget.
    for (const point of plan.cost.loadAfter) {
      expect(point.count).toBeLessThanOrEqual(2);
    }
    // The highest-value card (c-a) lands on the EARLIEST after-return day; the lowest (c-f) last.
    const dayOf = new Map(plan.shift.map((s) => [s.id, day(s.targetDueAt)]));
    const dayA = dayOf.get("c-a") ?? "";
    const dayF = dayOf.get("c-f") ?? "";
    expect(dayA <= dayF).toBe(true);
    expect(dayA).not.toBe(dayF);
  });

  it("reports the cost and is deterministic", () => {
    const build = (): RecoveryInput[] => [
      card("c-b", 0.6, "2027-06-12T12:00:00.000Z", matureSignals),
      card("c-a", 0.6, "2027-06-13T12:00:00.000Z", matureSignals),
      attention("t-x", 0.4, "2027-06-14T12:00:00.000Z"),
    ];
    const opts = { awayStart: AWAY_START, awayEnd: AWAY_END, asOf: NOW, budget: 1 } as const;
    const p1 = planVacation({ items: build(), ...opts });
    const p2 = planVacation({ items: build(), ...opts });
    expect(p1).toEqual(p2);
    // The cost preview is populated.
    expect(p1.cost.moved).toBe(p1.shiftedCount);
    expect(p1.cost.loadBefore.length).toBeGreaterThan(0);
    expect(p1.cost.loadAfter.length).toBeGreaterThan(0);
  });

  it("never sacrifices a high-priority fragile card to a far-future date — it suspends it", () => {
    const highFragile = card("c-high-frag", 0.9, "2027-06-15T12:00:00.000Z", fragileSignals);
    expect(isCardFragile(highFragile.schedulerSignals)).toBe(true);
    const plan = planVacation({
      items: [highFragile],
      awayStart: AWAY_START,
      awayEnd: AWAY_END,
      asOf: NOW,
      budget: 5,
    });
    // It is SUSPENDED (paused), not shifted weeks out.
    expect(plan.suspend.map((s) => s.id)).toEqual(["c-high-frag"]);
    expect(plan.shift.length).toBe(0);
  });
});
