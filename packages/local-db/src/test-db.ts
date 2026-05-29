/**
 * In-memory SQLite test harness for this package's own repository tests (T008).
 *
 * `packages/local-db` is a LEAF of the workspace graph (it depends only on
 * `@interleave/core` + `@interleave/db`). The higher-level `@interleave/testing`
 * package, which carries the shared demo-collection factory, depends on THIS
 * package — so local-db must not depend back on testing (that would be a package
 * cycle Turbo rejects). This tiny helper therefore lives here: it opens a fresh
 * in-memory `better-sqlite3` database via `@interleave/db` and runs the generated
 * Drizzle migrations, exactly mirroring `@interleave/testing`'s harness, so these
 * tests still exercise the real schema + pragmas.
 */

import { type DbHandle, migrateDatabase, openDatabase } from "@interleave/db";

/**
 * Open a fresh in-memory SQLite database with all M1 migrations applied. Callers
 * MUST close `handle.sqlite` when done (e.g. in `afterEach`).
 */
export function createInMemoryDb(): DbHandle {
  const handle = openDatabase(":memory:");
  migrateDatabase(handle.db);
  return handle;
}
