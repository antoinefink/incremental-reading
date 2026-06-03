/**
 * @interleave/testing — shared factories, fixtures, and test harness helpers.
 *
 * Provides the in-memory native-SQLite harness (`createInMemoryDb`) reused by
 * both Vitest unit/repository tests (T008) and the seed/factory work (T009), plus
 * the shared demo-collection factory (`seedDemoCollection`) and its deterministic
 * content fixtures (`DEMO_FIXTURES`). The SAME factory backs both the Vitest
 * fixtures and the `pnpm seed` dev database driven by Playwright, so dev and test
 * data never drift.
 */
export const TESTING_PACKAGE = "@interleave/testing" as const;

/** Native-SQLite, fully-migrated in-memory database for repository tests (T008). */
export { createInMemoryDb } from "./db";
/** Shared demo collection + deterministic fixtures, built through the repositories (T009). */
export {
  DEMO_FIXTURES,
  type DemoCollection,
  type MaintenanceCollection,
  type SeededConcepts,
  type SeedMaintenanceOptions,
  seedDemoCollection,
  seedMaintenanceCollection,
} from "./factories";
