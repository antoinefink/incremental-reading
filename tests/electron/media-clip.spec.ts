/**
 * Media clip extraction E2E (T074) — drives the real Electron app end to end, fully
 * on-device, building on the T073 media import.
 *
 * The native media picker is stubbed via `INTERLEAVE_MEDIA_IMPORT_PATH` + the sidecar
 * subtitles picker via `INTERLEAVE_SUBTITLES_PATH` (the unpackaged-build escape), pointed
 * at the tiny committed fixture video + its `.vtt`. The spec proves:
 *
 *   1. importing the fixture media → an `inbox` video source with a transcript;
 *   2. in the media reader, setting an in/out point (the transcript-cue alternate entry:
 *      Shift-click two cues) and confirming creates a scheduled `media_fragment` clip
 *      whose `source_locations` row carries the start `timestamp_ms` + the clip window +
 *      the transcript segment + a "Clip M:SS–M:SS" label;
 *   3. the clip is attention-scheduled (a `due_at`, NO FSRS row — proven via the bridge);
 *   4. after an APP RESTART against the same data dir, the clip fragment + its clip
 *      location survive.
 *
 * The renderer reaches all of this only through `window.appApi` — no fs/SQL in React;
 * the clip create + location write run main-side in one transaction.
 */

import path from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

const FIXTURE_DIR = path.resolve(
  __dirname,
  "..",
  "..",
  "packages",
  "importers",
  "src",
  "__fixtures__",
  "transcript",
);
const MEDIA_FIXTURE = path.join(FIXTURE_DIR, "tiny-video.mp4");
const SUBS_FIXTURE = path.join(FIXTURE_DIR, "tiny-video.vtt");

let dataDir: string;
let baseUrl: string;

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
});

/** Launch the app with the media + subtitles pickers stubbed to the fixtures. */
async function launch(): Promise<ElectronApplication> {
  return launchApp(dataDir, { mediaImportPath: MEDIA_FIXTURE, subtitlesPath: SUBS_FIXTURE });
}

/** The renderer base URL (`app://…`) captured from the first window. */
async function captureBaseUrl(page: Page): Promise<void> {
  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;
}

/** Read the one inbox source id via the bridge. */
async function firstInboxId(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const api = window.appApi as unknown as {
      inbox: { list(): Promise<{ items: { id: string }[] }> };
    };
    const { items } = await api.inbox.list();
    return items[0]?.id as string;
  });
}

/** The `media_fragment` children of a source, with their clip locations, via the bridge. */
async function clipChildren(
  page: Page,
  sourceId: string,
): Promise<
  {
    id: string;
    type: string;
    dueAt: string | null;
    schedulerKind: string;
    clip: { startMs: number; endMs: number } | null;
    timestampMs: number | null;
    label: string | null;
  }[]
> {
  return page.evaluate(async (id) => {
    const api = window.appApi as unknown as {
      lineage: {
        get(req: { id: string }): Promise<{
          lineage: { nodes: { id: string; type: string }[] };
        }>;
      };
      inspector: {
        get(req: { id: string }): Promise<{
          data: {
            element: { dueAt: string | null };
            scheduler: { kind: string };
            location: {
              clip: { startMs: number; endMs: number } | null;
              timestampMs: number | null;
              label: string | null;
            } | null;
          };
        }>;
      };
    };
    const { lineage } = await api.lineage.get({ id });
    const fragments = lineage.nodes.filter((n) => n.type === "media_fragment" && n.id !== id);
    const out: unknown[] = [];
    for (const f of fragments) {
      const { data } = await api.inspector.get({ id: f.id });
      out.push({
        id: f.id,
        type: f.type,
        dueAt: data.element.dueAt,
        schedulerKind: data.scheduler.kind,
        clip: data.location?.clip ?? null,
        timestampMs: data.location?.timestampMs ?? null,
        label: data.location?.label ?? null,
      });
    }
    return out as never;
  }, sourceId);
}

test("importing media then clipping a cue range creates a scheduled media_fragment", async () => {
  const app = await launch();
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await captureBaseUrl(page);

  // Import the fixture media via the inbox chip.
  await page.getByTestId("nav-inbox").click();
  await expect(page.getByTestId("route-inbox")).toBeVisible();
  await page.getByTestId("inbox-import-import-media").click();
  await expect(page.getByTestId("inbox-row")).toHaveCount(1, { timeout: 20_000 });
  const id = await firstInboxId(page);

  // Open the media reader.
  await page.goto(`${baseUrl}/source/${id}`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("media-reader")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("media-reader-cue")).toHaveCount(2);

  // The transcript-cue alternate entry to clip selection: Shift-click the first cue
  // (sets the in-point) then the second (sets the out-point) — deterministic, no
  // playback needed.
  await page
    .getByTestId("media-reader-cue")
    .nth(0)
    .click({ modifiers: ["Shift"] });
  await page
    .getByTestId("media-reader-cue")
    .nth(1)
    .click({ modifiers: ["Shift"] });

  // The confirm popover appears; confirm the clip.
  await expect(page.getByTestId("media-clip-popover")).toBeVisible();
  await page.getByTestId("media-clip-confirm").click();
  await expect(page.getByTestId("reader-flash")).toContainText("saved as a topic", {
    timeout: 10_000,
  });

  // Through the bridge: a `media_fragment` clip child now exists, attention-scheduled,
  // with a clip window + start timestamp + a "Clip …" label, and NO FSRS row.
  const children = await clipChildren(page, id);
  expect(children).toHaveLength(1);
  const clip = children[0];
  expect(clip?.type).toBe("media_fragment");
  expect(clip?.dueAt).not.toBeNull();
  expect(clip?.schedulerKind).toBe("attention"); // attention-scheduled, never FSRS
  expect(clip?.clip).not.toBeNull();
  expect(clip?.timestampMs).toBe(clip?.clip?.startMs);
  expect(clip?.label).toMatch(/^Clip /);

  await app.close();
});

test("the clip fragment + its clip location survive an app restart", async () => {
  const app = await launch();
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await captureBaseUrl(page);

  const id = await firstInboxId(page);

  // The clip fragment + its window are still present after restart.
  const children = await clipChildren(page, id);
  expect(children).toHaveLength(1);
  expect(children[0]?.type).toBe("media_fragment");
  expect(children[0]?.clip).not.toBeNull();
  expect(children[0]?.schedulerKind).toBe("attention");

  // The clip's inspector mini player mounts when its extract detail view is opened.
  await page.goto(`${baseUrl}/extract/${children[0]?.id}`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("extract-clip")).toBeVisible({ timeout: 20_000 });

  await app.close();
});
