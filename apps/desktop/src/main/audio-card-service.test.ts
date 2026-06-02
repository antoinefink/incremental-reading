/**
 * Audio-card integration tests (T075) — against a real temp-file SQLite DB + a temp
 * `assetsDir`, driving the SAME `DbService` seams the IPC layer uses (no Electron).
 *
 * Builds the full lineage: import the tiny fixture media (T073) → clip a span into a
 * `media_fragment` (T074) → author an AUDIO card from that clip (T075). Proves:
 *  - `cards.create` with a `media_ref` stores it on `cards.media_ref` and surfaces it on
 *    the `ReviewCardView` (with the resolved `mediaSource`/`youtubeId`);
 *  - the audio card is DERIVED from the clip when no explicit ref is passed (window +
 *    media source copied), and inherits the clip's source location (jump-to-source);
 *  - the two-scheduler split holds: the CLIP `media_fragment` has NO `review_states` row
 *    (attention), but the AUDIO CARD does (FSRS) — and it is selected/graded/rescheduled
 *    by the FSRS path exactly like a text card, writing a durable `review_logs` row;
 *  - sibling burying: two audio cards from one clip set share a `siblingGroupId`;
 *  - the audio card + its `media_ref` + lineage + FSRS state survive a DB re-open.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MIGRATIONS_DIR } from "@interleave/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DbService } from "./db-service";

const FIXTURES = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "packages",
  "importers",
  "src",
  "__fixtures__",
  "transcript",
);
const TINY_VIDEO = path.join(FIXTURES, "tiny-video.mp4");
const TINY_VTT = path.join(FIXTURES, "tiny-video.vtt");

let dir: string;
let dbPath: string;
let assetsDir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "interleave-audiocard-"));
  dbPath = path.join(dir, "app.sqlite");
  assetsDir = path.join(dir, "assets");
  fs.mkdirSync(assetsDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function openSvc(): DbService {
  const svc = new DbService();
  svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR, assetsDir });
  return svc;
}

/** Import the fixture media + clip a span; return the media source id + clip fragment id. */
async function seedClip(svc: DbService): Promise<{ sourceId: string; clipId: string }> {
  const { id: sourceId } = await svc.mediaImportService.importFromFile({
    filePath: TINY_VIDEO,
    subtitlesPath: TINY_VTT,
  });
  const blocks = svc.repos.documents.listBlocks(sourceId as never);
  const firstCue = blocks.find((b) => typeof b.timestampMs === "number");
  if (!firstCue) throw new Error("fixture has no transcript cue block");
  const clip = await svc.extractClip({
    sourceElementId: sourceId,
    startMs: 0,
    endMs: 800,
    anchorBlockId: firstCue.stableBlockId,
    transcriptSegment: "first cue text",
  });
  return { sourceId, clipId: clip.id };
}

describe("Audio card (T075) — created from a clip media_fragment", () => {
  it("derives a media_ref from the clip, stores it, and surfaces it on the ReviewCardView", async () => {
    const svc = openSvc();
    const { sourceId, clipId } = await seedClip(svc);

    // Author an audio card from the clip. No explicit media_ref → derived from the clip.
    const { card } = svc.createCard({
      extractId: clipId,
      kind: "qa",
      prompt: "", // the audio IS the prompt (an audio-prompt card)
      answer: "the written translation",
    });
    expect(card.mediaRef).toEqual({
      sourceElementId: sourceId,
      startMs: 0,
      endMs: 800,
      on: "prompt",
    });

    // Stored on cards.media_ref.
    const row = svc.repos.review.findCardById(card.id as never);
    expect(JSON.parse(row?.card.mediaRef ?? "null")).toEqual({
      sourceElementId: sourceId,
      startMs: 0,
      endMs: 800,
      on: "prompt",
    });

    // The ReviewCardView surfaces the audio fields (so the renderer plays without a
    // second round-trip). The media source is a LOCAL vault asset.
    const view = svc.reviewCard({ cardId: card.id }).card;
    expect(view?.mediaRef?.on).toBe("prompt");
    expect(view?.mediaRef?.sourceElementId).toBe(sourceId);
    expect(view?.mediaSource).toBe("local");
    expect(view?.youtubeId).toBeNull();
    // The card is still a Q&A card — audio is a presentation modifier, not a kind.
    expect(view?.kind).toBe("qa");

    svc.close();
  });

  it("inherits the clip's source location (jump-to-source seeks the clip)", async () => {
    const svc = openSvc();
    const { clipId } = await seedClip(svc);
    const clipLocation = svc.repos.sources.findLocationForElement(clipId as never);

    const { sourceLocationId } = svc.createCard({
      extractId: clipId,
      kind: "qa",
      prompt: "",
      answer: "translation",
    });
    expect(sourceLocationId).toBe(clipLocation?.id);

    svc.close();
  });

  it("holds the two-scheduler split: the clip is attention-scheduled, the audio card is FSRS", async () => {
    const svc = openSvc();
    const { clipId } = await seedClip(svc);

    const { card } = svc.createCard({
      extractId: clipId,
      kind: "qa",
      prompt: "",
      answer: "translation",
    });

    // The CLIP fragment is attention-scheduled — NO review_states row.
    expect(svc.repos.review.findReviewState(clipId as never)).toBeNull();
    // The AUDIO CARD is FSRS-scheduled — it HAS a review_states row, first-scheduled due.
    const rs = svc.repos.review.findReviewState(card.id as never);
    expect(rs).not.toBeNull();
    expect(rs?.fsrsState).toBe("new");

    svc.close();
  });

  it("is selected/graded/rescheduled by the FSRS path exactly like a text card", async () => {
    const svc = openSvc();
    const { clipId } = await seedClip(svc);
    const { card } = svc.createCard({
      extractId: clipId,
      kind: "qa",
      prompt: "",
      answer: "translation",
    });

    // The audio card surfaces in the due deck (the SAME session seam a text card uses).
    const asOf = "2099-01-01T00:00:00.000Z";
    const seen: string[] = [];
    let found = false;
    for (let i = 0; i < 200; i++) {
      const res = svc.reviewSessionNext({ asOf, exclude: seen });
      if (!res.card) break;
      if (res.card.id === card.id) {
        found = true;
        break;
      }
      seen.push(res.card.id);
    }
    expect(found).toBe(true);

    // Grade Good → FSRS advances out of "new" + a durable review_logs row is written.
    const before = svc.repos.review.listReviewLogs(card.id as never).length;
    const graded = svc.gradeCard(card.id as never, "good", 1200, asOf);
    expect(graded.reviewState.reps).toBe(1);
    expect(graded.reviewState.fsrsState).not.toBe("new");
    expect(svc.repos.review.listReviewLogs(card.id as never).length).toBe(before + 1);
    // The grade appended an add_review_log op.
    const ops = svc.repos.operationLog.listForElement(card.id as never).map((o) => o.opType);
    expect(ops).toContain("add_review_log");

    svc.close();
  });

  it("two audio cards from one clip share a siblingGroupId (sibling burying)", async () => {
    const svc = openSvc();
    const { clipId } = await seedClip(svc);

    const a = svc.createCard({ extractId: clipId, kind: "qa", prompt: "", answer: "one" });
    const b = svc.createCard({
      extractId: clipId,
      kind: "qa",
      prompt: "",
      answer: "two",
      siblingGroupId: a.card.siblingGroupId,
    });
    expect(b.card.siblingGroupId).toBe(a.card.siblingGroupId);

    svc.close();
  });

  it("survives a full close + reopen — the media_ref + lineage + FSRS state persist", async () => {
    const first = openSvc();
    const { sourceId, clipId } = await seedClip(first);
    const { card } = first.createCard({
      extractId: clipId,
      kind: "qa",
      prompt: "",
      answer: "translation",
    });
    const cardId = card.id;
    // Grade once so there is durable FSRS state to re-read.
    first.gradeCard(cardId as never, "good", 1000, "2099-01-01T00:00:00.000Z");
    first.close();

    const second = openSvc();
    const reopened = second.repos.review.findCardById(cardId as never);
    expect(JSON.parse(reopened?.card.mediaRef ?? "null")).toEqual({
      sourceElementId: sourceId,
      startMs: 0,
      endMs: 800,
      on: "prompt",
    });
    // Lineage: the card still points at the clip (parent) + the media source root.
    expect(reopened?.element.parentId).toBe(clipId);
    // FSRS state survived.
    const rs = second.repos.review.findReviewState(cardId as never);
    expect(rs?.reps).toBe(1);
    expect(rs?.fsrsState).not.toBe("new");
    // The ReviewCardView still resolves the audio fields after restart.
    const view = second.reviewCard({ cardId }).card;
    expect(view?.mediaRef?.sourceElementId).toBe(sourceId);
    expect(view?.mediaSource).toBe("local");
    second.close();
  });
});
