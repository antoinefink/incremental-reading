/**
 * Native SQLite DB service (T007) — the Electron main-process owner of the local
 * database. It is the only place the DB file is opened; the renderer reaches it
 * solely through validated IPC (never directly).
 *
 * Responsibilities for M1:
 *  - open `app.sqlite` via `@interleave/db` (`better-sqlite3` + the mandatory
 *    pragmas: `foreign_keys = ON`, `journal_mode = WAL`, `busy_timeout = 5000`),
 *  - run the generated Drizzle migrations on startup (explicit + safe for prod),
 *  - serve `db.getStatus()` and the `settings.get/update` surface.
 *
 * The full repository layer (`packages/local-db`, with the operation-log append
 * and transactional multi-table mutations) lands in T008 and will plug in behind
 * this same service. For now the narrow settings surface is implemented directly
 * against the `@interleave/db` client so T007 has a real, persistent round-trip.
 */

import { type DbHandle, migrateDatabase, openDatabase, settings } from "@interleave/db";
import { eq } from "drizzle-orm";
import type {
  DbStatus,
  SettingsGetResult,
  SettingsUpdateResult,
  SettingValue,
} from "../shared/contract";

export class DbService {
  private handle: DbHandle | null = null;
  private migrated = false;

  /** Whether the database handle is currently open. */
  get isOpen(): boolean {
    return this.handle !== null;
  }

  /** Whether startup migrations have been applied this session. */
  get isMigrated(): boolean {
    return this.migrated;
  }

  /**
   * Open the database at `dbPath` and run all pending migrations. Idempotent:
   * calling again while open is a no-op. `migrationsDir` is resolved by the
   * caller (the desktop bundle ships its own copy — see `migrations.ts`);
   * `nativeBinding`, when set, points `better-sqlite3` at the Electron-ABI addon
   * (see `native-binding.ts`).
   */
  open(
    dbPath: string,
    options: { migrationsDir?: string | undefined; nativeBinding?: string | undefined } = {},
  ): void {
    if (this.handle) return;
    this.handle = options.nativeBinding
      ? openDatabase(dbPath, { nativeBinding: options.nativeBinding })
      : openDatabase(dbPath);
    migrateDatabase(this.handle.db, options.migrationsDir);
    this.migrated = true;
  }

  /** Close the database handle (called on app shutdown). */
  close(): void {
    if (!this.handle) return;
    this.handle.sqlite.close();
    this.handle = null;
    this.migrated = false;
  }

  private require(): DbHandle {
    if (!this.handle) {
      throw new Error("DbService: database is not open");
    }
    return this.handle;
  }

  /** Read effective pragmas + applied-migration count for `db.getStatus()`. */
  getStatus(): DbStatus {
    const { sqlite } = this.require();
    const journalMode = String(sqlite.pragma("journal_mode", { simple: true }));
    const foreignKeys = Number(sqlite.pragma("foreign_keys", { simple: true }));
    const busyTimeoutMs = Number(sqlite.pragma("busy_timeout", { simple: true }));

    let appliedMigrations = 0;
    try {
      const row = sqlite.prepare("SELECT COUNT(*) AS n FROM __drizzle_migrations").get() as
        | { n: number }
        | undefined;
      appliedMigrations = row?.n ?? 0;
    } catch {
      // Migration table absent only if migrations never ran; report 0.
      appliedMigrations = 0;
    }

    return {
      open: true,
      migrated: this.migrated,
      journalMode,
      foreignKeys,
      busyTimeoutMs,
      appliedMigrations,
    };
  }

  /** Read one setting (by key) or all settings, parsing JSON values. */
  getSettings(key?: string): SettingsGetResult {
    const { db } = this.require();
    const rows = key
      ? db.select().from(settings).where(eq(settings.key, key)).all()
      : db.select().from(settings).all();

    const result: Record<string, SettingValue> = {};
    for (const row of rows) {
      result[row.key] = JSON.parse(row.value) as SettingValue;
    }
    return { settings: result };
  }

  /**
   * Create/overwrite a setting. The write runs in a transaction (the seam where
   * T008/T011 will also append the relevant operation-log/repository work) and
   * persists the value as JSON text, so it survives an app restart.
   */
  updateSetting(key: string, value: unknown): SettingsUpdateResult {
    const { db } = this.require();
    const json = JSON.stringify(value ?? null);

    db.transaction((tx) => {
      tx.insert(settings)
        .values({ key, value: json })
        .onConflictDoUpdate({ target: settings.key, set: { value: json } })
        .run();
    });

    return { key, value: JSON.parse(json) as SettingValue };
  }

  /** Cheap connectivity check used by `app.health()`. */
  ping(): boolean {
    const { sqlite } = this.require();
    const row = sqlite.prepare("SELECT 1 AS ok").get() as { ok: number } | undefined;
    return row?.ok === 1;
  }

  /** Exposed only for diagnostics/tests; never wired to the renderer. */
  get raw(): DbHandle {
    return this.require();
  }
}
