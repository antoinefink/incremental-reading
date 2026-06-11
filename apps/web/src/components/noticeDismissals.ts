import type { SettingValue } from "../lib/appApi";

export const NOTICE_DISMISSALS_KEY = "ui.noticeDismissals";
export const ONE_WEEK_NOTICE_DISMISSAL_MS = 7 * 24 * 60 * 60 * 1000;

export interface NoticeDismissal {
  readonly until?: string;
}

export type NoticeDismissals = Record<string, NoticeDismissal>;

function isSettingObject(value: SettingValue | undefined): value is Record<string, SettingValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseNoticeDismissals(value: SettingValue | undefined): NoticeDismissals {
  if (!isSettingObject(value)) return {};

  const dismissals: NoticeDismissals = {};
  for (const [id, raw] of Object.entries(value)) {
    if (!isSettingObject(raw)) continue;
    const until = typeof raw.until === "string" ? raw.until : undefined;
    if (until) dismissals[id] = { until };
  }
  return dismissals;
}

export function isNoticeDismissed(
  dismissals: NoticeDismissals,
  id: string,
  now = Date.now(),
): boolean {
  const dismissal = dismissals[id];
  if (!dismissal) return false;
  if (!dismissal.until) return false;
  const untilMs = Date.parse(dismissal.until);
  return Number.isFinite(untilMs) && untilMs > now;
}

export function dismissNoticeUntil(
  dismissals: NoticeDismissals,
  id: string,
  until: string,
): NoticeDismissals {
  return { ...dismissals, [id]: { until } };
}
