/**
 * @interleave/api — the Hono API server (gold-standard phase).
 *
 * This is a stub for T001 so the workspace has a home for the server. The real
 * Hono app (auth, typed RPC routes, health checks) is scaffolded in T051; the
 * MVP is local-first and needs no server.
 */
export const API_APP = "@interleave/api" as const;

/** Placeholder until the Hono server is defined in T051. */
export const apiPlaceholder = (): string => API_APP;
