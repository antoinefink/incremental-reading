/**
 * AnalyticsService.computeBalance tests (T046 — the import/process balance).
 *
 * Run against a TEMPORARY, fully-migrated in-memory `better-sqlite3` DB. They pin
 * the windowed aggregation behind the balance banner:
 *  - the four weekly counts (sources/extracts/cards by `createdAt`, reviews due
 *    this week by the FORWARD `review_states.due_at` window);
 *  - items outside the 7-day window are excluded;
 *  - the imbalance judgment (`imbalanced`/`severity`) reflects the pure rule;
 *  - the factor option tunes sensitivity.
 *
 * Timestamps are seeded as local-noon instants so the calendar-day window is
 * exact and timezone-independent.
 */

import type { ElementId, IsoTimestamp } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { cards, elements, reviewStates } from "@interleave/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AnalyticsService } from "./analytics-query";
import { ElementRepository } from "./element-repository";
import { createInMemoryDb } from "./test-db";

let handle: DbHandle;

/** A local-noon ISO instant `daysAgo` days before `asOf` (stable calendar day). */
function localNoon(asOf: Date, daysAgo: number): IsoTimestamp {
  const d = new Date(asOf.getFullYear(), asOf.getMonth(), asOf.getDate() - daysAgo, 12, 0, 0, 0);
  return d.toISOString() as IsoTimestamp;
}

/** Insert an element of `type` with an explicit `createdAt`. */
function seedElement(
  handle: DbHandle,
  type: "source" | "extract" | "card",
  createdAt: IsoTimestamp,
): ElementId {
  const repo = new ElementRepository(handle.db);
  const el = repo.create({
    type,
    status: "active",
    stage: type === "source" ? "raw_source" : type === "extract" ? "raw_extract" : "active_card",
    priority: 0.5,
    title: type,
  });
  handle.db
    .update(elements)
    .set({ createdAt, updatedAt: createdAt })
    .where(eq(elements.id, el.id))
    .run();
  if (type === "card") {
    handle.db.insert(cards).values({ elementId: el.id, kind: "qa" }).run();
  }
  return el.id;
}

/** Seed a card with a due review_states row at `dueAt`. */
function seedDueCard(handle: DbHandle, createdAt: IsoTimestamp, dueAt: IsoTimestamp): ElementId {
  const id = seedElement(handle, "card", createdAt);
  handle.db.insert(reviewStates).values({ elementId: id, fsrsState: "review", dueAt }).run();
  return id;
}

beforeEach(() => {
  handle = createInMemoryDb();
});

afterEach(() => {
  handle.sqlite.close();
});

describe("AnalyticsService.computeBalance (T046)", () => {
  it("counts the four weekly numbers and flags an imbalanced week", () => {
    const asOf = new Date(2026, 4, 30, 18, 0, 0); // local 2026-05-30 18:00
    const asOfIso = asOf.toISOString() as IsoTimestamp;

    // 8 sources imported this week; only 2 extracts + 1 card produced.
    for (let i = 0; i < 8; i++) seedElement(handle, "source", localNoon(asOf, i % 7));
    seedElement(handle, "extract", localNoon(asOf, 1));
    seedElement(handle, "extract", localNoon(asOf, 2));
    seedElement(handle, "card", localNoon(asOf, 0));

    // One card due 3 days from now (within the forward week), one due in 20 days (out).
    const future3 = new Date(asOf.getTime() + 3 * 86_400_000).toISOString() as IsoTimestamp;
    const future20 = new Date(asOf.getTime() + 20 * 86_400_000).toISOString() as IsoTimestamp;
    seedDueCard(handle, localNoon(asOf, 1), future3);
    seedDueCard(handle, localNoon(asOf, 1), future20);

    const b = new AnalyticsService(handle.db).computeBalance(asOfIso);

    expect(b.windowDays).toBe(7);
    expect(b.sourcesImported).toBe(8);
    expect(b.extractsCreated).toBe(2);
    // 3 cards created total (1 plain + 2 due cards), all in-window.
    expect(b.cardsCreated).toBe(3);
    // Only the card due in 3 days counts; the one due in 20 days is outside the week.
    expect(b.reviewsDueThisWeek).toBe(1);

    // 8 imports vs 5 output (2 extracts + 3 cards): ratio 1.6 ≥ factor 1.5 → warn.
    expect(b.imbalanced).toBe(true);
    expect(b.severity).toBe("warn");
  });

  it("stays ok on a balanced week (processing keeps pace with imports)", () => {
    const asOf = new Date(2026, 4, 30, 18, 0, 0);
    const asOfIso = asOf.toISOString() as IsoTimestamp;

    for (let i = 0; i < 4; i++) seedElement(handle, "source", localNoon(asOf, i));
    for (let i = 0; i < 4; i++) seedElement(handle, "extract", localNoon(asOf, i));
    for (let i = 0; i < 4; i++) seedElement(handle, "card", localNoon(asOf, i));

    const b = new AnalyticsService(handle.db).computeBalance(asOfIso);
    expect(b.sourcesImported).toBe(4);
    expect(b.extractsCreated).toBe(4);
    expect(b.cardsCreated).toBe(4);
    expect(b.imbalanced).toBe(false);
    expect(b.severity).toBe("ok");
  });

  it("excludes imports created outside the 7-day window", () => {
    const asOf = new Date(2026, 4, 30, 18, 0, 0);
    const asOfIso = asOf.toISOString() as IsoTimestamp;

    // 6 days ago = in-window; 7 days ago = the 8th day = out.
    seedElement(handle, "source", localNoon(asOf, 6));
    seedElement(handle, "source", localNoon(asOf, 7));

    const b = new AnalyticsService(handle.db).computeBalance(asOfIso);
    expect(b.sourcesImported).toBe(1);
  });

  it("escalates to danger on a high-import zero-output week and respects the factor", () => {
    const asOf = new Date(2026, 4, 30, 18, 0, 0);
    const asOfIso = asOf.toISOString() as IsoTimestamp;

    for (let i = 0; i < 12; i++) seedElement(handle, "source", localNoon(asOf, i % 7));

    const svc = new AnalyticsService(handle.db);
    // 12 imports, 0 output → danger.
    expect(svc.computeBalance(asOfIso).severity).toBe("danger");
    // A very high factor still can't push a 12-import / 0-output week below alarm.
    expect(svc.computeBalance(asOfIso, { factor: 5 }).imbalanced).toBe(true);
  });

  it("returns an ok/zero snapshot on an empty database", () => {
    const asOfIso = new Date(2026, 4, 30, 18, 0, 0).toISOString() as IsoTimestamp;
    const b = new AnalyticsService(handle.db).computeBalance(asOfIso);
    expect(b.sourcesImported).toBe(0);
    expect(b.extractsCreated).toBe(0);
    expect(b.cardsCreated).toBe(0);
    expect(b.reviewsDueThisWeek).toBe(0);
    expect(b.imbalanced).toBe(false);
    expect(b.severity).toBe("ok");
  });
});
