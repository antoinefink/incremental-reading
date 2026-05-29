/**
 * Electron-ABI native SQLite binding resolver (T007).
 *
 * The desktop app must load a `better_sqlite3.node` compiled for Electron's V8
 * ABI, not the Node-ABI binary that ships with the shared `better-sqlite3`
 * package (which serves Vitest + the dev scripts). `scripts/vendor-native.mjs`
 * builds the Electron-ABI binary into `apps/desktop/native/better_sqlite3.node`;
 * this resolver finds it so the DB client can pass it to `better-sqlite3`'s
 * `nativeBinding` option.
 *
 * `distDir` is the compiled-main directory (`__dirname`): the bundle lives at
 * `apps/desktop/dist`, so the native binary is one level up at
 * `apps/desktop/native/`.
 */

import fs from "node:fs";
import path from "node:path";

/**
 * Absolute path to the Electron-ABI `better_sqlite3.node`, or `undefined` if it
 * has not been built yet (in which case the caller falls back to the default
 * binding — useful for non-Electron contexts).
 */
export function resolveNativeBinding(distDir: string): string | undefined {
  const candidates = [
    // Built artifact: apps/desktop/native/better_sqlite3.node (dist is one down).
    path.resolve(distDir, "..", "native", "better_sqlite3.node"),
    // When running the bundle from an unusual cwd, also try alongside it.
    path.join(distDir, "native", "better_sqlite3.node"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}
