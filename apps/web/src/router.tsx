/**
 * Application router (T003) — code-based, fully typed TanStack Router.
 *
 * Seven placeholder routes are defined here:
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
 * persistent app shell (sidebar/topbar/inspector/status bar + ⌘K) is built in
 * T004 and will replace the minimal RootLayout below; routing wiring stays.
 *
 * No domain logic here — routes render placeholders; data wiring lands after
 * PGlite (T007) and the repositories (T008).
 */
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  useParams,
} from "@tanstack/react-router";
import { Icon, type IconName } from "./components/Icon";
import { Placeholder } from "./pages/Placeholder";
import { toggleTheme } from "./theme";

/** Sidebar nav model. `/` is the home/queue landing; the rest map 1:1 to routes. */
const NAV: ReadonlyArray<{ to: string; icon: IconName; label: string }> = [
  { to: "/", icon: "layers", label: "Home" },
  { to: "/queue", icon: "queue", label: "Queue" },
  { to: "/inbox", icon: "inbox", label: "Inbox" },
  { to: "/review", icon: "review", label: "Review" },
  { to: "/search", icon: "search", label: "Library" },
  { to: "/settings", icon: "settings", label: "Settings" },
];

/**
 * Minimal token-driven layout so routes are navigable now. This is intentionally
 * NOT the final shell (that's T004) — just enough chrome to reach every route by
 * click or URL and to exercise the theme toggle.
 */
function RootLayout() {
  return (
    <div className="flex h-full w-full bg-canvas font-ui text-base text-text">
      <aside className="flex w-sidebar flex-none flex-col border-border border-r bg-sunken">
        <div className="flex h-topbar flex-none items-center gap-2 px-4">
          <span className="grid size-6 place-items-center rounded-sm bg-accent text-text-on-accent">
            <Icon name="layers" size={16} />
          </span>
          <span className="font-semibold tracking-tight">Interleave</span>
        </div>
        <nav className="flex flex-col gap-px p-2">
          {NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              data-testid={`nav-${item.label.toLowerCase()}`}
              activeOptions={{ exact: item.to === "/" }}
              className="flex items-center gap-2 rounded-md px-3 py-2 text-text-2 transition-colors hover:bg-surface-2 hover:text-text aria-[current=page]:bg-accent-soft aria-[current=page]:text-accent-text"
            >
              <Icon name={item.icon} size={17} />
              {item.label}
            </Link>
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-topbar flex-none items-center gap-3 border-border border-b px-4">
          <div className="flex flex-1 items-center gap-2 text-text-3">
            <Icon name="search" size={15} />
            <span className="text-sm">Search, import, or run command…</span>
          </div>
          <button
            type="button"
            data-testid="theme-toggle"
            onClick={() => toggleTheme()}
            aria-label="Toggle color theme"
            className="grid size-7 place-items-center rounded-md text-text-2 transition-colors hover:bg-surface-2 hover:text-text"
          >
            <Icon name="sun" size={16} />
          </button>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

const rootRoute = createRootRoute({ component: RootLayout });

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
