/**
 * Shell navigation + keyboard config (T004).
 *
 * Pure UI configuration for the persistent app shell: the sidebar nav model,
 * the ⌘K command-palette catalogue, the `g`+letter navigation map, and the `?`
 * cheat-sheet contents. This is static presentation data — NOT domain logic —
 * so it lives in a plain module the shell components import (keeping the JSX
 * lean and the data testable in isolation).
 *
 * Routes here mirror the seven typed routes registered in `router.tsx`. Items
 * the kit lists that do not have a route yet (Library, Concepts, Analytics)
 * point at the closest existing route so the shell stays whole; they re-point
 * when those screens land in later milestones.
 */
import type { IconName } from "../components/Icon";
import { CHEAT_GROUP_ORDER, type PaletteActionId, paletteShortcuts, SHORTCUTS } from "./shortcuts";

/** A primary or secondary sidebar entry. */
export type NavItem = {
  /** Stable id, also used for the `nav-<id>` test hook. */
  readonly id: string;
  readonly label: string;
  readonly icon: IconName;
  /** Destination route path (a registered TanStack Router path). */
  readonly to: string;
  /**
   * Whether this entry shows a LIVE count badge (Queue / Inbox / Review). The
   * value is NOT stored here — it is read at render time from `window.appApi`
   * (`useNavBadges`: queue.list / inbox.list), keyed by `id`, so the badge always
   * reflects the real due/inbox counts rather than a hardcoded placeholder.
   */
  readonly liveBadge?: boolean;
};

/**
 * Primary nav, shown above the "Organize" divider — matches the kit's first
 * five entries (Queue, Inbox, Library, Review, Search). Queue / Inbox / Review
 * carry a LIVE count badge wired to real `window.appApi` data (see
 * `useNavBadges`) — no hardcoded counts.
 */
export const PRIMARY_NAV: readonly NavItem[] = [
  { id: "queue", label: "Queue", icon: "queue", to: "/queue", liveBadge: true },
  { id: "inbox", label: "Inbox", icon: "inbox", to: "/inbox", liveBadge: true },
  { id: "library", label: "Library", icon: "library", to: "/search" },
  { id: "review", label: "Review", icon: "review", to: "/review", liveBadge: true },
  { id: "search", label: "Search", icon: "search", to: "/search" },
];

/** Secondary "Organize" group — Concepts, Analytics, Settings in the kit. */
export const SECONDARY_NAV: readonly NavItem[] = [
  { id: "concepts", label: "Concepts", icon: "concepts", to: "/search" },
  { id: "analytics", label: "Analytics", icon: "analytics", to: "/analytics" },
  // The leech cleanup view (T040) — maintenance for repeatedly-failing cards. Lives
  // under the "Organize" group until the full M9 analytics/maintenance screen lands.
  { id: "leeches", label: "Leeches", icon: "leech", to: "/maintenance/leeches" },
  // The Trash view (T044) — soft-deleted elements, recoverable via Restore + undo.
  { id: "trash", label: "Trash", icon: "trash", to: "/trash" },
  { id: "settings", label: "Settings", icon: "settings", to: "/settings" },
];

/**
 * Context passed to a palette item's `when` gate so context-scoped action
 * commands (e.g. "Open source", "Raise priority") only appear when they apply.
 * Pure UI state — no domain data.
 */
export interface CommandContext {
  /** Whether an element is currently selected in the shell (T010 selection). */
  readonly hasSelection: boolean;
}

/**
 * A command-palette entry (T004, extended in T048).
 *
 * An entry may navigate (`to`), dispatch a screen `event`, run a registry-backed
 * ACTION (`actionId`, T048 — the palette's "do something" commands), or any
 * combination (e.g. "Start review" navigates to `/review`; "Search" navigates AND
 * runs the search action). `to` is optional now that action-only commands exist.
 */
export type CommandItem = {
  readonly group: string;
  readonly icon: IconName;
  readonly label: string;
  /** Route to navigate to when chosen (optional for action-only commands). */
  readonly to?: string;
  /** Optional keyboard hint rendered on the right. */
  readonly kbd?: readonly string[];
  /**
   * Optional `window` CustomEvent name dispatched (after navigating to `to`)
   * when the item is chosen. Lets a screen react to a palette action without the
   * palette knowing about that screen — e.g. "New manual note…" navigates to
   * `/inbox` AND opens its New-source modal. The detail is `undefined`.
   */
  readonly event?: string;
  /**
   * Optional registry-backed ACTION id (T048). When set, the palette runs the
   * shell's matching handler, which dispatches the SAME typed `window.appApi`
   * command (or navigation) as the on-screen button — no second mutation path.
   */
  readonly actionId?: PaletteActionId;
  /**
   * Optional visibility gate (T048). When present, the palette only shows the item
   * if it returns `true` for the current context (e.g. context-scoped actions show
   * only when an element is selected).
   */
  readonly when?: (ctx: CommandContext) => boolean;
};

/** CustomEvent name the inbox listens for to open its New-source modal (⌘K). */
export const NEW_SOURCE_EVENT = "interleave:new-source";

/**
 * CustomEvent name the shell dispatches after a successful global undo (⌘Z, T044)
 * so the active screen can re-read its data (the mutation reverted main-side). The
 * detail is `undefined`; listeners just re-fetch.
 */
export const UNDO_EVENT = "interleave:undo";

/**
 * CustomEvent name the /settings screen dispatches after a setting is persisted,
 * so shell chrome that reads settings (the sidebar's identity chip) can re-read
 * the change live without waiting for a remount. The detail is `undefined`;
 * listeners just re-fetch through the bridge.
 */
export const SETTINGS_CHANGED_EVENT = "interleave:settings-changed";

/**
 * Action entries DERIVED from the single shortcut registry (T048) — the palette's
 * "do something" commands (Open source, Open parent, Raise/Lower priority, Start
 * review, Search). Each carries the registry's `actionId` so `CommandPalette`'s
 * `runItem` dispatches the SAME `window.appApi`-backed handler as the on-screen
 * button (no second mutation path). Context-scoped actions are gated by `when` so
 * they only appear when an element is selected. Built from the registry so the
 * palette can never drift from the documented shortcuts.
 */
const ACTION_COMMAND_ITEMS: readonly CommandItem[] = paletteShortcuts().map((s) => {
  const p = s.palette;
  // Only the element-targeted actions are context-scoped; nav/session ones are
  // always available.
  const contextScoped =
    p?.actionId === "open-source" ||
    p?.actionId === "open-parent" ||
    p?.actionId === "raise-priority" ||
    p?.actionId === "lower-priority";
  const item: CommandItem = {
    group: p?.group ?? "Actions",
    icon: (p?.icon ?? "play") as IconName,
    label: s.label,
    kbd: s.keys,
    ...(p?.to ? { to: p.to } : {}),
    ...(p?.actionId ? { actionId: p.actionId } : {}),
    ...(contextScoped ? { when: (ctx: CommandContext) => ctx.hasSelection } : {}),
  };
  return item;
});

/**
 * ⌘K catalogue — the kit's navigation/create commands PLUS the registry-derived
 * ACTION entries (T048). "Go to"/"Create" navigate (and optionally open a modal);
 * the action entries run a typed command via `actionId`.
 */
export const COMMAND_ITEMS: readonly CommandItem[] = [
  { group: "Go to", icon: "queue", label: "Daily Queue", to: "/queue", kbd: ["G", "Q"] },
  { group: "Go to", icon: "inbox", label: "Inbox triage", to: "/inbox", kbd: ["G", "I"] },
  { group: "Go to", icon: "review", label: "Review session", to: "/review", kbd: ["G", "R"] },
  { group: "Go to", icon: "library", label: "Library & search", to: "/search", kbd: ["G", "L"] },
  { group: "Go to", icon: "concepts", label: "Concept map", to: "/search", kbd: ["G", "C"] },
  { group: "Go to", icon: "settings", label: "Settings", to: "/settings", kbd: ["G", "S"] },
  { group: "Create", icon: "link", label: "Import from URL…", to: "/inbox" },
  {
    group: "Create",
    icon: "paste",
    label: "Paste text as source…",
    to: "/inbox",
    event: NEW_SOURCE_EVENT,
  },
  { group: "Create", icon: "upload", label: "Upload PDF / EPUB…", to: "/inbox" },
  {
    group: "Create",
    icon: "text",
    label: "New manual note…",
    to: "/inbox",
    event: NEW_SOURCE_EVENT,
  },
  ...ACTION_COMMAND_ITEMS,
];

/**
 * `g`+letter quick-navigation map (pressing `g` then the letter). Matches the
 * kit: q→queue, i→inbox, r→review, l→library, c→concepts, a→analytics,
 * s→settings. Library/concepts share `/search` until they split out; analytics
 * has its own `/analytics` route (T045).
 */
export const GOTO_MAP: Readonly<Record<string, string>> = {
  q: "/queue",
  i: "/inbox",
  r: "/review",
  l: "/search",
  c: "/search",
  a: "/analytics",
  s: "/settings",
};

/** One cheat-sheet group: a heading plus [label, keys] rows. */
export type CheatGroup = {
  readonly group: string;
  readonly rows: readonly (readonly [string, readonly string[]])[];
};

/**
 * `?` cheat-sheet contents — DERIVED from the single shortcut registry (T048), so
 * the documentation can never drift from the real handlers. Each registry entry
 * becomes a `[label, keys]` row under its group; groups render in
 * `CHEAT_GROUP_ORDER`. (Before T048 this was a hand-maintained literal that could
 * silently disagree with what was actually bound.)
 */
export const CHEAT_SHEET: readonly CheatGroup[] = CHEAT_GROUP_ORDER.map((group) => ({
  group,
  rows: SHORTCUTS.filter((s) => s.group === group).map(
    (s) => [s.label, s.keys] as readonly [string, readonly string[]],
  ),
})).filter((g) => g.rows.length > 0);
