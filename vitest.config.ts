import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

const projectDirs = ["packages", "apps"].flatMap((parent) =>
  readdirSync(parent)
    .map((name) => join(parent, name))
    .filter((path) => statSync(path).isDirectory()),
);

/**
 * Workspace-aware Vitest config (T002).
 *
 * `test.projects` (the Vitest 3.2+ replacement for `vitest.workspace.ts`) makes
 * Vitest discover a project per package/app: any `*.test.ts` / `*.spec.ts` under
 * each package or app subdirectory is collected. New packages get test coverage for free
 * without editing this file, while root-level instruction files under `apps/` or `packages/`
 * are ignored.
 *
 * Playwright E2E lives outside Vitest (see `playwright.config.ts`) and is excluded
 * here so `pnpm test` never tries to run browser specs.
 *
 * Note: with `projects` globs, each package project resolves its OWN config (or
 * Vitest defaults) — root-level `test` options like `testTimeout` are NOT
 * inherited. Packages whose suites need a non-default timeout carry their own
 * `vitest.config.ts` (see `packages/local-db` for the SQLite property tests).
 */
export default defineConfig({
  test: {
    projects: projectDirs,
  },
});
