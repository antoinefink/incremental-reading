/**
 * @interleave/web — the React + Vite app (the MVP lives almost entirely here).
 *
 * This is a stub for T001. The real Vite/React/TanStack Router app is scaffolded
 * in T003. The import below is intentional: consuming a value from
 * `@interleave/core` proves the TS project references resolve a workspace package
 * in dev without a build step (the load-bearing wiring T001 must demonstrate).
 */
import { corePlaceholder } from "@interleave/core";

export const WEB_APP = "@interleave/web" as const;

/** Proves the cross-package import resolves at typecheck time. */
export const webPlaceholder = (): string => `${WEB_APP} → ${corePlaceholder()}`;
