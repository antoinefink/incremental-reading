/**
 * MaintenanceService tests (T099) — the main-side composition the local-db unit tests
 * can't cover: the broken-source disk join, the DB+vault integrity pragmas, and the
 * orphan-media cleanup that composes the vault GC + the vector prune.
 *
 * Against a real `DbService` opened over a temp `assetsDir` (the desktop-main pattern,
 * like `asset-vault-service.test.ts`), so the filesystem reads are real.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ElementId } from "@interleave/core";
import { MIGRATIONS_DIR } from "@interleave/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DbService } from "./db-service";

let dir: string;
let dbPath: string;
let assetsDir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "interleave-maint-"));
  dbPath = path.join(dir, "app.sqlite");
  assetsDir = path.join(dir, "assets");
  fs.mkdirSync(assetsDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function openDb(): DbService {
  const svc = new DbService();
  svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR, assetsDir });
  return svc;
}

function expectDefined<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`${label} was not found`);
  }
  return value;
}

/** Create a live `source` element. */
function makeSource(svc: DbService, title = "Source"): ElementId {
  return svc.repos.elements.create({
    type: "source",
    status: "active",
    stage: "raw_source",
    priority: 0.375,
    title,
  }).id;
}

describe("MaintenanceService.brokenSources (T099)", () => {
  it("flags a source whose snapshot file is deleted on disk as `missingFile`", async () => {
    const svc = openDb();
    const owner = makeSource(svc, "With snapshot");
    // Stream a real snapshot file into the vault, recording its `assets` row.
    const asset = await svc.assetVaultService.importAsset({
      owningElementId: owner,
      kind: "source_html",
      source: Readable.from(Buffer.from("<html>snapshot</html>")),
      mime: "text/html",
      destRelativePath: `sources/${owner}/cleaned.html`,
    });
    // Delete the bytes on disk (leaving the row) → the source is broken.
    fs.rmSync(path.join(assetsDir, ...asset.location.vaultPath.relativePath.split("/")));

    const { rows } = await svc.getMaintenanceBrokenSources();
    const row = expectDefined(
      rows.find((r) => r.source.id === owner),
      "broken source row",
    );
    expect(row.reason).toBe("missingFile");
    expect(row.missingAssetIds).toContain(asset.id);
    svc.close();
  });

  it("flags a source that RECORDED a snapshot but has NO snapshot row as `noSnapshot`", async () => {
    const svc = openDb();
    // A source whose own metadata recorded a snapshot (`snapshot_key`) whose asset row is
    // gone — it SHOULD have a snapshot, so it is genuinely broken.
    const owner = svc.repos.sources.create({
      title: "Recorded-but-missing snapshot",
      priority: 0.5,
      status: "active",
      stage: "raw_source",
      url: "https://example.com/recorded",
      canonicalUrl: "https://example.com/recorded",
      snapshotKey: "sources/recorded/cleaned.html",
    }).element.id;
    const { rows } = await svc.getMaintenanceBrokenSources();
    const row = expectDefined(
      rows.find((r) => r.source.id === owner),
      "no-snapshot source row",
    );
    expect(row.reason).toBe("noSnapshot");
    expect(row.missingAssetIds).toEqual([]);
    svc.close();
  });

  it("does NOT flag a manual source (no snapshot_key, no snapshot row) — its content is openable", async () => {
    const svc = openDb();
    // A hand-authored/manual source: no `snapshot_key`, no snapshot asset. Its content
    // lives in `documents` and it is perfectly openable, so it is NOT broken.
    const owner = svc.repos.sources.create({
      title: "Manual note source",
      priority: 0.5,
      status: "active",
      stage: "raw_source",
    }).element.id;
    const { rows } = await svc.getMaintenanceBrokenSources();
    expect(rows.find((r) => r.source.id === owner)).toBeUndefined();
    svc.close();
  });

  it("does NOT flag a source whose snapshot file is intact on disk", async () => {
    const svc = openDb();
    const owner = makeSource(svc, "Intact");
    await svc.assetVaultService.importAsset({
      owningElementId: owner,
      kind: "source_html",
      source: Readable.from(Buffer.from("<html>intact</html>")),
      mime: "text/html",
      destRelativePath: `sources/${owner}/cleaned.html`,
    });
    const { rows } = await svc.getMaintenanceBrokenSources();
    expect(rows.find((r) => r.source.id === owner)).toBeUndefined();
    svc.close();
  });
});

describe("MaintenanceService.checkIntegrity (T099)", () => {
  it("returns db.ok = true on a healthy seeded DB + the vault report", async () => {
    const svc = openDb();
    makeSource(svc);
    const report = await svc.getMaintenanceIntegrity();
    expect(report.db.ok).toBe(true);
    expect(report.db.integrityCheck).toEqual(["ok"]);
    expect(report.db.foreignKeyViolations).toBe(0);
    expect(report.db.mode).toBe("quick_check");
    expect(report.vault.missing).toEqual([]);
    svc.close();
  });

  it("the deep option runs `integrity_check`", async () => {
    const svc = openDb();
    const report = await svc.getMaintenanceIntegrity({ deep: true });
    expect(report.db.mode).toBe("integrity_check");
    expect(report.db.ok).toBe(true);
    svc.close();
  });
});

describe("MaintenanceService.orphanMediaCleanup (T099)", () => {
  it("requires confirm: true and composes collectOrphans + pruneOrphanVectors", async () => {
    const svc = openDb();
    const owner = makeSource(svc);
    // Import then HARD-purge so the file becomes an orphan (row gone, file on disk).
    const asset = await svc.assetVaultService.importAsset({
      owningElementId: owner,
      kind: "source_pdf",
      source: Readable.from(Buffer.from("pretend-pdf-bytes".repeat(50))),
      mime: "application/pdf",
      destRelativePath: `sources/${owner}/original.pdf`,
    });
    const rel = asset.location.vaultPath.relativePath;
    const abs = path.join(assetsDir, ...rel.split("/"));
    expect(fs.existsSync(abs)).toBe(true);
    svc.repos.trash.purge(owner); // cascade deletes the asset row, leaves the file

    // confirm guard.
    await expect(
      // @ts-expect-error intentionally passing the wrong confirm
      svc.maintenanceOrphanMedia({ confirm: false }),
    ).rejects.toThrow();

    const result = await svc.maintenanceOrphanMedia({ confirm: true });
    expect(result.removed).toBeGreaterThanOrEqual(1);
    expect(result.freedBytes).toBeGreaterThan(0);
    expect(typeof result.vectorsPruned).toBe("number");
    expect(fs.existsSync(abs)).toBe(false);
    svc.close();
  });
});

describe("MaintenanceService.dedupeCleanup (T099)", () => {
  it("re-validates ids — refuses to trash a keeper or a stale non-duplicate id", () => {
    const svc = openDb();
    // Two sources sharing a canonical URL → a cluster (keeper = newest accessed_at).
    const a = svc.repos.sources.create({
      title: "Dup A",
      priority: 0.5,
      status: "active",
      stage: "raw_source",
      canonicalUrl: "https://example.com/x",
      accessedAt: "2026-05-01T00:00:00.000Z",
    }).element.id;
    const b = svc.repos.sources.create({
      title: "Dup B",
      priority: 0.5,
      status: "active",
      stage: "raw_source",
      canonicalUrl: "https://example.com/x",
      accessedAt: "2026-05-10T00:00:00.000Z",
    }).element.id;
    const dup = svc.getMaintenanceDuplicates();
    const cluster = expectDefined(dup.sourceClusters[0], "duplicate source cluster");
    const removableDuplicate = expectDefined(cluster.duplicates[0], "removable duplicate");
    const keeper = cluster.canonical.id;
    const removable = removableDuplicate.id;
    expect(keeper).toBe(b); // b is newer

    // Passing the KEEPER id is rejected (re-validation skips it).
    const refused = svc.maintenanceDedupe({ removeIds: [keeper] });
    expect(refused.affected).toBe(0);
    expect(svc.repos.elements.findById(keeper)?.deletedAt).toBeNull();

    // The removable duplicate is the OLDER source `a`; the keeper `b` stays live.
    expect(removable).toBe(a);
    const cleaned = svc.maintenanceDedupe({ removeIds: [removable] });
    expect(cleaned.affected).toBe(1);
    expect(svc.repos.elements.findById(removable as ElementId)?.deletedAt).toBeTruthy();
    expect(svc.repos.elements.findById(b)?.deletedAt).toBeFalsy();
    svc.close();
  });
});
