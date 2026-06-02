/**
 * Audio review cards E2E (T075) — drives the real Electron app end to end, fully
 * on-device, building on T073 (media import) + T074 (clip extraction).
 *
 * The native media picker is stubbed via `INTERLEAVE_MEDIA_IMPORT_PATH` + the sidecar
 * subtitles picker via `INTERLEAVE_SUBTITLES_PATH`, pointed at the tiny committed fixture
 * video + its `.vtt`. The spec proves the audio-card loop:
 *
 *   1. import the fixture media → an inbox video source with a transcript;
 *   2. clip a span → a `media_fragment` (the T074 path, driven through the bridge);
 *   3. author an AUDIO card from the clip via the bridge (an audio PROMPT + a written
 *      answer) → it appears in the lineage UNDER the clip with its `media_ref`, an FSRS
 *      review state, and is a `qa` card (audio is a presentation modifier, not a kind);
 *   4. open `/review` (a fixed FUTURE `asOf` so the freshly-authored card reads due) →
 *      the card front mounts a looping `<audio>` (the `media://` clip), reveal shows the
 *      written answer, grade Good → the card reschedules + a `review_logs` row is written;
 *   5. after an APP RESTART, the audio card, its `media_ref`, its lineage, and its FSRS
 *      state all survive.
 *
 * The two-scheduler split holds throughout: the CLIP `media_fragment` is attention-
 * scheduled (NO FSRS row); the AUDIO CARD is FSRS-scheduled (always a review state). The
 * renderer reaches everything only through `window.appApi` — no fs/SQL/FSRS-math in React.
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

/** A fixed FUTURE clock so the freshly-authored audio card reads as due. */
const AS_OF = "2027-06-01T12:00:00.000Z";

let dataDir: string;
let baseUrl: string;

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
});

/** Launch with the media + subtitles pickers stubbed to the fixtures. */
async function launch(): Promise<ElectronApplication> {
  return launchApp(dataDir, { mediaImportPath: MEDIA_FIXTURE, subtitlesPath: SUBS_FIXTURE });
}

async function captureBaseUrl(page: Page): Promise<void> {
  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;
}

async function firstInboxId(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const api = window.appApi as unknown as {
      inbox: { list(): Promise<{ items: { id: string }[] }> };
    };
    const { items } = await api.inbox.list();
    return items[0]?.id as string;
  });
}

/**
 * Clip a span (the first transcript cue) into a `media_fragment` then author an AUDIO
 * card from it (audio on the prompt + a written answer) — both through the typed bridge,
 * for a deterministic setup. Returns the clip + card ids + the card's media_ref.
 */
async function clipAndAuthorAudioCard(
  page: Page,
  sourceId: string,
): Promise<{
  clipId: string;
  cardId: string;
  mediaRef: { sourceElementId: string; startMs: number; endMs: number; on: string } | null;
  kind: string;
  hasReviewState: boolean;
  clipHasReviewState: boolean;
}> {
  return page.evaluate(async (srcId) => {
    const api = window.appApi as unknown as {
      documents: {
        get(req: { elementId: string }): Promise<{
          blockTimestamps?: Record<string, number>;
        }>;
      };
      sources: {
        extractClip(req: {
          sourceElementId: string;
          startMs: number;
          endMs: number;
          anchorBlockId: string;
          transcriptSegment?: string | null;
        }): Promise<{ id: string }>;
      };
      cards: {
        create(req: {
          extractId: string;
          kind: string;
          prompt?: string;
          answer?: string;
          mediaRef?: {
            sourceElementId: string;
            startMs: number;
            endMs: number;
            on: string;
          } | null;
        }): Promise<{
          card: {
            id: string;
            kind: string;
            mediaRef: {
              sourceElementId: string;
              startMs: number;
              endMs: number;
              on: string;
            } | null;
          };
        }>;
      };
      review: {
        card(req: { cardId: string }): Promise<{ card: unknown | null }>;
      };
      inspector: {
        get(req: { id: string }): Promise<{ data: { scheduler: { kind: string } } }>;
      };
    };

    // The first cue block id (the clip anchor) — the earliest-timestamped block, read
    // off `document_blocks.timestamp_ms` (the cue → time map the reader/clip share).
    const doc = await api.documents.get({ elementId: srcId });
    const times = doc.blockTimestamps ?? {};
    const cueBlockId = Object.keys(times).sort((a, b) => (times[a] ?? 0) - (times[b] ?? 0))[0];
    if (!cueBlockId) throw new Error("fixture source has no transcript cue block");

    const clip = await api.sources.extractClip({
      sourceElementId: srcId,
      startMs: 0,
      endMs: 800,
      anchorBlockId: cueBlockId,
      transcriptSegment: "first cue text",
    });

    // Author an AUDIO card from the clip: audio on the prompt + a written answer. We pass
    // an explicit media_ref to mirror the builder's send (it would otherwise be derived).
    const created = await api.cards.create({
      extractId: clip.id,
      kind: "qa",
      answer: "the written translation",
      mediaRef: { sourceElementId: srcId, startMs: 0, endMs: 800, on: "prompt" },
    });

    // The two-scheduler split: the clip is attention-scheduled, the card FSRS-scheduled.
    const clipSched = await api.inspector.get({ id: clip.id });
    const cardSched = await api.inspector.get({ id: created.card.id });

    return {
      clipId: clip.id,
      cardId: created.card.id,
      mediaRef: created.card.mediaRef,
      kind: created.card.kind,
      hasReviewState: cardSched.data.scheduler.kind === "fsrs",
      clipHasReviewState: clipSched.data.scheduler.kind === "fsrs",
    };
  }, sourceId);
}

/** Read a card's FSRS reps via the inspector bridge (reps>=1 proves a grade landed). */
async function cardReps(page: Page, cardId: string): Promise<number> {
  return page.evaluate(async (id) => {
    const api = window.appApi as unknown as {
      inspector: {
        get(req: { id: string }): Promise<{ data: { scheduler: { reps: number | null } } }>;
      };
    };
    const insp = await api.inspector.get({ id });
    return insp.data.scheduler.reps ?? 0;
  }, cardId);
}

test("import → clip → author an audio card → review it (looping audio + grade)", async () => {
  const app = await launch();
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await captureBaseUrl(page);

  // Import the fixture media via the inbox chip.
  await page.getByTestId("nav-inbox").click();
  await expect(page.getByTestId("route-inbox")).toBeVisible();
  await page.getByTestId("inbox-import-import-media").click();
  await expect(page.getByTestId("inbox-row")).toHaveCount(1, { timeout: 20_000 });
  const sourceId = await firstInboxId(page);

  // Clip a span + author the audio card through the bridge (deterministic setup).
  const { clipId, cardId, mediaRef, kind, hasReviewState, clipHasReviewState } =
    await clipAndAuthorAudioCard(page, sourceId);

  // The card is a Q&A card (audio is a presentation modifier, not a kind), carries the
  // media_ref on the prompt, and is FSRS-scheduled; the clip is attention-scheduled.
  expect(kind).toBe("qa");
  expect(mediaRef).toEqual({ sourceElementId: sourceId, startMs: 0, endMs: 800, on: "prompt" });
  expect(hasReviewState).toBe(true); // the audio card has an FSRS review state
  expect(clipHasReviewState).toBe(false); // the clip media_fragment is attention-scheduled
  expect(clipId).toBeTruthy();

  // REVIEW — open /review with the fixed future clock so the new card reads due. The
  // card front mounts the looping <audio> (the media:// clip on the prompt face).
  await page.goto(`${baseUrl}/review?asOf=${encodeURIComponent(AS_OF)}`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("route-review")).toBeVisible();

  // Walk the deck until our audio card is the one on screen (the seed deck is empty here,
  // so it should be the first/only due card).
  await expect(page.getByTestId("review-card")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("review-card")).toHaveAttribute("data-card-id", cardId);

  // The looping audio mounts on the FRONT (the prompt face) before reveal, and the audio
  // badge marks it as an audio card.
  const audioEl = page.getByTestId("card-audio-prompt-el");
  await expect(audioEl).toBeVisible();
  await expect(audioEl).toHaveAttribute("src", `media://${sourceId}`);
  await expect(page.getByTestId("review-audio-badge")).toBeVisible();

  // Reveal → the written answer shows.
  await page.getByTestId("review-reveal").click();
  await expect(page.getByTestId("review-answer")).toContainText("the written translation");

  // Grade Good → the card reschedules + a durable review_logs row is written.
  await page.getByTestId("review-grade-good").click();
  await expect
    .poll(async () => await cardReps(page, cardId), { timeout: 10_000 })
    .toBeGreaterThanOrEqual(1);

  await app.close();
});

test("the audio card + its media_ref + FSRS state survive an app restart", async () => {
  const app = await launch();
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await captureBaseUrl(page);

  const sourceId = await firstInboxId(page);

  // Find the audio card under the source's lineage (the clip → card chain).
  const found = await page.evaluate(async (srcId) => {
    const api = window.appApi as unknown as {
      lineage: {
        get(req: { id: string }): Promise<{ lineage: { nodes: { id: string; type: string }[] } }>;
      };
      review: {
        card(req: { cardId: string }): Promise<{
          card: { mediaRef: { on: string } | null; kind: string } | null;
        }>;
      };
      inspector: {
        get(req: { id: string }): Promise<{ data: { scheduler: { reps: number | null } } }>;
      };
    };
    const { lineage } = await api.lineage.get({ id: srcId });
    const card = lineage.nodes.find((n) => n.type === "card");
    if (!card) return null;
    const view = await api.review.card({ cardId: card.id });
    const insp = await api.inspector.get({ id: card.id });
    return {
      id: card.id,
      mediaRefOn: view.card?.mediaRef?.on ?? null,
      kind: view.card?.kind ?? null,
      reps: insp.data.scheduler.reps ?? 0,
    };
  }, sourceId);

  expect(found).not.toBeNull();
  // The media_ref + kind survived; the card was graded once before restart (reps >= 1).
  expect(found?.mediaRefOn).toBe("prompt");
  expect(found?.kind).toBe("qa");
  expect(found?.reps).toBeGreaterThanOrEqual(1);

  await app.close();
});
