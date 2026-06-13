/**
 * Lineage-aware deletion (T135 / U9) E2E — drives the real Electron app.
 *
 * Deleting an element in the MIDDLE of the lineage tree must never silently orphan a
 * live descendant, never silently hide live work, and never destroy review history as a
 * side effect. This spec launches the BUILT desktop app against a fresh data dir seeded
 * with the shared demo collection — whose `source → extract → sub-extract → card` chain
 * is the exact mid-tree shape this feature targets — and proves, end-to-end through the
 * typed `window.appApi` bridge (the renderer never opens SQLite):
 *
 *   • AE3 (R1):  "Keep descendants" tombstones a mid-tree extract — the live card still
 *                appears in its OWN lineage as a descendant of a `deleted: true` tombstone,
 *                and that survives an app RESTART.
 *   • AE5 (R8/R10): "Delete the whole branch" soft-cascades the extract + sub-extract +
 *                cards under one `batchId`, clearing the descendant card's FSRS
 *                `review_states.due_at`; an UNRELATED card graded in between does NOT break
 *                the batch restore, which re-establishes the card's pre-delete FSRS due
 *                exactly (order-independent — the proof that the undo is batch-scoped, not
 *                "undo the last global op").
 *   • AE6 + AE7 (R12): purge of a tombstone that still anchors a live card is BLOCKED
 *                (`{ blocked: true }`, nulls nothing — the live card keeps its parent link);
 *                Empty Trash purges the safe rows, SKIPS the anchoring tombstone with a
 *                non-zero count, and the lineage stays FK-clean across a restart (no orphan).
 *   • AE8 (R15): the descendant-aware intent menu opens for the `queue:act` `delete` path
 *                on a node WITH live descendants (no silent single-row prune); a LEAF shows
 *                NO menu (quiet delete).
 *   • Bridge-surface guard: the new channels are present on `window.appApi` and
 *                `api.db.query` is NOT a function (no raw SQL door).
 *
 * Every mutation rides the typed bridge or the real UI — exactly the paths the user takes.
 */

import { expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

/** A fixed FUTURE clock so a freshly-scheduled attention item reads as due in the queue. */
const AS_OF = "2027-06-01T12:00:00.000Z";

// Each test owns an ISOLATED data dir (seeded fresh) so the scenarios are independent and
// order-free — a tombstone left by one never leaks into another. The build is shared.
test.beforeAll(() => {
  ensureBuilt();
});

/** Capture the running app's renderer origin so a test can navigate routes. */
async function originOf(page: Page): Promise<string> {
  const url = new URL(page.url());
  return `${url.protocol}//${url.host}`;
}

// ---------------------------------------------------------------------------
// Typed-bridge helpers (the renderer's only door — never raw SQL).
// ---------------------------------------------------------------------------

/** Resolve a seeded element id by type + (optional unique) title via the bridge. */
async function resolveId(page: Page, type: string, title?: string): Promise<string> {
  return page.evaluate(
    async ({ type, title }) => {
      const api = window.appApi as unknown as {
        inspector: {
          list(): Promise<{ elements: { id: string; type: string; title: string }[] }>;
        };
      };
      const { elements } = await api.inspector.list();
      const match = elements.find((e) => e.type === type && (!title || e.title === title));
      if (!match) throw new Error(`seeded ${type}${title ? ` "${title}"` : ""} not found`);
      return match.id;
    },
    { type, title },
  );
}

/** The flattened lineage nodes for `id`, optionally INCLUDING soft-deleted tombstones. */
async function lineageNodes(
  page: Page,
  id: string,
  includeTombstones = false,
): Promise<{ id: string; type: string; deleted: boolean; active: boolean; depth: number }[]> {
  return page.evaluate(
    async ({ id, includeTombstones }) => {
      const api = window.appApi as unknown as {
        lineage: {
          get(req: { id: string; includeTombstones?: boolean }): Promise<{
            lineage: {
              nodes: {
                id: string;
                type: string;
                deleted: boolean;
                active: boolean;
                depth: number;
              }[];
            } | null;
          }>;
        };
      };
      const res = await api.lineage.get({ id, includeTombstones });
      return res.lineage?.nodes ?? [];
    },
    { id, includeTombstones },
  );
}

/** The live-descendant blast-radius breakdown for `id` (drives the menu / show-or-not). */
async function countDescendants(
  page: Page,
  id: string,
): Promise<{ extracts: number; cards: number; cardsWithHistory: number; total: number }> {
  return page.evaluate(async (elementId) => {
    const api = window.appApi as unknown as {
      elements: {
        countDescendants(req: { id: string }): Promise<{
          extracts: number;
          cards: number;
          cardsWithHistory: number;
          total: number;
        }>;
      };
    };
    return api.elements.countDescendants({ id: elementId });
  }, id);
}

/** Soft-delete a node (subtree off = tombstone-only; on = whole branch). */
async function softDeleteSubtree(
  page: Page,
  id: string,
  includeSubtree: boolean,
): Promise<{ batchId: string; affected: string[] }> {
  return page.evaluate(
    async ({ id, includeSubtree }) => {
      const api = window.appApi as unknown as {
        elements: {
          softDeleteSubtree(req: {
            id: string;
            includeSubtree?: boolean;
          }): Promise<{ batchId: string; affected: string[] }>;
        };
      };
      return api.elements.softDeleteSubtree({ id, includeSubtree });
    },
    { id, includeSubtree },
  );
}

/** Restore a whole delete batch by its `batchId` (root-first, atomic). */
async function restoreBatch(
  page: Page,
  batchId: string,
): Promise<{ restored: string[]; rootRestored: boolean }> {
  return page.evaluate(async (id) => {
    const api = window.appApi as unknown as {
      trash: {
        restoreBatch(req: {
          batchId: string;
        }): Promise<{ restored: string[]; rootRestored: boolean }>;
      };
    };
    return api.trash.restoreBatch({ batchId: id });
  }, batchId);
}

/** Attempt a hard purge of one trashed row (returns the guard verdict). */
async function purge(
  page: Page,
  id: string,
): Promise<{ purged: number; blocked: boolean; liveDependents: number }> {
  return page.evaluate(async (elementId) => {
    const api = window.appApi as unknown as {
      trash: {
        purge(req: {
          id: string;
        }): Promise<{ purged: number; blocked: boolean; liveDependents: number }>;
      };
    };
    return api.trash.purge({ id: elementId });
  }, id);
}

/** Empty the trash (purges the safe rows; reports the anchored rows it skipped). */
async function emptyTrash(page: Page): Promise<{ purged: number; skipped: number }> {
  return page.evaluate(async () => {
    const api = window.appApi as unknown as {
      trash: { empty(): Promise<{ purged: number; skipped: number }> };
    };
    return api.trash.empty();
  });
}

/** The ids currently in `/trash` (via the typed bridge). */
async function trashIds(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const api = window.appApi as unknown as {
      trash: { list(): Promise<{ items: { id: string }[] }> };
    };
    const { items } = await api.trash.list();
    return items.map((i) => i.id);
  });
}

/** The inspector's element status (or `null` when soft-deleted / unknown). */
async function statusOf(page: Page, id: string): Promise<string | null> {
  return page.evaluate(async (elementId) => {
    const api = window.appApi as unknown as {
      inspector: {
        get(req: { id: string }): Promise<{ data: { element: { status: string } } | null }>;
      };
    };
    const res = await api.inspector.get({ id: elementId });
    return res.data?.element.status ?? null;
  }, id);
}

/** A card's FSRS `review_states.due_at` (via the inspector `review` block), or `null`. */
async function reviewDueAt(page: Page, cardId: string): Promise<string | null> {
  return page.evaluate(async (id) => {
    const api = window.appApi as unknown as {
      inspector: {
        get(req: {
          id: string;
        }): Promise<{ data: { review: { dueAt: string | null } | null } | null }>;
      };
    };
    const res = await api.inspector.get({ id });
    return res.data?.review?.dueAt ?? null;
  }, cardId);
}

/**
 * Whether the live `cardId` is STILL anchored under `extractId` in the lineage — i.e. its
 * `parentId` link is intact, even when the extract is a tombstone. We assert this through
 * the TOMBSTONE-AWARE lineage (both nodes present, the card exactly one depth below the
 * extract) rather than the inspector's `parent` chip, which deliberately surfaces only a
 * LIVE parent (a soft-deleted parent shows as `null` there + via the "ancestor deleted"
 * hint). The link integrity is what R13 cares about; the FK check is the other backstop.
 */
async function cardStillUnderExtract(
  page: Page,
  cardId: string,
  extractId: string,
): Promise<boolean> {
  const nodes = await lineageNodes(page, cardId, true);
  const card = nodes.find((n) => n.id === cardId);
  const extract = nodes.find((n) => n.id === extractId);
  if (!card || !extract) return false;
  return card.depth === extract.depth + 1;
}

/** Schedule an attention item due "now" (a fixed past-of-AS_OF date) so it enters the queue. */
async function scheduleDueForQueue(page: Page, id: string): Promise<void> {
  await page.evaluate(
    async ({ id, dueAt }) => {
      const api = window.appApi as unknown as {
        queue: {
          schedule(req: { id: string; choice: { kind: "manual"; date: string } }): Promise<unknown>;
        };
      };
      await api.queue.schedule({ id, choice: { kind: "manual", date: dueAt } });
    },
    { id, dueAt: "2027-05-30T12:00:00.000Z" },
  );
}

/** Grade a card (an UNRELATED, logged mutation between a branch delete and its undo). */
async function gradeCard(page: Page, cardId: string): Promise<void> {
  await page.evaluate(async (id) => {
    const api = window.appApi as unknown as {
      review: {
        grade(req: {
          cardId: string;
          rating: string;
          responseMs: number;
          asOf?: string;
        }): Promise<unknown>;
      };
    };
    await api.review.grade({ cardId: id, rating: "good", responseMs: 2500 });
  }, cardId);
}

/**
 * The number of FK violations from the on-demand deep integrity check (T099). This runs
 * `PRAGMA foreign_key_check` server-side — exactly the `foreign_key_check` AE7 asks for —
 * and returns `db.foreignKeyViolations`; the renderer never runs raw SQL.
 */
async function foreignKeyViolations(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const api = window.appApi as unknown as {
      maintenance: {
        integrity(req?: { deep?: boolean }): Promise<{ db: { foreignKeyViolations: number } }>;
      };
    };
    const report = await api.maintenance.integrity({ deep: true });
    return report.db.foreignKeyViolations;
  });
}

// ---------------------------------------------------------------------------
// 0. Bridge surface — the new channels exist; no raw SQL is exposed.
// ---------------------------------------------------------------------------

test("the lineage-deletion bridge surface exists (no raw SQL)", async () => {
  const dir = makeDataDir();
  const app = await launchApp(dir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const surface = await page.evaluate(() => {
    const api = window.appApi as unknown as {
      lineage?: { get?: unknown };
      elements?: { countDescendants?: unknown; softDeleteSubtree?: unknown };
      trash?: { restoreBatch?: unknown; purge?: unknown; empty?: unknown; list?: unknown };
      db?: { query?: unknown };
    };
    return {
      hasLineageGet: typeof api?.lineage?.get === "function",
      hasCountDescendants: typeof api?.elements?.countDescendants === "function",
      hasSoftDeleteSubtree: typeof api?.elements?.softDeleteSubtree === "function",
      hasRestoreBatch: typeof api?.trash?.restoreBatch === "function",
      hasPurge: typeof api?.trash?.purge === "function",
      hasEmpty: typeof api?.trash?.empty === "function",
      hasQuery: typeof api?.db?.query === "function",
    };
  });
  expect(surface.hasLineageGet).toBe(true);
  expect(surface.hasCountDescendants).toBe(true);
  expect(surface.hasSoftDeleteSubtree).toBe(true);
  expect(surface.hasRestoreBatch).toBe(true);
  expect(surface.hasPurge).toBe(true);
  expect(surface.hasEmpty).toBe(true);
  // The non-negotiable invariant: no generic SQL door on the renderer.
  expect(surface.hasQuery).toBe(false);

  await app.close();
});

// ---------------------------------------------------------------------------
// AE3 (R1) — Keep descendants tombstones a mid-tree extract; the live card stays
// in its own lineage under a `deleted: true` tombstone, and survives restart.
// ---------------------------------------------------------------------------

test("AE3 — Keep descendants tombstones the mid extract; the live card stays under it and survives restart", async () => {
  const dir = makeDataDir();
  let app = await launchApp(dir, { seedOnEmpty: true });
  let page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const baseUrl = await originOf(page);

  // The mid-tree extract anchors a live sub-extract + live cards.
  const extractId = await resolveId(page, "extract", "Intelligence = skill-acquisition efficiency");
  const subExtractId = await resolveId(page, "extract", "Must control for priors and experience");

  // The seeded Q&A card under that extract — the focused live descendant.
  const cardId = await page.evaluate(async (parentId) => {
    const api = window.appApi as unknown as {
      lineage: {
        get(req: {
          id: string;
        }): Promise<{ lineage: { nodes: { id: string; type: string }[] } | null }>;
      };
    };
    const { lineage } = await api.lineage.get({ id: parentId });
    const card = lineage?.nodes.find((n) => n.type === "card");
    if (!card) throw new Error("seeded descendant card not found");
    return card.id;
  }, extractId);

  // Precondition: the extract has live descendants (so this is the mid-tree case).
  const blast = await countDescendants(page, extractId);
  expect(blast.total).toBeGreaterThan(0);
  expect(blast.extracts).toBeGreaterThanOrEqual(1); // the sub-extract
  expect(blast.cards).toBeGreaterThanOrEqual(1);
  expect(blast.cardsWithHistory).toBeGreaterThanOrEqual(1); // the Q&A card carries reviews

  // Keep descendants: tombstone ONLY the extract (subtree off) — the SAME mutation the
  // intent menu's "Keep descendants" action drives.
  await softDeleteSubtree(page, extractId, false);

  // The extract is soft-deleted; the sub-extract + card stay LIVE.
  expect(await statusOf(page, extractId)).toBeNull(); // inspector hides soft-deleted
  expect(await statusOf(page, subExtractId)).not.toBeNull();
  expect(await statusOf(page, cardId)).not.toBeNull();

  // R1: the card NEVER disappears from its own lineage — with tombstones, the deleted
  // extract is present as a `deleted: true` node and the live card is still in the chain.
  const withTomb = await lineageNodes(page, cardId, true);
  const tombstone = withTomb.find((n) => n.id === extractId);
  expect(tombstone, "the deleted extract should appear as a tombstone node").toBeTruthy();
  expect(tombstone?.deleted).toBe(true);
  const cardNode = withTomb.find((n) => n.id === cardId);
  expect(cardNode?.deleted).toBe(false);
  expect(cardNode?.active).toBe(true);

  // R13: the live card still has the extract as its parent link (nothing re-pointed) —
  // it sits exactly one depth below the tombstoned extract in its own chain.
  expect(await cardStillUnderExtract(page, cardId, extractId)).toBe(true);

  // Without the flag, the default live-only path prunes the deleted middle (R2 boundary).
  const liveOnly = await lineageNodes(page, cardId, false);
  expect(liveOnly.find((n) => n.id === extractId)).toBeUndefined();

  // RESTART: relaunch against the same data dir — the tombstone outcome persists.
  await app.close();
  app = await launchApp(dir);
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const afterRestart = await lineageNodes(page, cardId, true);
  const tombAfter = afterRestart.find((n) => n.id === extractId);
  expect(tombAfter?.deleted).toBe(true);
  expect(afterRestart.find((n) => n.id === cardId)?.active).toBe(true);
  expect(await statusOf(page, cardId)).not.toBeNull(); // card still live after restart
  expect(await cardStillUnderExtract(page, cardId, extractId)).toBe(true); // link intact after restart

  // The inspector keeps tombstones recoverable without making them louder than live
  // lineage: select the live card, confirm deleted nodes are hidden by default, then
  // reveal them through the Lineage header toggle.
  // Scope to the CARD picker row (its exact title — the seeded verify-claim TASK shares
  // the substring "Chollet's definition of intelligence", so filter by type to disambiguate).
  await page.goto(`${baseUrl}/`);
  await page.waitForLoadState("domcontentloaded");
  const cardPick = page
    .locator('[data-testid="element-picker-item"][data-element-type="card"]')
    .filter({ hasText: /^Chollet's definition of intelligence/ });
  await expect(cardPick).toHaveCount(1);
  await cardPick.click();
  await expect(page.getByTestId("inspector-content")).toHaveAttribute("data-element-type", "card");
  const lineageSection = page.getByTestId("lineage-section");
  const showDeleted = lineageSection.getByRole("button", { name: /show deleted/i });
  await expect(showDeleted).toBeVisible();
  await expect(page.getByTestId("lineage-tombstone-tag")).toHaveCount(0);
  await expect(page.getByTestId("lineage-ancestor-deleted")).toHaveCount(0);
  await expect(page.getByTestId("lineage-tombstone-restore")).toHaveCount(0);

  await showDeleted.click();

  // The deleted middle extract is a struck tombstone in the card's lineage when revealed.
  await expect(page.getByTestId("lineage-tombstone-tag").first()).toBeVisible();
  await expect(page.getByTestId("lineage-ancestor-deleted")).toBeVisible();
  const ancestorRestore = page.getByTestId("lineage-ancestor-restore");
  const tombstoneRestore = page.getByTestId("lineage-tombstone-restore").first();
  await expect(tombstoneRestore).toBeVisible();
  const ancestorRestoreBox = await ancestorRestore.boundingBox();
  const tombstoneRestoreBox = await tombstoneRestore.boundingBox();
  expect(ancestorRestoreBox).not.toBeNull();
  expect(tombstoneRestoreBox).not.toBeNull();
  expect(
    Math.abs((ancestorRestoreBox?.height ?? 0) - (tombstoneRestoreBox?.height ?? 0)),
  ).toBeLessThanOrEqual(1);
  expect(tombstoneRestoreBox?.height ?? 0).toBeLessThanOrEqual(20);

  await ancestorRestore.click();
  await expect(page.getByTestId("lineage-tombstone-tag")).toHaveCount(0);
  await expect(page.getByTestId("lineage-ancestor-deleted")).toHaveCount(0);
  await expect(lineageSection.getByRole("button", { name: /show deleted/i })).toHaveCount(0);
  expect(await statusOf(page, extractId)).not.toBeNull();

  await app.close();
  app = await launchApp(dir);
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  expect((await lineageNodes(page, cardId, true)).find((n) => n.id === extractId)?.deleted).toBe(
    false,
  );
  expect(await cardStillUnderExtract(page, cardId, extractId)).toBe(true);

  await app.close();
});

// ---------------------------------------------------------------------------
// AE5 (R8/R10) — Delete the whole branch; grade an UNRELATED card in between;
// batch restore brings all three back with the card's FSRS due re-established.
// ---------------------------------------------------------------------------

test("AE5 — Delete branch, grade an unrelated card, then batch-restore with FSRS intact (order-independent)", async () => {
  const dir = makeDataDir();
  const app = await launchApp(dir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const extractId = await resolveId(page, "extract", "Intelligence = skill-acquisition efficiency");
  const subExtractId = await resolveId(page, "extract", "Must control for priors and experience");
  // The Q&A card under the extract — it carries real FSRS history (a non-null due).
  const cardId = await resolveId(page, "card", "Chollet's definition of intelligence");
  // An UNRELATED card in a DIFFERENT source's branch (the math/code source) — graded
  // between the delete and the undo to prove the batch restore is order-independent.
  const unrelatedCardId = await resolveId(page, "card", "Gradient of the loss (math Q&A)");

  // Pre-delete FSRS due of the focused descendant card (the value restore must re-establish).
  const dueBefore = await reviewDueAt(page, cardId);
  expect(dueBefore, "the seeded Q&A card should have an FSRS due before delete").not.toBeNull();

  // Delete the WHOLE branch (subtree on): extract + sub-extract + cards in one batch.
  const { batchId, affected } = await softDeleteSubtree(page, extractId, true);
  expect(batchId).toBeTruthy();
  // The branch captured the extract, the sub-extract, and the focused card.
  expect(affected).toContain(extractId);
  expect(affected).toContain(subExtractId);
  expect(affected).toContain(cardId);

  // R8: every node is now soft-deleted; the descendant card's FSRS due is CLEARED (no
  // phantom "due today"), with a preimage recorded for restore.
  expect(await statusOf(page, extractId)).toBeNull();
  expect(await statusOf(page, subExtractId)).toBeNull();
  expect(await statusOf(page, cardId)).toBeNull();
  expect(await trashIds(page)).toEqual(expect.arrayContaining([extractId, subExtractId, cardId]));

  // R10 setup: an INTERVENING logged op — grade an unrelated card. `undoLast` would now
  // reverse THIS grade, not the branch; the batch-scoped restore must ignore it entirely.
  await gradeCard(page, unrelatedCardId);

  // R10: restore the EXACT branch by its batchId — order-independent.
  const restore = await restoreBatch(page, batchId);
  expect(restore.rootRestored).toBe(true);
  expect(restore.restored).toEqual(expect.arrayContaining([extractId, subExtractId, cardId]));

  // All three are LIVE again and out of the trash; lineage reconnects.
  expect(await statusOf(page, extractId)).not.toBeNull();
  expect(await statusOf(page, subExtractId)).not.toBeNull();
  expect(await statusOf(page, cardId)).not.toBeNull();
  expect(await trashIds(page)).not.toContain(extractId);
  // The reconnected card is back under the (now-live) extract in the live-only lineage.
  const reconnected = await lineageNodes(page, cardId, false);
  expect(reconnected.find((n) => n.id === extractId)).toBeTruthy();

  // R8/R10: the descendant card's FSRS `review_states.due_at` is restored to its EXACT
  // pre-delete value (scheduling re-established from the preimage, not left cleared).
  expect(await reviewDueAt(page, cardId)).toBe(dueBefore);

  await app.close();
});

// ---------------------------------------------------------------------------
// AE6 + AE7 (R12) — purge guard blocks a tombstone anchoring a live card and nulls
// nothing; Empty Trash skips it (non-zero count) while purging safe rows; FK-clean
// across restart.
// ---------------------------------------------------------------------------

test("AE6 + AE7 — purge of an anchoring tombstone is blocked and Empty Trash skips it; FK-clean across restart", async () => {
  const dir = makeDataDir();
  let app = await launchApp(dir, { seedOnEmpty: true });
  let page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const extractId = await resolveId(page, "extract", "Intelligence = skill-acquisition efficiency");
  const cardId = await resolveId(page, "card", "Chollet's definition of intelligence");

  // Tombstone the extract while it still anchors the live card (keep-descendants).
  await softDeleteSubtree(page, extractId, false);
  expect(await statusOf(page, cardId)).not.toBeNull(); // the card is still live underneath
  expect(await cardStillUnderExtract(page, cardId, extractId)).toBe(true);

  // A second, SAFE trash row with no live descendants: soft-delete a leaf (the inbox
  // source "The Bitter Lesson" has nothing beneath it) so Empty Trash has something to purge.
  const safeLeafId = await resolveId(page, "source", "The Bitter Lesson");
  await softDeleteSubtree(page, safeLeafId, false);
  expect(await trashIds(page)).toEqual(expect.arrayContaining([extractId, safeLeafId]));

  // AE6 / R12: a MANUAL purge of the anchoring tombstone is BLOCKED — it nulls nothing.
  const verdict = await purge(page, extractId);
  expect(verdict.blocked).toBe(true);
  expect(verdict.purged).toBe(0);
  expect(verdict.liveDependents).toBeGreaterThanOrEqual(1);
  // R13: the live card STILL has its parent link — the purge guard prevented the 0030 wipe.
  expect(await cardStillUnderExtract(page, cardId, extractId)).toBe(true);
  expect(await statusOf(page, cardId)).not.toBeNull();
  // The tombstone is still in the trash (the purge was refused, not partially applied).
  expect(await trashIds(page)).toContain(extractId);

  // AE7 / R12: Empty Trash purges the SAFE rows, SKIPS the anchoring tombstone, reports it.
  const emptied = await emptyTrash(page);
  expect(emptied.skipped).toBeGreaterThanOrEqual(1); // the anchoring tombstone was kept
  expect(emptied.purged).toBeGreaterThanOrEqual(1); // the safe leaf was purged
  const afterEmpty = await trashIds(page);
  expect(afterEmpty).toContain(extractId); // the anchor survives
  expect(afterEmpty).not.toContain(safeLeafId); // the safe row is gone

  // The live card is STILL anchored after Empty Trash (no orphan created).
  expect(await cardStillUnderExtract(page, cardId, extractId)).toBe(true);
  expect(await statusOf(page, cardId)).not.toBeNull();

  // FK-clean now and across a RESTART — the 0030 hazard (a nulled live-descendant link)
  // never occurred at any hard-delete seam.
  expect(await foreignKeyViolations(page)).toBe(0);

  await app.close();
  app = await launchApp(dir);
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // After restart: the tombstone persisted in trash, the card is still live + linked, FK clean.
  expect(await trashIds(page)).toContain(extractId);
  expect(await statusOf(page, cardId)).not.toBeNull();
  expect(await cardStillUnderExtract(page, cardId, extractId)).toBe(true);
  expect(await foreignKeyViolations(page)).toBe(0);

  await app.close();
});

// ---------------------------------------------------------------------------
// AE8 (R15) — the descendant-aware intent menu opens for the queue `delete` path on a
// node WITH live descendants (no silent prune); a LEAF shows NO menu.
// ---------------------------------------------------------------------------

test("AE8 — the queue delete opens the intent menu for a node with descendants, but not for a leaf", async () => {
  const dir = makeDataDir();
  const app = await launchApp(dir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const baseUrl = await originOf(page);

  const extractId = await resolveId(page, "extract", "Intelligence = skill-acquisition efficiency");
  const subExtractId = await resolveId(page, "extract", "Must control for priors and experience");

  // Make BOTH the mid-tree extract and the leaf sub-extract due so they appear as queue
  // rows whose Delete action routes through the real `queue:act` `delete` path (R15).
  await scheduleDueForQueue(page, extractId);
  await scheduleDueForQueue(page, subExtractId);

  await page.goto(`${baseUrl}/queue?asOf=${encodeURIComponent(AS_OF)}`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("route-queue")).toBeVisible();

  // The mid-tree extract's row: pressing Delete opens the descendant-aware intent menu
  // (NOT an immediate silent prune). The blast-radius copy + the honorable-fate action
  // for an extract ("Mark processed") confirm it is the real lineage menu.
  const extractRow = page.locator(`[data-testid="queue-item"][data-element-id="${extractId}"]`);
  await expect(extractRow).toBeVisible();
  await extractRow.getByTestId("queue-action-delete").click();
  await expect(page.getByTestId("lineage-delete-pop")).toBeVisible();
  await expect(page.getByTestId("lineage-delete-radius")).toBeVisible();
  await expect(page.getByTestId("lineage-delete-keep")).toBeVisible();
  await expect(page.getByTestId("lineage-delete-branch")).toBeVisible();
  await expect(page.getByTestId("lineage-delete-mark-done")).toBeVisible(); // extract → honorable fate

  // Esc cancels with NO mutation — the extract stays live (the menu is non-destructive
  // until a choice is made; this is the "no silent prune" proof).
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("lineage-delete-pop")).toHaveCount(0);
  expect(await statusOf(page, extractId)).not.toBeNull();

  // The LEAF sub-extract's row: pressing Delete performs a QUIET delete — no menu opens —
  // and the leaf leaves the live set (the fast path for a node with no descendants, R4).
  const leafRow = page.locator(`[data-testid="queue-item"][data-element-id="${subExtractId}"]`);
  await expect(leafRow).toBeVisible();
  await leafRow.getByTestId("queue-action-delete").click();
  // No intent menu for a leaf.
  await expect(page.getByTestId("lineage-delete-pop")).toHaveCount(0);
  // The quiet delete removed it from the live set (it is now trashed).
  await expect.poll(() => trashIds(page)).toContain(subExtractId);
  expect(await statusOf(page, subExtractId)).toBeNull();
  // The mid-tree extract is still untouched (the leaf delete didn't cascade or prune it).
  expect(await statusOf(page, extractId)).not.toBeNull();

  await app.close();
});
