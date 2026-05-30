/**
 * Persistent app shell (T004).
 *
 * The workspace chrome every screen shares, rebuilt from the kit's shell.jsx for
 * React 19 + Tailwind v4 + TanStack Router:
 *
 *   ┌────────────┬───────────────────────────────┬──────────────┐
 *   │  Sidebar   │  Topbar (command bar · ⌘K)    │  Inspector   │
 *   │  brand     ├───────────────────────────────┤  (placeholder│
 *   │  nav       │  Work area (route <Outlet/>)   │   for T010)  │
 *   │  Organize  │                               │              │
 *   │  streak    ├───────────────────────────────┤              │
 *   │  user chip │  Status bar (shortcut hints)  │              │
 *   └────────────┴───────────────────────────────┴──────────────┘
 *
 * Layout dims come exclusively from the design tokens (--sidebar-w /
 * --inspector-w / --topbar-h) via shell.css; no hard-coded px. The shell hosts
 * the ⌘K command palette, the ? cheat sheet, and g+letter navigation. The
 * right inspector is a placeholder container now (T010 fills it).
 *
 * No domain logic lives here: navigation goes through TanStack Router and the
 * nav/command catalogues are static config.
 */
import type { LocalVaultPath, VaultRoot } from "@interleave/core";
import { Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { Inspector } from "../components/inspector/Inspector";
import { Snackbar } from "../components/Snackbar";
import { appApi, isDesktop } from "../lib/appApi";
import { toggleTheme as applyToggleTheme, getStoredTheme, type Theme } from "../theme";
import { CheatSheet } from "./CheatSheet";
import { CommandPalette } from "./CommandPalette";
import { Kbd } from "./Kbd";
import { type NavItem, PRIMARY_NAV, SECONDARY_NAV, UNDO_EVENT } from "./nav";
import { SelectionProvider, useSelection } from "./selection";
import "./shell.css";
import type { PaletteActionId } from "./shortcuts";
import { useGlobalActions } from "./useGlobalActions";
import { useShellShortcuts } from "./useShellShortcuts";

/** Whether a sidebar entry is the active route (longest-prefix, exact for "/"). */
function isActive(pathname: string, to: string): boolean {
  if (to === "/") return pathname === "/";
  return pathname === to || pathname.startsWith(`${to}/`);
}

function NavButton({ item, pathname }: { item: NavItem; pathname: string }) {
  const active = isActive(pathname, item.to);
  return (
    <Link
      to={item.to}
      data-testid={`nav-${item.id}`}
      className={active ? "shell-nav__item shell-nav__item--on" : "shell-nav__item"}
      aria-current={active ? "page" : undefined}
    >
      <Icon name={item.icon} size={17} />
      {item.label}
      {item.badge != null && <span className="shell-nav__badge">{item.badge}</span>}
    </Link>
  );
}

function Sidebar({
  pathname,
  theme,
  onToggleTheme,
  onOpenCheat,
}: {
  pathname: string;
  theme: Theme;
  onToggleTheme: () => void;
  onOpenCheat: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuWrapRef = useRef<HTMLDivElement>(null);

  // Close the user menu on a click outside the chip/menu, or on Escape.
  useEffect(() => {
    if (!menuOpen) return;
    function onPointerDown(e: MouseEvent) {
      if (!menuWrapRef.current?.contains(e.target as Node)) setMenuOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  return (
    <aside className="shell-sidebar">
      <div className="shell-brand">
        <span className="shell-brand__logo">
          <Icon name="layers" size={16} />
        </span>
        <div className="flex flex-col">
          <span className="shell-brand__name">Interleave</span>
          <span className="shell-brand__sub">Reading OS</span>
        </div>
      </div>

      <nav className="shell-nav" aria-label="Primary">
        {PRIMARY_NAV.map((item) => (
          <NavButton key={item.id} item={item} pathname={pathname} />
        ))}
        <div className="shell-nav__label">Organize</div>
        {SECONDARY_NAV.map((item) => (
          <NavButton key={item.id} item={item} pathname={pathname} />
        ))}
      </nav>

      <div className="shell-sidebar__foot">
        <div className="shell-streak">
          <Icon name="flame" size={13} />
          <span className="shell-streak__n">128-day streak</span>
          <span className="shell-streak__l">94%</span>
        </div>
        <div className="shell-userchip-wrap" ref={menuWrapRef}>
          <button
            type="button"
            className="shell-userchip"
            data-testid="user-chip"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((o) => !o)}
          >
            <span className="shell-avatar">AK</span>
            <div className="flex flex-col">
              <span className="shell-userchip__name">Ana Kestrel</span>
              <span className="shell-userchip__sub">Local vault</span>
            </div>
            <Icon name="chevronDown" size={14} className="ml-auto text-text-3" />
          </button>
          {menuOpen && (
            <div className="shell-usermenu" role="menu">
              <button
                type="button"
                className="shell-usermenu__item"
                role="menuitem"
                onClick={onToggleTheme}
              >
                <Icon name={theme === "dark" ? "sun" : "moon"} size={14} />
                <span className="shell-grow">{theme === "dark" ? "Light mode" : "Dark mode"}</span>
              </button>
              <Link
                to="/settings"
                className="shell-usermenu__item"
                role="menuitem"
                onClick={() => setMenuOpen(false)}
              >
                <Icon name="settings" size={14} />
                <span className="shell-grow">Settings</span>
              </Link>
              <button
                type="button"
                className="shell-usermenu__item"
                role="menuitem"
                onClick={() => {
                  onOpenCheat();
                  setMenuOpen(false);
                }}
              >
                <Icon name="keyboard" size={14} />
                <span className="shell-grow">Keyboard shortcuts</span>
                <Kbd keys="?" />
              </button>
              <hr className="shell-usermenu__sep" />
              <button type="button" className="shell-usermenu__item" role="menuitem">
                <Icon name="shield" size={14} />
                <span className="shell-grow">Local vault · synced</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}

function Topbar({ onOpenCommand }: { onOpenCommand: () => void }) {
  return (
    <header className="shell-topbar">
      <button
        type="button"
        className="shell-cmdbar"
        data-testid="command-bar"
        onClick={onOpenCommand}
        aria-label="Open command palette"
      >
        <Icon name="search" size={15} />
        <span className="shell-cmdbar__ph">Search, import, or run command…</span>
        <Kbd keys={["⌘", "K"]} />
      </button>
    </header>
  );
}

/**
 * The local asset vault the desktop app persists into. Typed with the real
 * `@interleave/core` vocabulary so the renderer references the vault root by its
 * canonical name — and demonstrably never resolves a raw filesystem path itself
 * (path resolution belongs to the Electron main process; T007). Real status
 * (open/migrated) will arrive from `window.appApi` once the shell lands.
 */
const VAULT_ROOT: VaultRoot = "assets";
const VAULT_DB_PATH: LocalVaultPath = { root: VAULT_ROOT, relativePath: "app.sqlite" };

function StatusBar() {
  return (
    <footer className="shell-statusbar" data-testid="status-bar">
      <span className="shell-statusbar__hint">
        <Kbd keys={["⌘", "K"]} />
        Command
      </span>
      <span className="shell-statusbar__hint">
        <Kbd keys={["G"]} />
        then a key to navigate
      </span>
      <span className="shell-statusbar__hint">
        <Kbd keys={["?"]} />
        Shortcuts
      </span>
      <span className="shell-statusbar__spacer" />
      <span className="shell-statusbar__hint" data-vault-root={VAULT_DB_PATH.root}>
        Local vault · offline-first
      </span>
    </footer>
  );
}

/**
 * The shell's interactive body. Lives INSIDE `SelectionProvider` so the global
 * shortcuts + the `⌘K` palette can act on the current selection (T048 — open
 * source / open parent / raise·lower priority operate on the selected element via
 * `useGlobalActions`, calling the SAME typed commands as the inspector buttons).
 */
function ShellInner() {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { selectedId } = useSelection();
  const globalActions = useGlobalActions();

  const [commandOpen, setCommandOpen] = useState(false);
  const [cheatOpen, setCheatOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>(() => getStoredTheme());
  const [undoToast, setUndoToast] = useState<string | null>(null);

  const onNavigate = (to: string) => {
    void navigate({ to });
  };

  /**
   * Run a registry-backed palette/shortcut ACTION (T048). This is the single map
   * from the closed `PaletteActionId` set to the shared handlers — both the `⌘K`
   * palette and (for `cheat-sheet`) the menus route through here, and the element
   * actions delegate to `useGlobalActions` (same `window.appApi` commands as the
   * inspector buttons). No domain logic here — pure dispatch.
   */
  const runAction = (actionId: PaletteActionId) => {
    switch (actionId) {
      case "open-source":
        globalActions.openSource();
        break;
      case "open-parent":
        globalActions.openParent();
        break;
      case "raise-priority":
        globalActions.raisePriority();
        break;
      case "lower-priority":
        globalActions.lowerPriority();
        break;
      case "search":
        globalActions.search();
        break;
      case "start-review":
        // The palette item already navigated to /review via its `to`; nothing more.
        break;
      case "cheat-sheet":
        setCheatOpen(true);
        break;
    }
  };

  /**
   * General command-level undo (T044) — ⌘Z reverses the LAST `operation_log` op from
   * anywhere (delete / mark-done / suspend / bulk-postpone) through
   * `appApi.undo.last()`. The main process applies the inverse (itself logged); we
   * toast the result label and dispatch `UNDO_EVENT` so the active screen re-reads
   * its data. No domain logic lives here — the inverse is computed main-side.
   */
  const onUndo = () => {
    if (!isDesktop()) return;
    void appApi
      .undoLast()
      .then((res) => {
        if (res.undone) {
          setUndoToast(res.label || "Undid last change");
          window.dispatchEvent(new CustomEvent(UNDO_EVENT));
        } else {
          setUndoToast(res.reason ?? "Nothing to undo");
        }
      })
      .catch((e: unknown) => {
        setUndoToast(e instanceof Error ? e.message : "Undo failed");
      });
  };

  // The native Help → "Keyboard shortcuts" (⌘/) menu item opens the in-app cheat
  // sheet via the narrow `menu.onShowShortcuts` bridge event (T048). No-op outside
  // the desktop shell.
  useEffect(() => {
    if (!isDesktop()) return;
    return appApi.onMenuShowShortcuts(() => setCheatOpen(true));
  }, []);

  const onToggleTheme = () => {
    const next = applyToggleTheme();
    setTheme(next);
    // Theme is a SQLite-backed setting (T011); persist the choice through the
    // typed bridge so it survives an app restart and stays in sync with
    // /settings. Best-effort — the in-memory + localStorage state already drives
    // the UI if the bridge call fails.
    if (isDesktop()) {
      void appApi.updateAppSettings({ patch: { theme: next } }).catch(() => {});
    }
  };

  useShellShortcuts({
    toggleCommandPalette: () => setCommandOpen((o) => !o),
    toggleCheatSheet: () => setCheatOpen((o) => !o),
    onNavigate,
    onUndo,
    onSearch: globalActions.search,
    onOpenSource: globalActions.openSource,
    onOpenParent: globalActions.openParent,
    onRaisePriority: globalActions.raisePriority,
    onLowerPriority: globalActions.lowerPriority,
  });

  return (
    <div className="app-shell">
      <Sidebar
        pathname={pathname}
        theme={theme}
        onToggleTheme={onToggleTheme}
        onOpenCheat={() => setCheatOpen(true)}
      />

      <div className="shell-main">
        <Topbar onOpenCommand={() => setCommandOpen(true)} />
        <main className="shell-page">
          <Outlet />
        </main>
        <StatusBar />
      </div>

      <Inspector />

      <CommandPalette
        open={commandOpen}
        onClose={() => setCommandOpen(false)}
        onNavigate={onNavigate}
        onAction={runAction}
        hasSelection={selectedId !== null}
      />
      <CheatSheet open={cheatOpen} onClose={() => setCheatOpen(false)} />
      {/* Global undo toast (T044) — confirms the ⌘Z command-level undo. */}
      <Snackbar
        message={undoToast}
        onClose={() => setUndoToast(null)}
        testId="shell-undo-snackbar"
      />
    </div>
  );
}

/**
 * Persistent app shell — provides the selection context, then renders the
 * interactive body (`ShellInner`) inside it so the global shortcuts + palette can
 * act on the selected element (T048).
 */
export function Shell() {
  return (
    <SelectionProvider>
      <ShellInner />
    </SelectionProvider>
  );
}
