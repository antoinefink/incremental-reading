import { defineConfig } from "vitest/config";

/**
 * Workspace-aware Vitest config (T002).
 *
 * `test.projects` (the Vitest 3.2+ replacement for `vitest.workspace.ts`) makes
 * Vitest discover a project per package/app: any `*.test.ts` / `*.spec.ts` under
 * `packages/*` or `apps/*` is collected. New packages get test coverage for free
 * without editing this file.
 *
 * Playwright E2E lives outside Vitest (see `playwright.config.ts`) and is excluded
 * here so `make test` never tries to run browser specs.
 *
 * Note: with `projects` globs, each package project resolves its OWN config (or
 * Vitest defaults) — root-level `test` options like `testTimeout` are NOT
 * inherited. Packages whose suites need a non-default timeout carry their own
 * `vitest.config.ts` (see `packages/local-db` for the SQLite property tests).
 */
export default defineConfig({
  test: {
    projects: ["packages/*", "apps/*"],
  },
});
