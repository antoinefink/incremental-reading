/**
 * MediaClipService integration tests (T074) — against a real temp-file SQLite DB +
 * a temp `assetsDir`. We first import the tiny committed fixture media file (the T073
 * `MediaImportService`, which knows `durationMs`), then clip a span through the SAME
 * `DbService.extractClip` seam the IPC layer uses. No Electron is involved.
 *
 * Proves:
 *  - a clip request creates a `media_fragment` extract with a `source_locations` row
 *    carrying the start `timestamp_ms` + the `clip { startMs, endMs }` window + the
 *    transcript segment, appends `create_extract`, and is ATTENTION-scheduled (has an
 *    `elements.due_at`, NO `review_states` row — the two-scheduler split holds);
 *  - the clip + location survive a DB re-open (restart-persistence);
 *  - a clip whose `endMs > durationMs` is rejected, writing no fragment;
 *  - NO asset is created (a clip is a time window onto the original media — no
 *    re-encoding, no vault step).
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
);
const TRANSCRIPT_FIXTURES = path.join(FIXTURES, "transcript");
const TINY_VIDEO = path.join(TRANSCRIPT_FIXTURES, "tiny-video.mp4");
const TINY_VTT = path.join(TRANSCRIPT_FIXTURES, "tiny-video.vtt");

let dir: string;
let dbPath: string;
let assetsDir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "interleave-mediaclip-"));
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

/** Import the tiny fixture video + .vtt and return the source id + the first cue block id. */
async function importFixtureSource(
  svc: DbService,
): Promise<{ id: string; firstCueBlockId: string }> {
  const { id } = await svc.mediaImportService.importFromFile({
    filePath: TINY_VIDEO,
    subtitlesPath: TINY_VTT,
  });
  const blocks = svc.repos.documents.listBlocks(id as never);
  // The first cue paragraph (the block that carries a timestamp) is the clip anchor.
  const firstCue = blocks.find((b) => typeof b.timestampMs === "number");
  if (!firstCue) throw new Error("fixture has no transcript cue block");
  return { id, firstCueBlockId: firstCue.stableBlockId };
}

describe("MediaClipService.extractClip (clip a media span into a media_fragment)", () => {
  it("creates an attention-scheduled media_fragment + clip source location", async () => {
    const svc = openSvc();
    const { id: sourceId, firstCueBlockId } = await importFixtureSource(svc);

    const result = await svc.extractClip({
      sourceElementId: sourceId,
      startMs: 0,
      endMs: 800,
      anchorBlockId: firstCueBlockId,
      transcriptSegment: "first cue text",
    });

    // The element is a media_fragment with lineage to the source.
    expect(result.element.type).toBe("media_fragment");
    expect(result.element.stage).toBe("raw_extract");
    expect(result.element.sourceId).toBe(sourceId);
    expect(result.element.parentId).toBe(sourceId);
    // Attention-scheduled: a due date is set.
    expect(result.element.dueAt).not.toBeNull();
    // The location carries the start timestamp + the clip window + a "Clip …" label.
    expect(result.location.timestampMs).toBe(0);
    expect(result.location.clip).toEqual({ startMs: 0, endMs: 800 });
    expect(result.location.label).toBe("Clip 0:00–0:00");

    // The two-scheduler split holds: NO review_states row for the clip fragment.
    expect(svc.repos.review.findReviewState(result.id as never)).toBeNull();

    // NO asset is created — a clip is a time window, not a file.
    expect(svc.repos.assets.listForElement(result.id as never)).toHaveLength(0);

    // The op log carries create_extract.
    const ops = svc.repos.operationLog.listForElement(result.id as never).map((o) => o.opType);
    expect(ops).toContain("create_extract");

    svc.close();
  });

  it("inherits the source priority + appears as a child of the source", async () => {
    const svc = openSvc();
    const { id: sourceId, firstCueBlockId } = await importFixtureSource(svc);
    const source = svc.repos.elements.findById(sourceId as never);

    const result = await svc.extractClip({
      sourceElementId: sourceId,
      startMs: 100,
      endMs: 500,
      anchorBlockId: firstCueBlockId,
    });
    expect(result.element.priority).toBe(source?.priority);

    // The fragment is a child of the source element.
    const children = svc.repos.elements.listChildren(sourceId as never);
    expect(children.some((c) => c.id === result.id)).toBe(true);

    svc.close();
  });

  it("survives an app restart (re-open the DB on the same file)", async () => {
    let svc = openSvc();
    const { id: sourceId, firstCueBlockId } = await importFixtureSource(svc);
    const clip = await svc.extractClip({
      sourceElementId: sourceId,
      startMs: 200,
      endMs: 700,
      anchorBlockId: firstCueBlockId,
      transcriptSegment: "second cue",
    });
    svc.close();

    svc = openSvc();
    const el = svc.repos.elements.findById(clip.id as never);
    expect(el?.type).toBe("media_fragment");
    // The clip source location round-trips its start timestamp + window after re-open.
    const loc = svc.repos.sources.findLocationById(clip.location.id as never);
    expect(loc?.timestampMs).toBe(200);
    expect(loc?.clip).toEqual({ startMs: 200, endMs: 700 });
    svc.close();
  });

  it("rejects a clip whose end exceeds the media duration", async () => {
    const svc = openSvc();
    const { id: sourceId, firstCueBlockId } = await importFixtureSource(svc);
    const before = svc.repos.elements.listByType("media_fragment").length;

    await expect(
      svc.extractClip({
        sourceElementId: sourceId,
        startMs: 0,
        endMs: 999_999_999, // far beyond the tiny fixture's duration
        anchorBlockId: firstCueBlockId,
      }),
    ).rejects.toThrow(/exceeds media duration/);

    // No fragment was created.
    expect(svc.repos.elements.listByType("media_fragment").length).toBe(before);
    svc.close();
  });

  it("rejects an inverted window", async () => {
    const svc = openSvc();
    const { id: sourceId, firstCueBlockId } = await importFixtureSource(svc);
    await expect(
      svc.extractClip({
        sourceElementId: sourceId,
        startMs: 500,
        endMs: 200,
        anchorBlockId: firstCueBlockId,
      }),
    ).rejects.toThrow(/invalid clip window/);
    svc.close();
  });
});
