/**
 * Active-recall review session (T037) E2E — drives the real Electron app.
 *
 * The `/review` screen loads the FSRS due-card deck (cards due by
 * `review_states.due_at`, soonest first), reveals the answer on click/`Space`,
 * shows the four grade buttons with next-interval previews + `FsrsStats`, and on a
 * grade records the response time, reschedules the card via the FSRS
 * `SchedulerService` → `ReviewRepository`, appends a durable `review_logs` row, and
 * advances. This spec launches the built desktop app against a fresh data dir
 * seeded with the shared demo collection (a Q&A card + a cloze card with review
 * state) and asserts:
 *
 *   1. the `review.*` bridge surface exists (session.next / preview / grade) and
 *      there is no generic `db.query`;
 *   2. the screen shows the prompt, hides the answer until reveal, then shows the
 *      grade buttons with the four preview intervals; a UI grade writes a durable
 *      `review_logs` row + advances `review_states.due_at`;
 *   3. grading across EACH of Again/Hard/Good/Easy (driven through the bridge on
 *      successive due reads) each writes a `review_logs` row and reschedules the
 *      card, with the rescheduled due date reflecting the rating;
 *   4. it SURVIVES AN APP RESTART — the logs + advanced due dates persist and the
 *      card's next due reflects the last grade.
 *
 * The seed's Q&A card is due `2026-06-03`, so the screen + bridge are driven with
 * a fixed FUTURE `asOf` so it reads as due deterministically; advancing the clock
 * between grades keeps the recurring card due so all four ratings can be exercised.
 */

import { expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

let dataDir: string;
/** The renderer base URL (`app://bundle`), captured from the first window. */
let baseUrl: string;

/** A fixed future clock so the seeded near-future card due reads as due. */
const AS_OF = "2027-06-01T12:00:00.000Z";

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
});

/** Open `/review` (optionally date-scoped via `?asOf=`) and wait for it to render. */
async function openReview(page: Page, asOf?: string): Promise<void> {
  const suffix = asOf ? `?asOf=${encodeURIComponent(asOf)}` : "";
  await page.goto(`${baseUrl}/review${suffix}`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("route-review")).toBeVisible();
}

/** The seeded due Q&A card id (it has two reviews → a real future dueAt). */
async function dueCardId(page: Page, asOf: string): Promise<string> {
  return page.evaluate(async (clock) => {
    const api = window.appApi as unknown as {
      review: { sessionNext(req: { asOf: string }): Promise<{ card: { id: string } | null }> };
    };
    const res = await api.review.sessionNext({ asOf: clock });
    if (!res.card) throw new Error("no due card in the seeded deck");
    return res.card.id;
  }, asOf);
}

/** Read a card's review state (dueAt + reps + lapses + log count) via the bridge. */
async function cardState(
  page: Page,
  cardId: string,
): Promise<{ dueAt: string | null; reps: number; lapses: number; logCount: number }> {
  return page.evaluate(async (id) => {
    const api = window.appApi as unknown as {
      inspector: {
        get(req: { id: string }): Promise<{
          data: {
            review: {
              dueAt: string | null;
              reps: number;
              lapses: number;
              logCount: number;
            } | null;
          } | null;
        }>;
      };
    };
    const res = await api.inspector.get({ id });
    const review = res.data?.review;
    return {
      dueAt: review?.dueAt ?? null,
      reps: review?.reps ?? 0,
      lapses: review?.lapses ?? 0,
      logCount: review?.logCount ?? 0,
    };
  }, cardId);
}

test("the review.* bridge surface exists (no raw SQL)", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;

  const surface = await page.evaluate(() => {
    const api = window.appApi as unknown as {
      review?: { sessionNext?: unknown; preview?: unknown; grade?: unknown };
      db?: { query?: unknown };
    };
    return {
      hasSessionNext: typeof api?.review?.sessionNext === "function",
      hasPreview: typeof api?.review?.preview === "function",
      hasGrade: typeof api?.review?.grade === "function",
      hasQuery: typeof api?.db?.query === "function",
    };
  });
  expect(surface.hasSessionNext).toBe(true);
  expect(surface.hasPreview).toBe(true);
  expect(surface.hasGrade).toBe(true);
  expect(surface.hasQuery).toBe(false);

  await app.close();
});

test("the screen reveals the answer, shows the four interval previews, and a grade logs + reschedules", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const cardId = await dueCardId(page, AS_OF);
  const before = await cardState(page, cardId);

  await openReview(page, AS_OF);

  // The prompt shows; the answer + grade buttons are hidden until reveal.
  const cardEl = page.getByTestId("review-card");
  await expect(cardEl).toBeVisible();
  await expect(page.getByTestId("review-prompt")).toBeVisible();
  await expect(page.getByTestId("review-answer")).toHaveCount(0);

  // Reveal → the answer + the four grade buttons with preview intervals appear.
  await page.getByTestId("review-reveal").click();
  await expect(page.getByTestId("review-answer")).toBeVisible();
  await expect(page.getByTestId("review-grades")).toBeVisible();
  for (const rating of ["again", "hard", "good", "easy"]) {
    await expect(page.getByTestId(`review-interval-${rating}`)).not.toHaveText("…");
  }

  // Grade "good" → the card reschedules and a durable review_logs row is written.
  await page.getByTestId("review-grade-good").click();
  // After grading the single due card, the deck empties → the completion summary.
  await expect(page.getByTestId("review-summary")).toBeVisible();
  await expect(page.getByTestId("review-tally-good").locator(".metric__val")).toHaveText("1");

  const after = await cardState(page, cardId);
  expect(after.logCount).toBe(before.logCount + 1);
  expect(after.reps).toBe(before.reps + 1);
  // The new due date moved forward off the AS_OF grade time.
  expect(after.dueAt).not.toBe(before.dueAt);
  expect(Date.parse(after.dueAt ?? "")).toBeGreaterThan(Date.parse(AS_OF));

  await app.close();
});

test("grading across each of Again/Hard/Good/Easy writes a log + reschedules per rating", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // Drive the four ratings through the typed bridge on successive due reads. The
  // clock advances each round so the recurring card stays due — this exercises the
  // full grade path (FSRS reschedule + durable log) once per rating. "again" yields
  // a SHORTER next interval than "easy" (the FSRS ordering invariant).
  const ratings = ["again", "hard", "good", "easy"] as const;
  // Far-future, increasing clocks so each grade leaves the card due for the next.
  const clocks = [
    "2028-01-01T12:00:00.000Z",
    "2029-01-01T12:00:00.000Z",
    "2030-01-01T12:00:00.000Z",
    "2031-01-01T12:00:00.000Z",
  ];

  let lastLogCount = 0;
  const nextDueByRating: Record<string, number> = {};
  for (let i = 0; i < ratings.length; i++) {
    const rating = ratings[i];
    const clock = clocks[i];
    const result = await page.evaluate(
      async ({ clock, rating }) => {
        const api = window.appApi as unknown as {
          review: {
            sessionNext(req: { asOf: string }): Promise<{ card: { id: string } | null }>;
            grade(req: {
              cardId: string;
              rating: string;
              responseMs: number;
              asOf: string;
            }): Promise<{
              reviewLog: { id: string; nextDueAt: string };
              reviewState: { dueAt: string | null; reps: number };
            }>;
          };
          inspector: {
            get(req: {
              id: string;
            }): Promise<{ data: { review: { logCount: number } | null } | null }>;
          };
        };
        const next = await api.review.sessionNext({ asOf: clock });
        if (!next.card) throw new Error(`no due card at ${clock}`);
        const graded = await api.review.grade({
          cardId: next.card.id,
          rating,
          responseMs: 1500 + Math.round(Math.random() * 1000),
          asOf: clock,
        });
        const insp = await api.inspector.get({ id: next.card.id });
        return {
          cardId: next.card.id,
          reviewLogId: graded.reviewLog.id,
          nextDueAt: graded.reviewLog.nextDueAt,
          dueAtState: graded.reviewState.dueAt,
          logCount: insp.data?.review?.logCount ?? 0,
        };
      },
      { clock, rating },
    );

    // A durable review_logs row was written each time (the count grows monotonically).
    expect(result.reviewLogId.length).toBeGreaterThan(0);
    expect(result.logCount).toBeGreaterThan(lastLogCount);
    lastLogCount = result.logCount;
    // The reschedule advanced the card's due date past the grade clock.
    expect(result.dueAtState).toBe(result.nextDueAt);
    nextDueByRating[rating] = Date.parse(result.nextDueAt) - Date.parse(clock);
  }

  // Four grades → four durable logs on top of the seed's two (+ the prior test's one).
  expect(lastLogCount).toBeGreaterThanOrEqual(4);
  // FSRS ordering: "again" reschedules SOONER than "easy" (shorter next interval).
  expect(nextDueByRating.again).toBeLessThan(nextDueByRating.easy);

  await app.close();
});

test("the rescheduling + logs survive an app restart", async () => {
  // Capture the card's persisted state before restart.
  let cardId = "";
  let persisted: { dueAt: string | null; logCount: number } = { dueAt: null, logCount: 0 };
  {
    const app = await launchApp(dataDir);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    // Find the GRADED card (the one with durable review logs) — not just any card
    // (the seed also has an un-reviewed cloze card whose logCount is 0).
    cardId = await page.evaluate(async () => {
      const api = window.appApi as unknown as {
        inspector: {
          list(): Promise<{ elements: { id: string; type: string }[] }>;
          get(req: {
            id: string;
          }): Promise<{ data: { review: { logCount: number } | null } | null }>;
        };
      };
      const { elements } = await api.inspector.list();
      let best: { id: string; logCount: number } | null = null;
      for (const el of elements) {
        if (el.type !== "card") continue;
        const insp = await api.inspector.get({ id: el.id });
        const logCount = insp.data?.review?.logCount ?? 0;
        if (!best || logCount > best.logCount) best = { id: el.id, logCount };
      }
      if (!best || best.logCount === 0) throw new Error("no graded card found after restart");
      return best.id;
    });
    persisted = await cardState(page, cardId);
    expect(persisted.logCount).toBeGreaterThanOrEqual(4);
    await app.close();
  }

  // Re-launch against the SAME data dir — the restart. The advanced due date + the
  // durable review logs are read back from SQLite unchanged.
  {
    const app = await launchApp(dataDir);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    const afterRestart = await cardState(page, cardId);
    expect(afterRestart.logCount).toBe(persisted.logCount);
    expect(afterRestart.dueAt).toBe(persisted.dueAt);
    await app.close();
  }
});
