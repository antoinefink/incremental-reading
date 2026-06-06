import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AutomaticBackupRetentionPolicy,
  AutomaticBackupService,
  type AutomaticBackupServiceDeps,
  isAutomaticBackupDue,
  listAutomaticBackupArtifacts,
  parseBackupTimestamp,
  pruneAutomaticBackups,
  selectAutomaticBackupsToPrune,
} from "./automatic-backup-service";
import { type BackupResult, BackupService } from "./backup-service";
import type { DbService } from "./db-service";
import { type AppPaths, computeAppPaths, ensureVaultSkeleton } from "./paths";

let dataDir: string;
let paths: AppPaths;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "interleave-auto-backup-"));
  paths = ensureVaultSkeleton(computeAppPaths(dataDir));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function deps(
  overrides: Partial<AutomaticBackupServiceDeps> & {
    createBackup: (now: Date) => Promise<BackupResult>;
  },
): AutomaticBackupServiceDeps {
  return {
    dbService: {} as DbService,
    paths,
    migrationsDir: "migrations",
    appVersion: "test",
    logger: { error: vi.fn(), info: vi.fn() },
    ...overrides,
  };
}

function autoName(iso: string): string {
  return `auto-${iso.replace(/[:.]/g, "-")}`;
}

function writeBackup(name: string, sizeBytes = 10): void {
  fs.writeFileSync(path.join(paths.backupsDir, `${name}.zip`), Buffer.alloc(sizeBytes, 1));
  fs.mkdirSync(path.join(paths.backupsDir, name), { recursive: true });
  fs.writeFileSync(path.join(paths.backupsDir, name, "manifest.json"), "");
}

function writeAutoBackupAtAge(now: Date, ageMs: number): string {
  const name = autoName(new Date(now.getTime() - ageMs).toISOString());
  writeBackup(name);
  return name;
}

function makeCreateBackup(sizeBytes = 10): (now: Date) => Promise<BackupResult> {
  return async (now: Date) => {
    const timestamp = autoName(now.toISOString());
    writeBackup(timestamp, sizeBytes);
    return {
      path: path.join(paths.backupsDir, `${timestamp}.zip`),
      timestamp,
      sizeBytes,
      fileCount: 1,
      schemaVersion: "0001_test",
    };
  };
}

function fakeDbService(): DbService {
  return {
    backupDatabaseTo(dbPath: string) {
      fs.writeFileSync(dbPath, "sqlite snapshot");
    },
    getSchemaVersion() {
      return "0001_test";
    },
    getBackupCounts() {
      return { elements: 0, sources: 0, extracts: 0, cards: 0, assets: 0 };
    },
  } as unknown as DbService;
}

describe("automatic backup artifact parsing", () => {
  it("parses backup-service timestamps including collision suffixes", () => {
    expect(parseBackupTimestamp("2026-06-06T12-30-00-000Z")?.toISOString()).toBe(
      "2026-06-06T12:30:00.000Z",
    );
    expect(parseBackupTimestamp("2026-06-06T12-30-00-000Z-2")?.toISOString()).toBe(
      "2026-06-06T12:30:00.000Z",
    );
    expect(parseBackupTimestamp("not-a-backup")).toBeNull();
  });

  it("lists only automatic zip artifacts and ignores manual backups", () => {
    writeBackup(autoName("2026-06-06T11:00:00.000Z"));
    writeBackup(autoName("2026-06-06T12:00:00.000Z"));
    fs.writeFileSync(path.join(paths.backupsDir, "2026-06-06T12-00-00-000Z.zip"), "manual");

    const artifacts = listAutomaticBackupArtifacts(paths.backupsDir);

    expect(artifacts.map((a) => a.timestamp)).toEqual([
      "auto-2026-06-06T12-00-00-000Z",
      "auto-2026-06-06T11-00-00-000Z",
    ]);
  });

  it("reports due only when no automatic backup exists or the latest is old enough", () => {
    const now = new Date("2026-06-06T12:00:00.000Z");
    expect(isAutomaticBackupDue(paths.backupsDir, now)).toBe(true);

    writeBackup(autoName("2026-06-06T11:30:00.000Z"));
    expect(isAutomaticBackupDue(paths.backupsDir, now)).toBe(false);

    writeBackup(autoName("2026-06-06T10:00:00.000Z"));
    fs.rmSync(path.join(paths.backupsDir, `${autoName("2026-06-06T11:30:00.000Z")}.zip`));
    expect(isAutomaticBackupDue(paths.backupsDir, now)).toBe(true);
  });

  it("lets a recent manual backup suppress an immediate automatic duplicate", () => {
    const now = new Date("2026-06-06T12:00:00.000Z");
    writeBackup("2026-06-06T11-30-00-000Z");

    expect(isAutomaticBackupDue(paths.backupsDir, now)).toBe(false);
    expect(listAutomaticBackupArtifacts(paths.backupsDir)).toEqual([]);
  });

  it("ignores future-dated artifacts for due checks", () => {
    writeBackup(autoName("2026-06-07T12:00:00.000Z"));

    expect(isAutomaticBackupDue(paths.backupsDir, new Date("2026-06-06T12:00:00.000Z"))).toBe(true);
  });
});

describe("automatic backup retention", () => {
  it("keeps the newest artifact per age bucket slot and prunes expired automatic backups", () => {
    const now = new Date("2026-06-06T12:00:00.000Z");
    const newest = autoName("2026-06-06T11:30:00.000Z");
    const duplicateSlot = autoName("2026-06-06T11:15:00.000Z");
    const priorHour = autoName("2026-06-06T09:00:00.000Z");
    const expired = autoName("2026-02-01T12:00:00.000Z");
    writeBackup(newest);
    writeBackup(duplicateSlot);
    writeBackup(priorHour);
    writeBackup(expired);

    const result = selectAutomaticBackupsToPrune(
      listAutomaticBackupArtifacts(paths.backupsDir),
      now,
    );

    expect(result.kept.map((a) => a.timestamp)).toEqual([newest, priorHour]);
    expect(result.pruned.map((a) => a.timestamp)).toEqual([duplicateSlot, expired]);
  });

  it("applies hourly, six-hour, daily, and weekly retention slots", () => {
    const now = new Date("2026-06-06T12:00:00.000Z");
    const scenarios = [
      {
        label: "hourly",
        keptAgeMs: 12 * HOUR_MS,
        duplicateAgeMs: 12 * HOUR_MS + 30 * 60 * 1000,
        separateSlotAgeMs: 13 * HOUR_MS,
      },
      {
        label: "six-hour",
        keptAgeMs: 3 * DAY_MS,
        duplicateAgeMs: 3 * DAY_MS + HOUR_MS,
        separateSlotAgeMs: 3 * DAY_MS + 6 * HOUR_MS,
      },
      {
        label: "daily",
        keptAgeMs: 10 * DAY_MS,
        duplicateAgeMs: 10 * DAY_MS + 2 * HOUR_MS,
        separateSlotAgeMs: 11 * DAY_MS,
      },
      {
        label: "weekly",
        keptAgeMs: 6 * WEEK_MS,
        duplicateAgeMs: 6 * WEEK_MS + DAY_MS,
        separateSlotAgeMs: 7 * WEEK_MS,
      },
    ];

    for (const scenario of scenarios) {
      const kept = writeAutoBackupAtAge(now, scenario.keptAgeMs);
      const duplicate = writeAutoBackupAtAge(now, scenario.duplicateAgeMs);
      const separateSlot = writeAutoBackupAtAge(now, scenario.separateSlotAgeMs);

      const result = selectAutomaticBackupsToPrune(
        listAutomaticBackupArtifacts(paths.backupsDir),
        now,
      );

      expect(
        result.kept.map((a) => a.timestamp),
        scenario.label,
      ).toContain(kept);
      expect(
        result.kept.map((a) => a.timestamp),
        scenario.label,
      ).toContain(separateSlot);
      expect(
        result.pruned.map((a) => a.timestamp),
        scenario.label,
      ).toContain(duplicate);

      fs.rmSync(paths.backupsDir, { recursive: true, force: true });
      fs.mkdirSync(paths.backupsDir, { recursive: true });
    }
  });

  it("enforces the size cap without deleting the newest automatic backup", () => {
    const now = new Date("2026-06-06T12:00:00.000Z");
    const newest = autoName("2026-06-06T11:00:00.000Z");
    const older = autoName("2026-06-06T09:00:00.000Z");
    const oldest = autoName("2026-06-06T07:00:00.000Z");
    writeBackup(newest, 10);
    writeBackup(older, 10);
    writeBackup(oldest, 10);
    const policy: AutomaticBackupRetentionPolicy = {
      buckets: [{ maxAgeMs: 48 * 60 * 60 * 1000, intervalMs: 60 * 60 * 1000 }],
      maxBytes: 15,
    };

    const result = selectAutomaticBackupsToPrune(
      listAutomaticBackupArtifacts(paths.backupsDir),
      now,
      policy,
    );

    expect(result.kept.map((a) => a.timestamp)).toEqual([newest]);
    expect(result.bytesAfter).toBe(10);
    expect(result.pruned.map((a) => a.timestamp)).toEqual([oldest, older]);
  });

  it("counts the matching unzipped directory toward the size cap", () => {
    const now = new Date("2026-06-06T12:00:00.000Z");
    const newest = autoName("2026-06-06T11:00:00.000Z");
    const older = autoName("2026-06-06T09:00:00.000Z");
    writeBackup(newest, 10);
    writeBackup(older, 10);
    fs.writeFileSync(path.join(paths.backupsDir, older, "app.sqlite"), Buffer.alloc(20, 1));
    const policy: AutomaticBackupRetentionPolicy = {
      buckets: [{ maxAgeMs: 48 * 60 * 60 * 1000, intervalMs: 60 * 60 * 1000 }],
      maxBytes: 25,
    };

    const result = selectAutomaticBackupsToPrune(
      listAutomaticBackupArtifacts(paths.backupsDir),
      now,
      policy,
    );

    expect(result.bytesBefore).toBe(40);
    expect(result.kept.map((a) => a.timestamp)).toEqual([newest]);
    expect(result.pruned.map((a) => a.timestamp)).toEqual([older]);
  });

  it("does not let a future-dated automatic artifact evict a current backup", () => {
    const now = new Date("2026-06-06T12:00:00.000Z");
    const future = autoName("2026-06-07T12:00:00.000Z");
    const current = autoName("2026-06-06T12:00:00.000Z");
    writeBackup(future);
    writeBackup(current);

    const result = selectAutomaticBackupsToPrune(
      listAutomaticBackupArtifacts(paths.backupsDir),
      now,
    );

    expect(result.kept.map((a) => a.timestamp)).toContain(current);
    expect(result.pruned.map((a) => a.timestamp)).toContain(future);
    expect(result.pruned.map((a) => a.timestamp)).not.toContain(current);
  });

  it("deletes only automatic zips and their matching directories", () => {
    const now = new Date("2026-06-06T12:00:00.000Z");
    const keep = autoName("2026-06-06T11:00:00.000Z");
    const prune = autoName("2026-02-01T12:00:00.000Z");
    writeBackup(keep);
    writeBackup(prune);
    fs.writeFileSync(path.join(paths.backupsDir, "manual.zip"), "manual");
    fs.mkdirSync(path.join(paths.backupsDir, "manual"), { recursive: true });
    fs.writeFileSync(path.join(paths.assetsDir, "source.bin"), "asset");

    pruneAutomaticBackups(paths.backupsDir, now);

    expect(fs.existsSync(path.join(paths.backupsDir, `${keep}.zip`))).toBe(true);
    expect(fs.existsSync(path.join(paths.backupsDir, `${prune}.zip`))).toBe(false);
    expect(fs.existsSync(path.join(paths.backupsDir, prune))).toBe(false);
    expect(fs.existsSync(path.join(paths.backupsDir, "manual.zip"))).toBe(true);
    expect(fs.existsSync(path.join(paths.backupsDir, "manual"))).toBe(true);
    expect(fs.existsSync(path.join(paths.assetsDir, "source.bin"))).toBe(true);
  });

  it("preserves real manual timestamped backup zips and directories when pruning", () => {
    const now = new Date("2026-06-06T12:00:00.000Z");
    const prune = autoName("2026-02-01T12:00:00.000Z");
    const manual = "2026-02-01T12-00-00-000Z";
    writeBackup(prune);
    writeBackup(manual);

    pruneAutomaticBackups(paths.backupsDir, now);

    expect(fs.existsSync(path.join(paths.backupsDir, `${prune}.zip`))).toBe(false);
    expect(fs.existsSync(path.join(paths.backupsDir, prune))).toBe(false);
    expect(fs.existsSync(path.join(paths.backupsDir, `${manual}.zip`))).toBe(true);
    expect(fs.existsSync(path.join(paths.backupsDir, manual))).toBe(true);
  });
});

describe("AutomaticBackupService", () => {
  it("creates the first automatic backup and prunes after success", async () => {
    const service = new AutomaticBackupService(deps({ createBackup: makeCreateBackup() }));

    const result = await service.runOnce(new Date("2026-06-06T12:00:00.000Z"));

    expect(result.status).toBe("created");
    expect(fs.existsSync(path.join(paths.backupsDir, "auto-2026-06-06T12-00-00-000Z.zip"))).toBe(
      true,
    );
  });

  it("does not prune the backup it just created when the clock advances during creation", async () => {
    const tickStartedAt = new Date("2026-06-06T12:00:00.000Z");
    const createdAt = new Date("2026-06-06T12:00:00.010Z");
    let clock = tickStartedAt;
    const createBackup = vi.fn(async () => {
      clock = createdAt;
      const timestamp = autoName(createdAt.toISOString());
      writeBackup(timestamp);
      return {
        path: path.join(paths.backupsDir, `${timestamp}.zip`),
        timestamp,
        sizeBytes: 10,
        fileCount: 1,
        schemaVersion: "0001_test",
      };
    });
    const service = new AutomaticBackupService(deps({ createBackup, clock: () => clock }));

    const result = await service.runOnce(tickStartedAt);

    expect(result.status).toBe("created");
    expect(fs.existsSync(path.join(paths.backupsDir, "auto-2026-06-06T12-00-00-010Z.zip"))).toBe(
      true,
    );
  });

  it("skips a run when the latest automatic backup is recent", async () => {
    writeBackup(autoName("2026-06-06T11:30:00.000Z"));
    const createBackup = vi.fn(makeCreateBackup());
    const service = new AutomaticBackupService(deps({ createBackup }));

    const result = await service.runOnce(new Date("2026-06-06T12:00:00.000Z"));

    expect(result).toEqual({ status: "skipped", reason: "not_due" });
    expect(createBackup).not.toHaveBeenCalled();
  });

  it("does not overlap concurrent runs", async () => {
    let resolveBackup: (value: BackupResult) => void = () => {};
    const pending = new Promise<BackupResult>((resolve) => {
      resolveBackup = resolve;
    });
    const createBackup = vi.fn(() => pending);
    const service = new AutomaticBackupService(deps({ createBackup }));

    const first = service.runOnce(new Date("2026-06-06T12:00:00.000Z"));
    const second = await service.runOnce(new Date("2026-06-06T12:00:00.000Z"));
    resolveBackup({
      path: path.join(paths.backupsDir, "auto-2026-06-06T12-00-00-000Z.zip"),
      timestamp: "auto-2026-06-06T12-00-00-000Z",
      sizeBytes: 1,
      fileCount: 1,
      schemaVersion: "0001_test",
    });

    expect(second).toEqual({ status: "skipped", reason: "in_flight" });
    expect((await first).status).toBe("created");
    expect(createBackup).toHaveBeenCalledTimes(1);
  });

  it("rechecks freshness after waiting behind a manual backup", async () => {
    const now = new Date("2026-06-06T12:00:00.000Z");
    const manualBackupService = new BackupService({
      dbService: fakeDbService(),
      paths,
      migrationsDir: "migrations",
      appVersion: "test",
    });
    const manual = manualBackupService.createBackup(now);
    const automatic = new AutomaticBackupService({
      dbService: fakeDbService(),
      paths,
      migrationsDir: "migrations",
      appVersion: "test",
      logger: { error: vi.fn(), info: vi.fn() },
      clock: () => now,
    });

    const result = await automatic.runOnce(now);
    const manualResult = await manual;

    expect(result).toEqual({ status: "skipped", reason: "not_due" });
    expect(path.basename(manualResult.path)).toBe("2026-06-06T12-00-00-000Z.zip");
    expect(fs.readdirSync(paths.backupsDir).filter((file) => file.endsWith(".zip"))).toEqual([
      "2026-06-06T12-00-00-000Z.zip",
    ]);
  });

  it("swallows backup failures so startup can continue", async () => {
    const error = new Error("disk full");
    const service = new AutomaticBackupService(
      deps({ createBackup: vi.fn(async () => Promise.reject(error)) }),
    );

    const result = await service.runOnce(new Date("2026-06-06T12:00:00.000Z"));

    expect(result).toEqual({ status: "failed", error });
  });

  it("schedules on start and clears the timer on stop", async () => {
    let cleared = false;
    let scheduled = false;
    const timer = 42 as unknown as ReturnType<typeof setTimeout>;
    const service = new AutomaticBackupService(
      deps({
        createBackup: makeCreateBackup(),
        setTimeoutFn: () => {
          scheduled = true;
          return timer;
        },
        clearTimeoutFn: (handle) => {
          if (handle === timer) cleared = true;
        },
      }),
    );

    service.start();
    await vi.waitFor(() => expect(scheduled).toBe(true));
    await service.stop();

    expect(cleared).toBe(true);
  });

  it("schedules a retry after a failed scheduled backup and later succeeds", async () => {
    const callbacks: Array<() => void> = [];
    let now = new Date("2026-06-06T12:00:00.000Z");
    const failure = new Error("disk full");
    const logger = { error: vi.fn(), info: vi.fn() };
    const createBackup = vi
      .fn<(runAt: Date) => Promise<BackupResult>>()
      .mockRejectedValueOnce(failure)
      .mockImplementationOnce(makeCreateBackup());
    const service = new AutomaticBackupService(
      deps({
        createBackup,
        clock: () => now,
        logger,
        setTimeoutFn: (callback) => {
          callbacks.push(callback);
          return callbacks.length as unknown as ReturnType<typeof setTimeout>;
        },
      }),
    );

    service.start();
    await vi.waitFor(() => expect(callbacks).toHaveLength(1));
    expect(createBackup).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith("[backup] automatic backup failed:", failure);
    expect(fs.existsSync(path.join(paths.backupsDir, "auto-2026-06-06T12-00-00-000Z.zip"))).toBe(
      false,
    );

    now = new Date("2026-06-06T13:00:00.000Z");
    const retry = callbacks[0];
    if (!retry) throw new Error("expected automatic backup retry to be scheduled");
    retry();

    await vi.waitFor(() => expect(createBackup).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(fs.existsSync(path.join(paths.backupsDir, "auto-2026-06-06T13-00-00-000Z.zip"))).toBe(
        true,
      ),
    );
    await vi.waitFor(() => expect(callbacks).toHaveLength(2));
    await service.stop();
  });
});
