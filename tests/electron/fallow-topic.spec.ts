/**
 * Topic rest / fallow E2E (T107) — drives the real Electron app.
 *
 * The inspector's topic-only rest control writes through validated IPC, persists
 * to SQLite, survives app restart, and can be cleared without exposing a raw DB
 * bridge to the renderer.
 */

import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

let dataDir: string;
let baseUrl: string;

const ACTIVE_AS_OF = "2027-06-01T12:00:00.000Z";
const FALLOW_UNTIL_INPUT = "2099-07-01";
const FALLOW_UNTIL_ISO = "2099-07-01T00:00:00.000Z";
const FALLOW_REASON = "E2E topic rest";
const EPUB_FIXTURE = path.resolve(
  __dirname,
  "..",
  "..",
  "packages",
  "importers",
  "src",
  "__fixtures__",
  "epub",
  "epub3-three-chapters.epub",
);

interface InspectorListItem {
  readonly id: string;
  readonly title: string;
  readonly type: string;
}

interface FallowFixture {
  readonly extractId: string;
  readonly cardId: string;
}

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
});

async function importTopic(page: Page): Promise<InspectorListItem> {
  return page.evaluate(async (fixturePath) => {
    const api = window.appApi as unknown as {
      sources: {
        importEpub(req: { path: string; priority: "A" | "B" | "C" | "D" }): Promise<{
          bookId: string;
        }>;
      };
      inspector: {
        list(): Promise<{ elements: InspectorListItem[] }>;
        get(req: { id: string }): Promise<{
          data: { source: { id: string } | null } | null;
        }>;
      };
    };
    const { bookId } = await api.sources.importEpub({ path: fixturePath, priority: "B" });
    const { elements } = await api.inspector.list();
    let topic: InspectorListItem | undefined;
    for (const item of elements) {
      if (item.type !== "topic") continue;
      const detail = await api.inspector.get({ id: item.id });
      if (detail.data?.source?.id === bookId) {
        topic = item;
        break;
      }
    }
    if (!topic) throw new Error("imported chapter topic not found");
    return topic;
  }, EPUB_FIXTURE);
}

async function selectElement(page: Page, item: InspectorListItem): Promise<void> {
  const clear = page.getByTestId("inspector-clear");
  if (await clear.isVisible()) {
    await clear.click();
  }
  const pickerItem = page.locator(
    `[data-testid="element-picker-item"][data-element-type="${item.type}"]`,
    { hasText: item.title },
  );
  await expect(pickerItem).toBeVisible();
  await pickerItem.click();
  await expect(page.getByTestId("inspector-content")).toBeVisible();
  await expect(page.getByTestId("inspector-title")).toHaveText(item.title);
}

async function inspectorFallowState(
  page: Page,
  id: string,
): Promise<{ fallowUntil: string | null; fallowReason: string | null }> {
  return page.evaluate(async (elementId) => {
    const api = window.appApi as unknown as {
      inspector: {
        get(req: { id: string }): Promise<{
          data: {
            element: {
              fallowUntil?: string | null;
              fallowReason?: string | null;
            };
          };
        }>;
      };
    };
    const result = await api.inspector.get({ id: elementId });
    return {
      fallowUntil: result.data.element.fallowUntil ?? null,
      fallowReason: result.data.element.fallowReason ?? null,
    };
  }, id);
}

async function createExtractAndCardUnderTopic(
  page: Page,
  topic: InspectorListItem,
): Promise<FallowFixture> {
  await page.goto(`${baseUrl}/source/${topic.id}`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("reader-title")).toBeVisible();

  const extractBlockId = await page.evaluate(() => {
    const nodes = Array.from(
      document.querySelectorAll<HTMLElement>(".reader .ProseMirror [data-block-id]"),
    );
    const para = nodes.find((node) => node.tagName.toLowerCase() === "p") ?? nodes[0];
    return para?.getAttribute("data-block-id") ?? "";
  });
  expect(extractBlockId).toBeTruthy();

  const block = page.locator(`.reader [data-block-id="${extractBlockId}"]`);
  await expect(block).toBeVisible();
  await block.click({ clickCount: 3 });
  await expect(page.getByTestId("selection-toolbar")).toBeVisible();
  await page.getByTestId("sel-tool-extract").click();
  await expect(page.getByTestId("reader-flash")).toContainText("Extracted");

  return page.evaluate(
    async ({ topicId }) => {
      const api = window.appApi as unknown as {
        inspector: {
          list(): Promise<{ elements: { id: string; type: string }[] }>;
          get(req: { id: string }): Promise<{
            data: {
              location: { sourceElementId: string | null } | null;
            } | null;
          }>;
        };
        extracts: {
          postpone(req: { id: string }): Promise<unknown>;
        };
        cards: {
          create(req: {
            extractId: string;
            kind: "qa";
            prompt: string;
            answer: string;
          }): Promise<{ card: { id: string } }>;
        };
      };
      const { elements } = await api.inspector.list();
      let extractId: string | null = null;
      for (const element of elements) {
        if (element.type !== "extract") continue;
        const detail = await api.inspector.get({ id: element.id });
        if (detail.data?.location?.sourceElementId === topicId) {
          extractId = element.id;
          break;
        }
      }
      if (!extractId) throw new Error("topic extract not found");
      await api.extracts.postpone({ id: extractId });
      const { card } = await api.cards.create({
        extractId,
        kind: "qa",
        prompt: "What continues while the topic rests?",
        answer: "Card review continues.",
      });
      return { extractId, cardId: card.id };
    },
    { topicId: topic.id },
  );
}

async function queueRow(
  page: Page,
  id: string,
  asOf: string,
): Promise<{
  id: string;
  fallowState: "active" | "returned" | null;
  fallowUntil: string | null;
  fallowReason: string | null;
  fallowTopicId: string | null;
} | null> {
  return page.evaluate(
    async ({ id, asOf }) => {
      const api = window.appApi as unknown as {
        queue: {
          list(req: { asOf: string }): Promise<{
            items: {
              id: string;
              fallowState: "active" | "returned" | null;
              fallowUntil: string | null;
              fallowReason: string | null;
              fallowTopicId: string | null;
            }[];
          }>;
        };
      };
      const { items } = await api.queue.list({ asOf });
      return items.find((item) => item.id === id) ?? null;
    },
    { id, asOf },
  );
}

async function reviewCardView(
  page: Page,
  cardId: string,
  asOf: string,
): Promise<{
  id: string;
  fallowContext: {
    topicId: string;
    topicTitle: string;
    fallowUntil: string;
    fallowReason: string | null;
  } | null;
} | null> {
  return page.evaluate(
    async ({ cardId, asOf }) => {
      const api = window.appApi as unknown as {
        review: {
          sessionNext(req: { asOf: string; exclude?: readonly string[] }): Promise<{
            card: {
              id: string;
              fallowContext: {
                topicId: string;
                topicTitle: string;
                fallowUntil: string;
                fallowReason: string | null;
              } | null;
            } | null;
          }>;
        };
      };
      const exclude: string[] = [];
      for (let i = 0; i < 30; i++) {
        const { card } = await api.review.sessionNext({ asOf, exclude });
        if (!card) return null;
        if (card.id === cardId) return card;
        exclude.push(card.id);
      }
      return null;
    },
    { cardId, asOf },
  );
}

test("topic rest writes through appApi, survives restart, and can be cleared", async () => {
  let app = await launchApp(dataDir, { seedOnEmpty: true });
  let page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;

  const surface = await page.evaluate(() => {
    const api = window.appApi as unknown as {
      topics?: { fallow?: unknown; unfallow?: unknown };
      db?: { query?: unknown };
    };
    return {
      hasFallow: typeof api?.topics?.fallow === "function",
      hasUnfallow: typeof api?.topics?.unfallow === "function",
      hasQuery: typeof api?.db?.query === "function",
    };
  });
  expect(surface).toEqual({ hasFallow: true, hasUnfallow: true, hasQuery: false });

  const topic = await importTopic(page);
  const fixture = await createExtractAndCardUnderTopic(page, topic);
  expect(await queueRow(page, fixture.extractId, ACTIVE_AS_OF)).toMatchObject({
    id: fixture.extractId,
    fallowState: null,
  });
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await selectElement(page, topic);
  await expect(page.getByTestId("fallow-section")).toContainText("Not resting");

  await page.getByTestId("fallow-date").fill(FALLOW_UNTIL_INPUT);
  await page.getByTestId("fallow-reason").fill(FALLOW_REASON);
  await page.getByTestId("fallow-apply").click();

  await expect(page.getByTestId("fallow-section")).toContainText("Resting");
  await expect(page.getByTestId("fallow-current")).toContainText(FALLOW_UNTIL_INPUT);
  await expect(page.getByTestId("fallow-current")).toContainText(FALLOW_REASON);
  expect(await inspectorFallowState(page, topic.id)).toEqual({
    fallowUntil: FALLOW_UNTIL_ISO,
    fallowReason: FALLOW_REASON,
  });
  expect(await queueRow(page, fixture.extractId, ACTIVE_AS_OF)).toBeNull();
  expect(await queueRow(page, fixture.extractId, FALLOW_UNTIL_ISO)).toMatchObject({
    id: fixture.extractId,
    fallowState: "returned",
    fallowUntil: FALLOW_UNTIL_ISO,
    fallowReason: FALLOW_REASON,
    fallowTopicId: topic.id,
  });
  expect(await reviewCardView(page, fixture.cardId, ACTIVE_AS_OF)).toMatchObject({
    id: fixture.cardId,
    fallowContext: {
      topicId: topic.id,
      fallowUntil: FALLOW_UNTIL_ISO,
      fallowReason: FALLOW_REASON,
    },
  });

  await app.close();

  app = await launchApp(dataDir, { seedOnEmpty: true });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await selectElement(page, topic);
  await expect(page.getByTestId("fallow-section")).toContainText("Resting");
  await expect(page.getByTestId("fallow-current")).toContainText(FALLOW_UNTIL_INPUT);
  await expect(page.getByTestId("fallow-current")).toContainText(FALLOW_REASON);
  expect(await inspectorFallowState(page, topic.id)).toEqual({
    fallowUntil: FALLOW_UNTIL_ISO,
    fallowReason: FALLOW_REASON,
  });
  expect(await queueRow(page, fixture.extractId, ACTIVE_AS_OF)).toBeNull();
  expect(await reviewCardView(page, fixture.cardId, ACTIVE_AS_OF)).toMatchObject({
    id: fixture.cardId,
    fallowContext: {
      topicId: topic.id,
      fallowUntil: FALLOW_UNTIL_ISO,
      fallowReason: FALLOW_REASON,
    },
  });

  await page.getByTestId("fallow-clear").click();
  await expect(page.getByTestId("fallow-section")).toContainText("Not resting");
  expect(await inspectorFallowState(page, topic.id)).toEqual({
    fallowUntil: null,
    fallowReason: null,
  });
  expect(await queueRow(page, fixture.extractId, ACTIVE_AS_OF)).toMatchObject({
    id: fixture.extractId,
    fallowState: null,
  });

  await app.close();
});
