/**
 * Card-edit write barrier (T125) E2E — drives the real Electron app.
 *
 * A substantive card rewrite stops inheriting the FSRS stability its old formulation
 * earned: it re-stabilizes the card to a short confirmation interval so the new wording
 * surfaces soon, not months out. This spec launches the built desktop app against fresh
 * data dirs and asserts, end to end through the real IPC + SQLite:
 *
 *   1. (bridge) a card matured to a far-future due, then re-stabilized via
 *      `cards.update {editChoice: "re_stabilize"}`, becomes due within the confirmation
 *      window; the fabricated marker row stays INVISIBLE to the inspector review count
 *      (R9); the demotion SURVIVES an app restart; and the receipt undo restores the
 *      EXACT prior schedule;
 *   2. (UI) editing a card's answer substantively in `/review` surfaces the keep /
 *      re-verify choice at commit, and keeping the schedule closes the editor with no
 *      demotion.
 */

import { expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

const DAY_MS = 24 * 60 * 60 * 1000;
/** A fixed future clock so the seeded near-future Q&A card reads as due. */
const AS_OF = "2027-06-01T12:00:00.000Z";

let baseUrl = "";

test.beforeAll(() => {
  ensureBuilt();
});

/** The due Q&A card id at `asOf`, via the session bridge. */
async function dueQaCardId(page: Page, asOf: string): Promise<{ id: string; kind: string }> {
  const card = await page.evaluate(async (clock) => {
    const api = window.appApi as unknown as {
      review: {
        sessionNext(req: { asOf: string }): Promise<{ card: { id: string; kind: string } | null }>;
      };
    };
    return (await api.review.sessionNext({ asOf: clock })).card;
  }, asOf);
  if (!card) throw new Error("no due card");
  return card;
}

/** A card's review state (dueAt + reps + logCount) via the inspector bridge. */
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
    const review = (await api.inspector.get({ id })).data?.review;
    return {
      dueAt: review?.dueAt ?? null,
      reps: review?.reps ?? 0,
      logCount: review?.logCount ?? 0,
    };
  }, cardId);
}

test("a substantive re-stabilization surfaces soon, hides its marker, survives restart, and undoes", async () => {
  const dataDir = makeDataDir();
  let cardId = "";
  let dueFar = "";
  let reviewLogId = "";
  let logCountBeforeBarrier = 0;

  {
    const app = await launchApp(dataDir, { seedOnEmpty: true });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    baseUrl = `${(() => {
      const u = new URL(page.url());
      return `${u.protocol}//${u.host}`;
    })()}`;

    const card = await dueQaCardId(page, AS_OF);
    cardId = card.id;

    // Mature the card to a far-future due (grade Easy at the future clock).
    await page.evaluate(
      async ({ id, clock }) => {
        const api = window.appApi as unknown as {
          review: {
            grade(req: {
              cardId: string;
              rating: string;
              responseMs: number;
              asOf: string;
            }): Promise<unknown>;
          };
        };
        await api.review.grade({ cardId: id, rating: "easy", responseMs: 1500, asOf: clock });
      },
      { id: cardId, clock: AS_OF },
    );
    const matured = await cardState(page, cardId);
    dueFar = matured.dueAt ?? "";
    logCountBeforeBarrier = matured.logCount;
    expect(Date.parse(dueFar)).toBeGreaterThan(Date.now() + 30 * DAY_MS); // genuinely far out

    // Substantively rewrite the answer and re-stabilize through the real IPC.
    const receipt = await page.evaluate(async (id) => {
      const api = window.appApi as unknown as {
        cards: {
          update(req: { cardId: string; answer: string; editChoice: string }): Promise<{
            reStabilized: {
              reviewLogId: string;
              previousDueAt: string | null;
              newDueAt: string | null;
            } | null;
          }>;
        };
      };
      return (
        await api.cards.update({
          cardId: id,
          answer: "A completely rewritten answer with materially different wording.",
          editChoice: "re_stabilize",
        })
      ).reStabilized;
    }, cardId);
    expect(receipt).not.toBeNull();
    reviewLogId = receipt?.reviewLogId ?? "";

    const demoted = await cardState(page, cardId);
    // Surfaces SOON: due within the confirmation window (≈ now + 1 day), not months out.
    expect(Date.parse(demoted.dueAt ?? "")).toBeLessThanOrEqual(Date.now() + 2 * DAY_MS);
    expect(Date.parse(demoted.dueAt ?? "")).toBeLessThan(Date.parse(dueFar));
    // R9: the fabricated marker row is INVISIBLE to the inspector's review count.
    expect(demoted.logCount).toBe(logCountBeforeBarrier);

    await app.close();
  }

  // Restart against the SAME data dir — the demotion is read back from SQLite.
  {
    const app = await launchApp(dataDir);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    const persisted = await cardState(page, cardId);
    expect(Date.parse(persisted.dueAt ?? "")).toBeLessThanOrEqual(Date.now() + 2 * DAY_MS);

    // The receipt undo restores the EXACT prior (far-future) schedule.
    const undo = await page.evaluate(
      async ({ id, logId }) => {
        const api = window.appApi as unknown as {
          cards: {
            reStabilizeUndo(req: {
              cardId: string;
              reviewLogId: string;
            }): Promise<{ undone: boolean }>;
          };
        };
        return api.cards.reStabilizeUndo({ cardId: id, reviewLogId: logId });
      },
      { id: cardId, logId: reviewLogId },
    );
    expect(undo.undone).toBe(true);
    const restored = await cardState(page, cardId);
    expect(restored.dueAt).toBe(dueFar);
    await app.close();
  }
});

test("a substantive edit in review surfaces the keep/re-verify choice; keep closes with no demotion", async () => {
  const dataDir = makeDataDir();
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  baseUrl = `${(() => {
    const u = new URL(page.url());
    return `${u.protocol}//${u.host}`;
  })()}`;

  const card = await dueQaCardId(page, AS_OF);
  const before = await cardState(page, card.id);

  await page.goto(`${baseUrl}/review?asOf=${encodeURIComponent(AS_OF)}`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("route-review")).toBeVisible();
  await page.getByTestId("review-reveal").click();
  await expect(page.getByTestId("review-repair-edit")).toBeVisible();

  await page.getByTestId("review-repair-edit").click();
  await page
    .getByTestId("review-edit-answer")
    .fill("A completely rewritten answer with materially different wording.");
  await page.getByTestId("review-edit-done").click();

  // The substantive edit surfaces the choice; keeping the schedule closes with no demotion.
  await expect(page.getByTestId("restabilize-choice")).toBeVisible();
  await page.getByTestId("restabilize-choice-keep").click();
  await page.getByTestId("restabilize-choice-confirm").click();
  await expect(page.getByTestId("review-edit")).toHaveCount(0);

  const after = await cardState(page, card.id);
  // Keep-schedule: the body changed but the FSRS schedule did not.
  expect(after.dueAt).toBe(before.dueAt);
  await app.close();
});
