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
  type ExtractAgingCollection,
  type MaintenanceCollection,
  type SeededConcepts,
  type SeedMaintenanceOptions,
  seedDemoCollection,
  seedExtractAgingCollection,
  seedMaintenanceCollection,
} from "./factories";
/**
 * Large-collection seed harness for the scale benchmark + scale-smoke (T100). Builds
 * a configurable collection up to the ~100k scale matrix into an open, migrated DB
 * via a documented bulk fast path; `seedSmokeControl` is the real-repository control
 * that proves the bulk rows are schema-identical.
 */
export {
  CI_SCALE_PROFILE,
  DEFAULT_LARGE_PROFILE,
  type LargeSeedOptions,
  type LargeSeedStats,
  SMOKE_LARGE_PROFILE,
  seedLargeCollection,
  seedSmokeControl,
} from "./large-seed";
