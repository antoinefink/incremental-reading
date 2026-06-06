import fs from "node:fs";
import path from "node:path";
import { type BackupResult, BackupService, type BackupServiceDeps } from "./backup-service";

export const AUTOMATIC_BACKUP_PREFIX = "auto-";
export const AUTOMATIC_BACKUP_INTERVAL_MS = 60 * 60 * 1000;
export const DEFAULT_AUTOMATIC_BACKUP_MAX_BYTES = 5 * 1024 * 1024 * 1024;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 30 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;

export interface AutomaticBackupRetentionBucket {
  readonly maxAgeMs: number;
  readonly intervalMs: number;
}

export interface AutomaticBackupRetentionPolicy {
  readonly buckets: readonly AutomaticBackupRetentionBucket[];
  readonly maxBytes: number;
}

export const DEFAULT_AUTOMATIC_BACKUP_RETENTION: AutomaticBackupRetentionPolicy = {
  buckets: [
    { maxAgeMs: 2 * DAY_MS, intervalMs: HOUR_MS },
    { maxAgeMs: 7 * DAY_MS, intervalMs: 6 * HOUR_MS },
    { maxAgeMs: 30 * DAY_MS, intervalMs: DAY_MS },
    { maxAgeMs: 12 * WEEK_MS, intervalMs: WEEK_MS },
    { maxAgeMs: 2 * YEAR_MS, intervalMs: MONTH_MS },
  ],
  maxBytes: DEFAULT_AUTOMATIC_BACKUP_MAX_BYTES,
};

export interface AutomaticBackupArtifact {
  readonly timestamp: string;
  readonly createdAt: Date;
  readonly zipPath: string;
  readonly dirPath: string;
  readonly automatic: boolean;
  readonly sizeBytes: number;
}

export interface AutomaticBackupPruneResult {
  readonly kept: readonly AutomaticBackupArtifact[];
  readonly pruned: readonly AutomaticBackupArtifact[];
  readonly bytesBefore: number;
  readonly bytesAfter: number;
}

export type AutomaticBackupRunResult =
  | {
      readonly status: "created";
      readonly backup: BackupResult;
      readonly prune: AutomaticBackupPruneResult;
    }
  | { readonly status: "skipped"; readonly reason: "not_due" | "in_flight" }
  | { readonly status: "failed"; readonly error: unknown };

type TimerHandle = ReturnType<typeof setTimeout>;

interface BackupArtifactListOptions {
  readonly includeDirectorySizes?: boolean;
  readonly automaticOnly?: boolean;
}

export interface AutomaticBackupServiceDeps extends BackupServiceDeps {
  readonly clock?: () => Date;
  readonly createBackup?: (now: Date) => Promise<BackupResult>;
  readonly logger?: Pick<Console, "error" | "info">;
  readonly policy?: AutomaticBackupRetentionPolicy;
  readonly intervalMs?: number;
  readonly setTimeoutFn?: (callback: () => void, ms: number) => TimerHandle;
  readonly clearTimeoutFn?: (handle: TimerHandle) => void;
}

/** Parse the filesystem-safe timestamp used by BackupService. */
export function parseBackupTimestamp(timestamp: string): Date | null {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)(?:-\d+)?$/.exec(timestamp);
  if (!match) return null;
  const raw = match[1];
  if (!raw) return null;
  const iso = `${raw.slice(0, 13)}:${raw.slice(14, 16)}:${raw.slice(17, 19)}.${raw.slice(20, 23)}Z`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

function directorySize(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) total += directorySize(abs);
    else if (entry.isFile()) {
      try {
        total += fs.statSync(abs).size;
      } catch {
        // The backup directory can be inspected while files are being deleted.
        // Treat disappearing/unreadable files as absent so maintenance continues.
      }
    }
  }
  return total;
}

/** List backup ZIPs and their matching unzipped directories. */
export function listBackupArtifacts(
  backupsDir: string,
  options: BackupArtifactListOptions = {},
): AutomaticBackupArtifact[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(backupsDir);
  } catch {
    return [];
  }

  const artifacts: AutomaticBackupArtifact[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".zip")) continue;
    const timestamp = entry.slice(0, -".zip".length);
    const automatic = timestamp.startsWith(AUTOMATIC_BACKUP_PREFIX);
    if (options.automaticOnly && !automatic) continue;
    const parseableTimestamp = automatic
      ? timestamp.slice(AUTOMATIC_BACKUP_PREFIX.length)
      : timestamp;
    const createdAt = parseBackupTimestamp(parseableTimestamp);
    if (!createdAt) continue;
    const zipPath = path.join(backupsDir, entry);
    const dirPath = path.join(backupsDir, timestamp);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(zipPath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (stat.size <= 0) continue;
    artifacts.push({
      timestamp,
      createdAt,
      zipPath,
      dirPath,
      automatic,
      sizeBytes: stat.size + (options.includeDirectorySizes === false ? 0 : directorySize(dirPath)),
    });
  }

  return artifacts.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/** List automatic backup ZIPs and their matching unzipped directories. */
export function listAutomaticBackupArtifacts(backupsDir: string): AutomaticBackupArtifact[] {
  return listBackupArtifacts(backupsDir, { automaticOnly: true });
}

export function latestBackupAt(backupsDir: string, now: Date): Date | null {
  return (
    listBackupArtifacts(backupsDir, { includeDirectorySizes: false }).find(
      (artifact) => artifact.createdAt <= now,
    )?.createdAt ?? null
  );
}

export function isAutomaticBackupDue(
  backupsDir: string,
  now: Date,
  intervalMs: number = AUTOMATIC_BACKUP_INTERVAL_MS,
): boolean {
  const latest = latestBackupAt(backupsDir, now);
  return latest === null || now.getTime() - latest.getTime() >= intervalMs;
}

export function selectAutomaticBackupsToPrune(
  artifacts: readonly AutomaticBackupArtifact[],
  now: Date,
  policy: AutomaticBackupRetentionPolicy = DEFAULT_AUTOMATIC_BACKUP_RETENTION,
): AutomaticBackupPruneResult {
  const sorted = [...artifacts].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const bytesBefore = sorted.reduce((sum, artifact) => sum + artifact.sizeBytes, 0);
  const kept: AutomaticBackupArtifact[] = [];
  const pruned: AutomaticBackupArtifact[] = [];
  const occupiedSlots = new Set<string>();

  for (const artifact of sorted) {
    const ageMs = now.getTime() - artifact.createdAt.getTime();
    if (ageMs < 0) {
      pruned.push(artifact);
      continue;
    }

    const bucketIndex = policy.buckets.findIndex((bucket) => ageMs <= bucket.maxAgeMs);
    if (bucketIndex === -1) {
      pruned.push(artifact);
      continue;
    }

    const bucket = policy.buckets[bucketIndex];
    if (!bucket) {
      pruned.push(artifact);
      continue;
    }
    const previousBucket = bucketIndex === 0 ? null : policy.buckets[bucketIndex - 1];
    const previousMax = previousBucket?.maxAgeMs ?? 0;
    const slot = Math.floor(Math.max(0, ageMs - previousMax) / bucket.intervalMs);
    const slotKey = `${bucketIndex}:${slot}`;
    if (occupiedSlots.has(slotKey)) {
      pruned.push(artifact);
      continue;
    }
    occupiedSlots.add(slotKey);
    kept.push(artifact);
  }

  let bytesAfter = kept.reduce((sum, artifact) => sum + artifact.sizeBytes, 0);
  const keepNewest = kept[0] ?? null;
  for (const artifact of [...kept].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    if (bytesAfter <= policy.maxBytes) break;
    if (keepNewest && artifact.timestamp === keepNewest.timestamp) continue;
    kept.splice(kept.indexOf(artifact), 1);
    pruned.push(artifact);
    bytesAfter -= artifact.sizeBytes;
  }

  return { kept, pruned, bytesBefore, bytesAfter };
}

export function pruneAutomaticBackups(
  backupsDir: string,
  now: Date,
  policy: AutomaticBackupRetentionPolicy = DEFAULT_AUTOMATIC_BACKUP_RETENTION,
): AutomaticBackupPruneResult {
  const result = selectAutomaticBackupsToPrune(
    listAutomaticBackupArtifacts(backupsDir),
    now,
    policy,
  );
  for (const artifact of result.pruned) {
    fs.rmSync(artifact.zipPath, { force: true });
    fs.rmSync(artifact.dirPath, { recursive: true, force: true });
  }
  return result;
}

export class AutomaticBackupService {
  private started = false;
  private inFlight: Promise<AutomaticBackupRunResult> | null = null;
  private timer: TimerHandle | null = null;

  constructor(private readonly deps: AutomaticBackupServiceDeps) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.tick();
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.timer) {
      (this.deps.clearTimeoutFn ?? clearTimeout)(this.timer);
      this.timer = null;
    }
    await this.inFlight;
  }

  runOnce(now: Date = this.now()): Promise<AutomaticBackupRunResult> {
    if (this.inFlight) return Promise.resolve({ status: "skipped", reason: "in_flight" });
    this.inFlight = this.runOnceUnprotected(now).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async tick(): Promise<void> {
    try {
      await this.runOnce();
    } catch (error) {
      this.deps.logger?.error?.("[backup] automatic scheduler tick failed:", error);
    } finally {
      this.scheduleNext();
    }
  }

  private scheduleNext(): void {
    if (!this.started) return;
    this.timer = (this.deps.setTimeoutFn ?? setTimeout)(() => void this.tick(), this.intervalMs());
    if (typeof this.timer === "object" && "unref" in this.timer) this.timer.unref();
  }

  private async runOnceUnprotected(now: Date): Promise<AutomaticBackupRunResult> {
    try {
      if (!isAutomaticBackupDue(this.deps.paths.backupsDir, now, this.intervalMs())) {
        return { status: "skipped", reason: "not_due" };
      }

      const backup = await this.createBackupIfStillDue(now);
      if (!backup) return { status: "skipped", reason: "not_due" };

      const pruneAt = new Date(Math.max(now.getTime(), this.now().getTime()));
      const prune = pruneAutomaticBackups(this.deps.paths.backupsDir, pruneAt, this.policy());
      this.deps.logger?.info?.(
        `[backup] automatic backup created: ${backup.timestamp}; pruned ${prune.pruned.length}`,
      );
      return { status: "created", backup, prune };
    } catch (error) {
      this.deps.logger?.error?.("[backup] automatic backup failed:", error);
      return { status: "failed", error };
    }
  }

  private createBackupIfStillDue(now: Date): Promise<BackupResult | null> {
    if (this.deps.createBackup) {
      if (!isAutomaticBackupDue(this.deps.paths.backupsDir, now, this.intervalMs())) {
        return Promise.resolve(null);
      }
      return this.deps.createBackup(now);
    }

    return new BackupService(this.deps).createBackupWhen(
      () => {
        const creationDate = this.now();
        return isAutomaticBackupDue(this.deps.paths.backupsDir, creationDate, this.intervalMs())
          ? creationDate
          : null;
      },
      { namePrefix: AUTOMATIC_BACKUP_PREFIX },
    );
  }

  private now(): Date {
    return this.deps.clock?.() ?? new Date();
  }

  private intervalMs(): number {
    return this.deps.intervalMs ?? AUTOMATIC_BACKUP_INTERVAL_MS;
  }

  private policy(): AutomaticBackupRetentionPolicy {
    return this.deps.policy ?? DEFAULT_AUTOMATIC_BACKUP_RETENTION;
  }
}
