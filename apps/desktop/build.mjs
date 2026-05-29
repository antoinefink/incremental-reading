/**
 * Desktop bundler (T007).
 *
 * Builds the Electron main process and preload script with esbuild and stages a
 * self-contained copy of the Drizzle migrations next to the compiled main.
 *
 *   src/main/index.ts    → dist/main.cjs    (CJS, node platform)
 *   src/preload/index.ts → dist/preload.cjs (CJS, node platform)
 *   packages/db/drizzle  → dist/drizzle     (migrations, run on startup)
 *
 * `electron` and `better-sqlite3` are externalized: `electron` is provided by the
 * runtime, and `better-sqlite3` is a native module `require`d from node_modules.
 * The shared (Node-ABI) `better-sqlite3` JS is used as-is; the Electron main loads
 * the Electron-ABI binary by passing `nativeBinding` (see `native-binding.ts` +
 * `scripts/vendor-native.mjs`). Workspace TS (`@interleave/db`, `@interleave/core`,
 * `drizzle-orm`, `zod`) is bundled so the main process is a single file.
 *
 * Pass `--watch` for an incremental dev build.
 */

import { cpSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const distDir = path.join(here, "dist");
const watch = process.argv.includes("--watch");

/** Native + runtime-provided modules that must not be bundled. */
const external = ["electron", "better-sqlite3"];

/** Path to the `import.meta.url` shim injected into the main CJS bundle. */
const importMetaShim = path.join(here, "import-meta-url-shim.js");

/** @type {import("esbuild").BuildOptions} */
const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  sourcemap: true,
  // Electron 38 ships Node 22; matching keeps native ABI assumptions sane.
  external,
  logLevel: "info",
};

/**
 * Main-only extras. The `import.meta.url` shim uses `__filename`/`require`, which
 * are unavailable in a SANDBOXED preload — so it is injected into the main bundle
 * only. The preload uses no `import.meta`, so it needs neither define nor inject.
 */
const mainExtras = {
  define: { "import.meta.url": "import_meta_url" },
  inject: [importMetaShim],
};

function stageMigrations() {
  const from = path.join(repoRoot, "packages", "db", "drizzle");
  const to = path.join(distDir, "drizzle");
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true });
}

async function run() {
  mkdirSync(distDir, { recursive: true });

  const targets = [
    {
      ...common,
      ...mainExtras,
      entryPoints: [path.join(here, "src", "main", "index.ts")],
      outfile: path.join(distDir, "main.cjs"),
    },
    {
      ...common,
      entryPoints: [path.join(here, "src", "preload", "index.ts")],
      outfile: path.join(distDir, "preload.cjs"),
    },
  ];

  stageMigrations();

  if (watch) {
    const contexts = await Promise.all(targets.map((t) => esbuild.context(t)));
    await Promise.all(contexts.map((c) => c.watch()));
    console.log("[desktop] esbuild watching main + preload…");
    return;
  }

  await Promise.all(targets.map((t) => esbuild.build(t)));
  console.log("[desktop] built main.cjs + preload.cjs + drizzle/");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
