/**
 * Secure window creation (T007).
 *
 * The renderer is untrusted, so the window is locked down by default
 * (CLAUDE.md "Electron runtime & security"):
 *   - `contextIsolation: true`  — renderer + preload run in isolated worlds
 *   - `nodeIntegration: false`  — no Node globals in the renderer
 *   - `sandbox: true`          — renderer runs in an OS sandbox
 *   - `enableRemoteModule: false` (the @electron/remote module is never enabled)
 *   - `webSecurity: true`
 *
 * The only bridge into the renderer is the compiled preload script, which
 * exposes the narrow typed `window.appApi`. In dev the window loads the Vite dev
 * server (`VITE_DEV_SERVER_URL`); in production it loads the built renderer over
 * the `app://` protocol (see `renderer-protocol.ts`) so assets and SPA routing
 * resolve at pathname `/` (loading via `file://` breaks both).
 */

import path from "node:path";
import { BrowserWindow } from "electron";
import { RENDERER_URL } from "./renderer-protocol";

/** Where the preload bundle is emitted (relative to the compiled main file). */
const PRELOAD_FILENAME = "preload.cjs";

/** Default Vite dev server URL (matches apps/web vite.config.ts strictPort). */
const DEFAULT_DEV_SERVER_URL = "http://localhost:5173";

export interface CreateWindowOptions {
  /** Directory holding the compiled main + preload (`__dirname` of the entry). */
  readonly distDir: string;
  /** Dev server URL; when set, the window loads it instead of the built files. */
  readonly devServerUrl?: string | undefined;
}

export function createMainWindow(options: CreateWindowOptions): BrowserWindow {
  const preloadPath = path.join(options.distDir, PRELOAD_FILENAME);

  const win = new BrowserWindow({
    width: 1280,
    height: 832,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: "#0b0b0c",
    title: "Interleave",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // `enableRemoteModule` is false by default in modern Electron and the
      // @electron/remote package is never installed/enabled.
    },
  });

  win.once("ready-to-show", () => {
    win.show();
  });

  const devServerUrl = options.devServerUrl ?? process.env.VITE_DEV_SERVER_URL ?? undefined;

  if (devServerUrl) {
    void win.loadURL(devServerUrl);
  } else {
    // Production: served by the registered `app://` protocol handler.
    void win.loadURL(RENDERER_URL);
  }

  return win;
}

export { DEFAULT_DEV_SERVER_URL };
