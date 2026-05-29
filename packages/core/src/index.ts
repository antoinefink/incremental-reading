/**
 * @interleave/core — framework-agnostic domain vocabulary.
 *
 * This package is the shared language (the `Element` model, enums, scheduler
 * interfaces) imported by every layer. It must stay free of React, Drizzle, and
 * any persistence/UI concerns (see CLAUDE.md layering rules). The real domain
 * types land in T005; this trivial export exists only to prove the package
 * resolves across the workspace via TS project references.
 */
export const CORE_PACKAGE = "@interleave/core" as const;

/** Placeholder until the domain model is defined in T005. */
export const corePlaceholder = (): string => CORE_PACKAGE;
