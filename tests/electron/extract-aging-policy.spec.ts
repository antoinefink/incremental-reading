/**
 * Extract-aging policy (T121) E2E — drives the real Electron app.
 *
 * The fixture plants one old, repeatedly returned extract. The test enables the
 * automatic policy through the typed settings bridge, opens the current-day queue
 * to materialize trusted daily policy work, then asserts the receipt, durable fate,
 * restart behavior, and receipt undo through `window.appApi`.
 */

import { expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);

let dataDir: string;
let baseUrl: string;
let extractId: string;

async function openCurrentQueue(page: Page): Promise<void> {
  await page.goto(`${baseUrl}/queue`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("route-queue")).toBeVisible();
}

async function agingFixtureId(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const api = window.appApi as unknown as {
      inspector: { list(): Promise<{ elements: { id: string; type: string; title: string }[] }> };
    };
    const { elements } = await api.inspector.list();
    const extract = elements.find(
      (e) => e.type === "extract" && e.title === "Aging policy raw extract",
    );
    if (!extract) throw new Error("extract-aging fixture not found");
    return extract.id;
  });
}

async function extractState(
  page: Page,
  id: string,
): Promise<{
  status: string | null;
  extractFate: string | null;
}> {
  return page.evaluate(async (elementId) => {
    const api = window.appApi as unknown as {
      inspector: {
        get(req: { id: string }): Promise<{
          data: { element: { status: string | null; extractFate: string | null } } | null;
        }>;
      };
    };
    const result = await api.inspector.get({ id: elementId });
    return {
      status: result.data?.element.status ?? null,
      extractFate: result.data?.element.extractFate ?? null,
    };
  }, id);
}

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
});

test("automatic extract aging materializes once, survives restart, and undoes by receipt", async () => {
  const app1 = await launchApp(dataDir, { seedExtractAging: true });
  const page1 = await app1.firstWindow();
  await page1.waitForLoadState("domcontentloaded");
  const url = new URL(page1.url());
  baseUrl = `${url.protocol}//${url.host}`;

  const surface = await page1.evaluate(() => {
    const api = window.appApi as unknown as {
      extractAging?: { preview?: unknown; apply?: unknown; undoReceipt?: unknown };
      db?: { query?: unknown };
    };
    return {
      hasPreview: typeof api.extractAging?.preview === "function",
      hasApply: typeof api.extractAging?.apply === "function",
      hasUndo: typeof api.extractAging?.undoReceipt === "function",
      hasQuery: typeof api.db?.query === "function",
    };
  });
  expect(surface).toEqual({ hasPreview: true, hasApply: true, hasUndo: true, hasQuery: false });

  extractId = await agingFixtureId(page1);
  await page1.evaluate(async () => {
    const api = window.appApi as unknown as {
      settings: { updateMany(req: { patch: Record<string, unknown> }): Promise<unknown> };
    };
    await api.settings.updateMany({
      patch: {
        extractAgingPolicy: "automatic",
        extractAgingReturnThreshold: 5,
        extractAgingAgeDays: 30,
      },
    });
  });

  const previewBefore = await page1.evaluate(async () => {
    const api = window.appApi as unknown as {
      extractAging: {
        preview(): Promise<{ candidateCount: number; candidates: { id: string }[] }>;
      };
    };
    return api.extractAging.preview();
  });
  expect(previewBefore.candidateCount).toBe(1);
  expect(previewBefore.candidates.map((c) => c.id)).toContain(extractId);

  await openCurrentQueue(page1);
  const receipt1 = page1.getByTestId("extract-aging-receipt");
  await expect(receipt1).toBeVisible();
  await expect(receipt1).toContainText("returned to reference");
  await expect(
    page1.locator(`[data-testid="queue-item"][data-element-id="${extractId}"]`),
  ).toHaveCount(0);
  expect(await extractState(page1, extractId)).toEqual({
    status: "done",
    extractFate: "reference",
  });
  await app1.close();

  const app2 = await launchApp(dataDir, { seedExtractAging: true });
  const page2 = await app2.firstWindow();
  await page2.waitForLoadState("domcontentloaded");
  const url2 = new URL(page2.url());
  baseUrl = `${url2.protocol}//${url2.host}`;
  await openCurrentQueue(page2);
  await expect(page2.getByTestId("extract-aging-receipt")).toBeVisible();
  expect(await extractState(page2, extractId)).toEqual({
    status: "done",
    extractFate: "reference",
  });

  await page2.getByTestId("extract-aging-receipt-undo").click();
  await expect(page2.getByTestId("extract-aging-receipt-undone")).toBeVisible();
  expect(await extractState(page2, extractId)).toEqual({ status: "scheduled", extractFate: null });
  await expect(
    page2.locator(`[data-testid="queue-item"][data-element-id="${extractId}"]`),
  ).toBeVisible();

  await app2.close();
});
