/**
 * @interleave/db — Drizzle schemas, migrations, and repositories.
 *
 * All persistence lives behind this package: the Drizzle schema (T006), PGlite
 * wiring (T007), and the repository classes (T008) that are the only seam React
 * is allowed to touch. No SQL or schema definitions exist yet — this trivial
 * export only proves the package resolves across the workspace.
 */
export const DB_PACKAGE = "@interleave/db" as const;

/** Placeholder until the Drizzle schema is defined in T006. */
export const dbPlaceholder = (): string => DB_PACKAGE;
