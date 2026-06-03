/**
 * Help context (design handoff) — carries the contextual-help state any surface
 * can hook into: whether proactive tips are enabled, the once-only "seen" set for
 * coachmarks, and the imperative `openHelp` / `startTour` entry points.
 *
 * The Shell owns the actual state and its persistence (the SQLite `settings`
 * table via `window.appApi`); this module only defines the shape + a safe default
 * so components render outside a provider (e.g. in unit tests) as no-ops.
 */
import { createContext, type ReactNode, useContext } from "react";

export interface HelpContextValue {
  /** Whether proactive coachmarks / first-run callouts are shown at all. */
  readonly tipsEnabled: boolean;
  readonly setTipsEnabled: (value: boolean) => void;
  /** Whether a once-only coachmark id has already been dismissed. */
  readonly isSeen: (id: string) => boolean;
  /** Mark a once-only coachmark id as seen (persisted). */
  readonly markSeen: (id: string) => void;
  /** Clear all seen flags (re-arms every proactive tip). */
  readonly resetTips: () => void;
  /** Open the help center, optionally to a specific article slug. */
  readonly openHelp: (slug?: string) => void;
  /** (Re)start the first-run guided tour. */
  readonly startTour: () => void;
}

const DEFAULT_VALUE: HelpContextValue = {
  tipsEnabled: true,
  setTipsEnabled: () => {},
  isSeen: () => false,
  markSeen: () => {},
  resetTips: () => {},
  openHelp: () => {},
  startTour: () => {},
};

const HelpContext = createContext<HelpContextValue>(DEFAULT_VALUE);

export function HelpProvider({
  value,
  children,
}: {
  value: HelpContextValue;
  children: ReactNode;
}) {
  return <HelpContext.Provider value={value}>{children}</HelpContext.Provider>;
}

export function useHelp(): HelpContextValue {
  return useContext(HelpContext);
}
