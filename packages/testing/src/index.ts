/**
 * @interleave/testing — shared factories, fixtures, and mock sources.
 *
 * Provides deterministic element/document/review factories and the in-memory
 * PGlite helpers reused by both Vitest unit tests and Playwright E2E (T008/T009).
 * Nothing is implemented yet — this trivial export only proves the package
 * resolves across the workspace.
 */
export const TESTING_PACKAGE = "@interleave/testing" as const;

/** Placeholder until factories/fixtures are defined in T008/T009. */
export const testingPlaceholder = (): string => TESTING_PACKAGE;
