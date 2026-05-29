/**
 * Application router (T003, shell wired in T004) — code-based, fully typed
 * TanStack Router.
 *
 * Seven routes are defined here, each rendered inside the persistent app shell:
 *   /            home (daily queue / command center landing)
 *   /inbox       import & triage
 *   /queue       due queue
 *   /source/$id  source reader (typed dynamic param)
 *   /review      active-recall review session
 *   /search      library / search
 *   /settings    local settings
 *
 * Code-based routing (vs the file-based codegen plugin) keeps the scaffold
 * explicit and dependency-light while the screens are still placeholders. The
 * root route renders the `Shell` (sidebar / command bar / work area / inspector
 * / status bar + ⌘K, ?, g-nav) once; every route's content paints in its
 * <Outlet/>.
 *
 * No domain logic here — routes render placeholders; data wiring lands after
 * PGlite (T007) and the repositories (T008).
 */
import { createRootRoute, createRoute, createRouter, useParams } from "@tanstack/react-router";
import { Placeholder } from "./pages/Placeholder";
import { Shell } from "./shell/Shell";

const rootRoute = createRootRoute({ component: Shell });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: () => (
    <Placeholder
      routeId="home"
      icon="layers"
      title="Home"
      body="Your daily command center. The queue, streak, and next actions land here."
    />
  ),
});

const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/inbox",
  component: () => (
    <Placeholder
      routeId="inbox"
      icon="inbox"
      title="Inbox"
      body="Triage freshly imported sources: keep, prioritize, accept, or discard."
    />
  ),
});

const queueRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/queue",
  component: () => (
    <Placeholder
      routeId="queue"
      icon="queue"
      title="Daily Queue"
      body="Due sources, extracts, and cards, sorted by priority then due date."
    />
  ),
});

const sourceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/source/$id",
  component: SourcePlaceholder,
});

function SourcePlaceholder() {
  const { id } = useParams({ from: "/source/$id" });
  return (
    <Placeholder
      routeId="source"
      icon="source"
      title={`Source ${id}`}
      body="The incremental reading workspace: read-point, highlights, and extraction."
    />
  );
}

const reviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/review",
  component: () => (
    <Placeholder
      routeId="review"
      icon="review"
      title="Review"
      body="Active-recall review: reveal, grade Again / Hard / Good / Easy, advance."
    />
  ),
});

const searchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/search",
  component: () => (
    <Placeholder
      routeId="search"
      icon="library"
      title="Library & Search"
      body="Find any source, extract, or card across your whole collection."
    />
  ),
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: () => (
    <Placeholder
      routeId="settings"
      icon="settings"
      title="Settings"
      body="Review budget, retention, default intervals, keyboard layout, and theme."
    />
  ),
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  inboxRoute,
  queueRoute,
  sourceRoute,
  reviewRoute,
  searchRoute,
  settingsRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
