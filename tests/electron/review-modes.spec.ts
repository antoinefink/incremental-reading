/**
 * Targeted review modes (T096) E2E — drives the real Electron app.
 *
 * A review mode reviews a CHOSEN SUBSET of cards OUTSIDE normal scheduling: the
 * `/review` screen, given a `mode` descriptor in its loose search params, fetches
 * the FROZEN mode deck (`review.modeDeck`), renders the calm mode header, and walks
 * the subset — revealing + grading through the UNCHANGED `review.grade` path. The
 * defining behavior: the selection IGNORES `review_states.due_at`, so a card that is
 * NOT yet due (and would never appear in the daily session) IS reviewable in a mode.
 * Grading still writes a durable `review_logs` row + advances FSRS.
 *
 * This spec seeds the shared demo collection, assigns a concept to TWO cards — the
 * seeded DUE Q&A card and the seeded cloze card whose `review_states.due_at` is NULL
 * (so it is NOT due) — and asserts:
 *
 *   1. the `review.modeDeck` / `review.modeCount` bridge surface exists (no raw SQL);
 *   2. the concept mode deck INCLUDES the not-due card (it does NOT appear in the
 *      daily due session) — the load-bearing "outside scheduling" assertion;
 *   3. opening `/review` in concept mode renders the mode header + subset size, and
 *      revealing + grading the not-due card writes a `review_logs` row + advances
 *      `review_states.due_at` (the unchanged grade path);
 *   4. it SURVIVES AN APP RESTART — the logs + rescheduling persist;
 *   5. a SECOND mode (leech) runs a non-due subset session as a smoke pass.
 *
 * Driven with a fixed FUTURE `asOf` so the seeded due card reads as due.
 */

import { expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

let dataDir: string;
let baseUrl: string;

/** A fixed future clock so the seeded near-future due card reads as due. */
const AS_OF = "2027-06-01T12:00:00.000Z";

/** Open `/review` with the given loose search params and wait for it to render. */
async function openReview(page: Page, params: Record<string, string>): Promise<void> {
  const qs = new URLSearchParams(params).toString();
  await page.goto(`${baseUrl}/review?${qs}`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("route-review")).toBeVisible();
}

/** Read a card's review state (dueAt + reps + log count) via the inspector bridge. */
async function cardState(
  page: Page,
  cardId: string,
): Promise<{ dueAt: string | null; reps: number; logCount: number }> {
  return page.evaluate(async (id) => {
    const api = window.appApi as unknown as {
      inspector: {
        get(req: { id: string }): Promise<{
          data: { review: { dueAt: string | null; reps: number; logCount: number } | null } | null;
        }>;
      };
    };
    const res = await api.inspector.get({ id });
    const review = res.data?.review;
    return {
      dueAt: review?.dueAt ?? null,
      reps: review?.reps ?? 0,
      logCount: review?.logCount ?? 0,
    };
  }, cardId);
}

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
});

test("the review.mode* bridge surface exists (no raw SQL)", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;

  const surface = await page.evaluate(() => {
    const api = window.appApi as unknown as {
      review?: { modeDeck?: unknown; modeCount?: unknown };
      db?: { query?: unknown };
    };
    return {
      hasModeDeck: typeof api?.review?.modeDeck === "function",
      hasModeCount: typeof api?.review?.modeCount === "function",
      hasQuery: typeof api?.db?.query === "function",
    };
  });
  expect(surface.hasModeDeck).toBe(true);
  expect(surface.hasModeCount).toBe(true);
  expect(surface.hasQuery).toBe(false);

  await app.close();
});

/**
 * Build the concept fixture: a fresh concept assigned to the seeded DUE Q&A card +
 * the seeded NOT-DUE cloze card (its `review_states.due_at` is NULL). Returns the
 * concept id + both card ids.
 */
async function seedConceptFixture(
  page: Page,
): Promise<{ conceptId: string; dueCardId: string; notDueCardId: string }> {
  return page.evaluate(async (asOf) => {
    const api = window.appApi as unknown as {
      review: { sessionNext(req: { asOf: string }): Promise<{ card: { id: string } | null }> };
      concepts: {
        create(req: { name: string }): Promise<{ concept: { id: string } }>;
        assign(req: { elementId: string; conceptId: string }): Promise<unknown>;
      };
      inspector: {
        list(): Promise<{ elements: { id: string; type: string }[] }>;
        get(req: { id: string }): Promise<{
          data: { review: { dueAt: string | null; logCount: number } | null } | null;
        }>;
      };
    };
    // The seeded DUE card (soonest-due in the FSRS deck).
    const next = await api.review.sessionNext({ asOf });
    if (!next.card) throw new Error("no due card in the seeded deck");
    const dueCardId = next.card.id;

    // A NOT-due card: a seeded `card` element whose review state has a NULL dueAt
    // (so it is never in the daily session) — but it IS selectable in a mode.
    const { elements } = await api.inspector.list();
    let notDueCardId = "";
    for (const el of elements) {
      if (el.type !== "card" || el.id === dueCardId) continue;
      const insp = await api.inspector.get({ id: el.id });
      if ((insp.data?.review?.dueAt ?? null) === null) {
        notDueCardId = el.id;
        break;
      }
    }
    if (!notDueCardId) throw new Error("no not-due card found in the seed");

    const { concept } = await api.concepts.create({ name: "Review-mode subset" });
    await api.concepts.assign({ elementId: dueCardId, conceptId: concept.id });
    await api.concepts.assign({ elementId: notDueCardId, conceptId: concept.id });
    return { conceptId: concept.id, dueCardId, notDueCardId };
  }, AS_OF);
}

test("a concept mode deck includes a NOT-due card the daily session omits", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const { conceptId, notDueCardId } = await seedConceptFixture(page);

  const probe = await page.evaluate(
    async ({ asOf, conceptId }) => {
      const api = window.appApi as unknown as {
        review: {
          modeDeck(req: {
            selector: { kind: "concept"; conceptId: string };
            asOf: string;
          }): Promise<{ deck: { id: string }[]; total: number; label: string }>;
          sessionNext(req: {
            asOf: string;
            exclude: string[];
          }): Promise<{ card: { id: string } | null }>;
        };
      };
      // The mode deck for the concept.
      const deck = await api.review.modeDeck({
        selector: { kind: "concept", conceptId },
        asOf,
      });
      // The full daily due deck (walked to exhaustion).
      const dueIds: string[] = [];
      for (let i = 0; i < 500; i++) {
        const res = await api.review.sessionNext({ asOf, exclude: dueIds });
        if (!res.card) break;
        dueIds.push(res.card.id);
      }
      return {
        modeIds: deck.deck.map((c) => c.id),
        label: deck.label,
        dueIds,
      };
    },
    { asOf: AS_OF, conceptId },
  );

  // The mode deck includes the NOT-due card; the daily session does NOT.
  expect(probe.modeIds).toContain(notDueCardId);
  expect(probe.dueIds).not.toContain(notDueCardId);
  expect(probe.label).toBe("Concept");

  await app.close();
});

test("reviewing the concept mode renders the header + grades a not-due card (writes a log, reschedules)", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // Re-resolve the fixture (the concept persists across the serial run, but assigning
  // is idempotent, so this is safe — it returns the SAME ids).
  const { conceptId, notDueCardId } = await seedConceptFixture(page);
  const before = await cardState(page, notDueCardId);

  await openReview(page, { mode: "concept", conceptId, asOf: AS_OF });

  // The calm mode header is shown with the subset size.
  await expect(page.getByTestId("review-mode-header")).toBeVisible();
  await expect(page.getByTestId("review-mode-label")).toHaveText(/Concept/);
  await expect(page.getByTestId("review-mode-count")).toContainText("Reviewing");

  // Walk the deck to the NOT-due card (grade past any others), then grade it.
  // The deck has the due card + the not-due card; grade each in turn.
  for (let i = 0; i < 4; i++) {
    const cardEl = page.getByTestId("review-card");
    if ((await cardEl.count()) === 0) break;
    const currentId = await cardEl.getAttribute("data-card-id");
    await page.getByTestId("review-reveal").click();
    await expect(page.getByTestId("review-answer")).toBeVisible();
    await page.getByTestId("review-grade-good").click();
    if (currentId === notDueCardId) break;
    // Otherwise advance to the next card in the frozen deck.
    await page.waitForTimeout(50);
  }

  // The not-due card now has a durable log + an advanced due date.
  const after = await cardState(page, notDueCardId);
  expect(after.logCount).toBe(before.logCount + 1);
  expect(after.reps).toBe(before.reps + 1);
  expect(after.dueAt).not.toBe(before.dueAt);
  expect(Date.parse(after.dueAt ?? "")).toBeGreaterThan(Date.parse(AS_OF));

  await app.close();
});

test("the mode-graded card's logs + rescheduling survive an app restart", async () => {
  // Capture the not-due card's persisted state before restart.
  let cardId = "";
  let persisted: { dueAt: string | null; logCount: number } = { dueAt: null, logCount: 0 };
  {
    const app = await launchApp(dataDir);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    // Find a graded card (logCount > 0) — the not-due card graded above qualifies.
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
      for (const el of elements) {
        if (el.type !== "card") continue;
        const insp = await api.inspector.get({ id: el.id });
        if ((insp.data?.review?.logCount ?? 0) > 0) return el.id;
      }
      throw new Error("no graded card found after restart");
    });
    persisted = await cardState(page, cardId);
    expect(persisted.logCount).toBeGreaterThan(0);
    await app.close();
  }

  // Re-launch against the SAME data dir — the restart. The logs + advanced due date
  // are read back from SQLite unchanged.
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

test("a second mode (leech) runs a non-due subset session and persists", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // The seed carries a leech card; the leech mode deck must surface it.
  const leech = await page.evaluate(async (asOf) => {
    const api = window.appApi as unknown as {
      review: {
        modeDeck(req: {
          selector: { kind: "leech" };
          asOf: string;
        }): Promise<{ deck: { id: string }[]; label: string }>;
      };
    };
    const deck = await api.review.modeDeck({ selector: { kind: "leech" }, asOf });
    return { ids: deck.deck.map((c) => c.id), label: deck.label };
  }, AS_OF);
  expect(leech.label).toBe("Leeches");
  expect(leech.ids.length).toBeGreaterThan(0);
  const leechId = leech.ids[0];

  const before = await cardState(page, leechId);

  await openReview(page, { mode: "leech", asOf: AS_OF });
  await expect(page.getByTestId("review-mode-header")).toBeVisible();
  await expect(page.getByTestId("review-mode-label")).toHaveText(/Leeches/);

  // Grade the first leech card → a durable log + reschedule (a review is a review).
  await page.getByTestId("review-reveal").click();
  await expect(page.getByTestId("review-answer")).toBeVisible();
  await page.getByTestId("review-grade-good").click();

  const after = await cardState(page, leechId);
  expect(after.logCount).toBe(before.logCount + 1);

  await app.close();
});
