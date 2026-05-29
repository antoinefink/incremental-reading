/**
 * Migrations folder resolver (T007).
 *
 * The Drizzle migrator needs the absolute path to the generated `drizzle/`
 * folder (the SQL files + `meta/_journal.json`). `@interleave/db` computes its
 * own path via `import.meta.url`, which does not survive bundling into the
 * desktop main `.cjs`, so the desktop build copies the migrations next to the
 * compiled main (`dist/drizzle`) and we resolve that first. In dev (running the
 * bundle from `apps/desktop/dist`) we fall back to the workspace package, then
 * to `@interleave/db`'s own resolution as a last resort.
 */

import fs from "node:fs";
import path from "node:path";

/** True if `dir` looks like a Drizzle migrations folder. */
function isMigrationsDir(dir: string): boolean {
  return fs.existsSync(path.join(dir, "meta", "_journal.json"));
}

/**
 * Resolve the migrations folder. `distDir` is the compiled-main directory
 * (`__dirname`); candidates are tried in order of how production-correct they
 * are. The `@interleave/db` package computes its own path via `import.meta.url`,
 * which does not survive CJS bundling, so we rely on the build staging a copy
 * into `dist/drizzle` (with a workspace fallback for unbundled dev).
 */
export function resolveMigrationsDir(distDir: string): string {
  const candidates = [
    // Production / self-contained: copied next to the compiled main.
    path.join(distDir, "drizzle"),
    // Dev: dist sits at apps/desktop/dist, the package at packages/db/drizzle.
    path.resolve(distDir, "..", "..", "..", "packages", "db", "drizzle"),
  ];

  for (const candidate of candidates) {
    if (isMigrationsDir(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Could not locate the Drizzle migrations folder. Tried:\n  ${candidates.join("\n  ")}`,
  );
}
