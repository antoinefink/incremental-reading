/**
 * Renderer-side typed client wrapper for the Electron `window.appApi` bridge
 * (T007).
 *
 * This is the renderer's only door to trusted local capabilities. It mirrors the
 * narrow surface the preload exposes (the authoritative contract lives in
 * `apps/desktop/src/shared/contract.ts`); the renderer is a pure UI consumer, so
 * it declares its own minimal types here rather than depending on the desktop
 * app package. The renderer NEVER touches SQLite, Node, or the filesystem — it
 * only awaits these IPC-backed promises.
 *
 * When the renderer runs outside Electron (the T002 Vite-only smoke E2E, plain
 * `vite dev` in a browser), `window.appApi` is undefined; `isDesktop()` lets the
 * UI degrade gracefully instead of throwing.
 */

/** Liveness/readiness of the desktop shell + local DB. */
export interface HealthResult {
  readonly status: "ok";
  readonly appVersion: string;
  readonly dbOpen: boolean;
  readonly migrated: boolean;
  readonly time: string;
}

/** Local SQLite open/migrated state + effective pragmas. */
export interface DbStatus {
  readonly open: boolean;
  readonly migrated: boolean;
  readonly journalMode: string;
  readonly foreignKeys: number;
  readonly busyTimeoutMs: number;
  readonly appliedMigrations: number;
}

export type SettingValue =
  | string
  | number
  | boolean
  | null
  | SettingValue[]
  | { [k: string]: SettingValue };

export interface SettingsGetRequest {
  readonly key?: string;
}

export interface SettingsGetResult {
  readonly settings: Readonly<Record<string, SettingValue>>;
}

export interface SettingsUpdateRequest {
  readonly key: string;
  readonly value: unknown;
}

export interface SettingsUpdateResult {
  readonly key: string;
  readonly value: SettingValue;
}

/** The exact shape the preload exposes as `window.appApi`. */
export interface AppApi {
  readonly app: {
    health(): Promise<HealthResult>;
  };
  readonly db: {
    getStatus(): Promise<DbStatus>;
  };
  readonly settings: {
    get(request?: SettingsGetRequest): Promise<SettingsGetResult>;
    update(request: SettingsUpdateRequest): Promise<SettingsUpdateResult>;
  };
}

declare global {
  interface Window {
    /** Present only when running inside the Electron desktop shell. */
    appApi?: AppApi;
  }
}

/** True when running inside the Electron desktop shell. */
export function isDesktop(): boolean {
  return typeof window !== "undefined" && typeof window.appApi !== "undefined";
}

/**
 * Return the bridge, throwing a clear error when the renderer is not running in
 * the desktop shell. Use when a capability genuinely requires desktop mode.
 */
export function requireAppApi(): AppApi {
  if (!isDesktop() || !window.appApi) {
    throw new Error(
      "window.appApi is unavailable — the renderer is not running inside the Electron desktop shell.",
    );
  }
  return window.appApi;
}

/** The typed client. All methods reach the main process over validated IPC. */
export const appApi = {
  /** Liveness/readiness probe. */
  health(): Promise<HealthResult> {
    return requireAppApi().app.health();
  },
  /** Local SQLite status. */
  dbStatus(): Promise<DbStatus> {
    return requireAppApi().db.getStatus();
  },
  /** Read one setting (by key) or all settings. */
  getSettings(request?: SettingsGetRequest): Promise<SettingsGetResult> {
    return requireAppApi().settings.get(request);
  },
  /** Create/overwrite a setting; persists to SQLite. */
  updateSetting(request: SettingsUpdateRequest): Promise<SettingsUpdateResult> {
    return requireAppApi().settings.update(request);
  },
} as const;
