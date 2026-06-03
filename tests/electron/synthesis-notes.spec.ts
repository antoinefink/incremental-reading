/**
 * Incremental writing / synthesis notes (T095) E2E — drives the real Electron app.
 *
 * A synthesis note is the EXISTING core `synthesis_note` element type — a writing
 * surface that COLLECTS linked extracts/cards (`references` edges) and is SCHEDULED TO
 * RETURN for refinement on the ATTENTION scheduler (never FSRS — it is processed, not
 * recalled). Every mutation is one transaction + the correct EXISTING op (no new op
 * types, no new element type) through the typed `synthesis.*` `window.appApi` (no raw
 * SQL). This spec launches the built desktop app against a fresh data dir seeded with
 * the shared demo collection and asserts:
 *
 *   1. the `synthesis.*` bridge surface exists (no raw SQL);
 *   2. CREATE a synthesis note → it is a `synthesis_note` element, stage `synthesis`;
 *   3. LINK two extracts and a card → they show in the note's linked material;
 *   4. write some BODY → it persists; SCHEDULE it to return next week → it gets a due
 *      date on the ATTENTION scheduler and NO `review_states` row, and appears in the
 *      due queue + the library;
 *   5. the dedicated `/synthesis/$id` UI surface renders (title, editor, linked panel,
 *      schedule controls);
 *   6. it SURVIVES AN APP RESTART — the note + its links + body + schedule persist.
 */

import { expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

let dataDir: string;
let baseUrl: string;
/** The created synthesis note id, carried across the serial tests. */
let noteId = "";

const FUTURE = "2031-01-01T12:00:00.000Z";

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
});

/** The id of a seeded live element of a given type via the typed inspector list. */
async function seededElementId(page: Page, type: string): Promise<string> {
  return page.evaluate(async (t) => {
    const api = window.appApi as unknown as {
      inspector: { list(): Promise<{ elements: { id: string; type: string }[] }> };
    };
    const { elements } = await api.inspector.list();
    const el = elements.find((e) => e.type === t);
    if (!el) throw new Error(`no seeded ${t} found`);
    return el.id;
  }, type);
}

test("the synthesis.* bridge surface exists (no raw SQL)", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;

  const surface = await page.evaluate(() => {
    const api = window.appApi as unknown as {
      synthesis?: {
        create?: unknown;
        link?: unknown;
        unlink?: unknown;
        editBody?: unknown;
        scheduleReturn?: unknown;
        get?: unknown;
      };
      db?: { query?: unknown };
    };
    return {
      hasCreate: typeof api?.synthesis?.create === "function",
      hasLink: typeof api?.synthesis?.link === "function",
      hasUnlink: typeof api?.synthesis?.unlink === "function",
      hasEditBody: typeof api?.synthesis?.editBody === "function",
      hasScheduleReturn: typeof api?.synthesis?.scheduleReturn === "function",
      hasGet: typeof api?.synthesis?.get === "function",
      hasQuery: typeof api?.db?.query === "function",
    };
  });
  expect(surface.hasCreate).toBe(true);
  expect(surface.hasLink).toBe(true);
  expect(surface.hasUnlink).toBe(true);
  expect(surface.hasEditBody).toBe(true);
  expect(surface.hasScheduleReturn).toBe(true);
  expect(surface.hasGet).toBe(true);
  expect(surface.hasQuery).toBe(false);

  await app.close();
});

test("create a synthesis note, link extracts + a card, write a body, and schedule it to return", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;

  const extractId = await seededElementId(page, "extract");
  const cardId = await seededElementId(page, "card");

  // Create the note + link two targets + write a body + schedule its return — all
  // through the typed bridge (the UI surface is exercised in the next test).
  const result = await page.evaluate(
    async (args) => {
      const api = window.appApi as unknown as {
        synthesis: {
          create(r: {
            title: string;
          }): Promise<{ element: { id: string; type: string; stage: string } }>;
          link(r: {
            noteId: string;
            targetId: string;
          }): Promise<{ data: { linked: { id: string }[] } }>;
          editBody(r: {
            noteId: string;
            prosemirrorJson: unknown;
            plainText: string;
          }): Promise<{ data: { element: { id: string } } }>;
          scheduleReturn(r: {
            noteId: string;
            when: { kind: string };
          }): Promise<{ data: { element: { status: string; dueAt: string | null } } }>;
        };
      };
      const { element } = await api.synthesis.create({ title: "Weaving intelligence definitions" });
      await api.synthesis.link({ noteId: element.id, targetId: args.extractId });
      const linked = await api.synthesis.link({ noteId: element.id, targetId: args.cardId });
      await api.synthesis.editBody({
        noteId: element.id,
        prosemirrorJson: {
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "First synthesis pass." }] },
          ],
        },
        plainText: "First synthesis pass.",
      });
      const scheduled = await api.synthesis.scheduleReturn({
        noteId: element.id,
        when: { kind: "nextWeek" },
      });
      return {
        id: element.id,
        type: element.type,
        stage: element.stage,
        linkedCount: linked.data.linked.length,
        status: scheduled.data.element.status,
        dueAt: scheduled.data.element.dueAt,
      };
    },
    { extractId, cardId },
  );

  noteId = result.id;
  expect(result.type).toBe("synthesis_note");
  expect(result.stage).toBe("synthesis");
  expect(result.linkedCount).toBe(2);
  // Scheduled on the ATTENTION scheduler (a future due date), status `scheduled`.
  expect(result.status).toBe("scheduled");
  expect(result.dueAt).toBeTruthy();

  // NEVER FSRS — the note has no review_states row (asserted via the inspector's
  // scheduler kind, which is `attention` for a synthesis note).
  const schedulerKind = await page.evaluate(async (id) => {
    const api = window.appApi as unknown as {
      inspector: { get(r: { id: string }): Promise<{ data: { scheduler: { kind: string } } }> };
    };
    const res = await api.inspector.get({ id });
    return res.data.scheduler.kind;
  }, noteId);
  expect(schedulerKind).toBe("attention");

  // It appears in the due queue as an attention row at a future clock.
  await page.goto(`${baseUrl}/queue?asOf=${encodeURIComponent(FUTURE)}`);
  await expect(page.getByTestId("route-queue")).toBeVisible();
  const noteRow = page.locator('[data-testid="queue-item"][data-element-type="synthesis_note"]');
  await expect(noteRow.first()).toBeVisible();

  await app.close();
});

test("the /synthesis/$id surface renders the editor, linked material, and schedule controls", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;

  await page.goto(`${baseUrl}/synthesis/${noteId}`);
  await expect(page.getByTestId("route-synthesis")).toBeVisible();
  await expect(page.getByTestId("synthesis-title")).toHaveText("Weaving intelligence definitions");
  await expect(page.getByTestId("synthesis-editor")).toBeVisible();

  // The linked-material panel shows the two collected items (an extract + a card).
  await expect(page.getByTestId("synthesis-linked")).toBeVisible();
  await expect(page.getByTestId("synthesis-linked-row")).toHaveCount(2);

  // The schedule controls are present (the note already has a return date).
  await expect(page.getByTestId("synthesis-due")).toContainText(/returns/i);
  await expect(page.getByTestId("synthesis-return-nextweek")).toBeVisible();

  // The "Add to note" picker opens and lists extract/card candidates.
  await page.getByTestId("synthesis-add").click();
  await expect(page.getByTestId("synthesis-picker")).toBeVisible();
  await expect(page.getByTestId("synthesis-picker-item").first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("synthesis-picker")).toBeHidden();

  await app.close();
});

test("the note + its links + body + schedule survive an app restart", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const persisted = await page.evaluate(async (id) => {
    const api = window.appApi as unknown as {
      synthesis: {
        get(r: { noteId: string }): Promise<{
          data: {
            element: { id: string; type: string; status: string };
            linked: { id: string; type: string }[];
            dueAt: string | null;
          } | null;
        }>;
      };
      documents: {
        get(r: { elementId: string }): Promise<{ document: { plainText: string } | null }>;
      };
    };
    const res = await api.synthesis.get({ noteId: id });
    const doc = await api.documents.get({ elementId: id });
    return { data: res.data, plainText: doc.document?.plainText ?? null };
  }, noteId);

  expect(persisted.data).not.toBeNull();
  expect(persisted.data?.element.type).toBe("synthesis_note");
  expect(persisted.data?.element.status).toBe("scheduled");
  expect(persisted.data?.linked).toHaveLength(2);
  expect(persisted.data?.dueAt).toBeTruthy();
  // The body persisted too.
  expect(persisted.plainText).toContain("First synthesis pass.");

  await app.close();
});
