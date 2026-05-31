/**
 * Shell identity + streak hook tests.
 *
 * The sidebar's user chip + streak indicator are wired to REAL `window.appApi`
 * data — the `displayName` setting and the analytics snapshot (`dayStreak` /
 * `retention30d`) — not a hardcoded persona/streak. This asserts:
 *  - the identity is derived from the persisted display name;
 *  - the streak is read from analytics (day streak + rounded retention);
 *  - both refresh when a command-level undo fires (`UNDO_EVENT`);
 *  - outside the desktop shell it degrades to the neutral identity + no streak.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SETTINGS_CHANGED_EVENT, UNDO_EVENT } from "./nav";
import { useShellIdentity } from "./useShellIdentity";

const h = vi.hoisted(() => ({
  isDesktop: vi.fn(() => true),
  getAppSettings: vi.fn(),
  getAnalytics: vi.fn(),
}));

vi.mock("../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../lib/appApi")>("../lib/appApi");
  return {
    ...actual,
    isDesktop: () => h.isDesktop(),
    appApi: {
      getAppSettings: h.getAppSettings,
      getAnalytics: h.getAnalytics,
    },
  };
});

function settings(displayName: string) {
  return { settings: { displayName } };
}

function analytics(dayStreak: number, retention30d: number | null) {
  return {
    asOf: "2026-05-31T00:00:00.000Z",
    windowDays: 30,
    reviewsByDay: [],
    reviewsTotal: 0,
    reviewsPerDayAvg: 0,
    retention30d,
    dueCards: 0,
    dueTopics: 0,
    newCards: 0,
    newExtracts: 0,
    deletions: 0,
    leeches: 0,
    dayStreak,
  };
}

describe("useShellIdentity", () => {
  beforeEach(() => {
    h.isDesktop.mockReset();
    h.getAppSettings.mockReset();
    h.getAnalytics.mockReset();
  });

  it("derives the identity from displayName and the streak from analytics", async () => {
    h.isDesktop.mockReturnValue(true);
    h.getAppSettings.mockResolvedValue(settings("Ada Lovelace"));
    h.getAnalytics.mockResolvedValue(analytics(128, 0.94));

    const { result } = renderHook(() => useShellIdentity());

    await waitFor(() => expect(result.current.identity.name).toBe("Ada Lovelace"));
    expect(result.current.identity.initials).toBe("AL");
    await waitFor(() => expect(result.current.streak).not.toBeNull());
    expect(result.current.streak).toEqual({ dayStreak: 128, retentionPct: 94 });
  });

  it("degrades to the neutral identity when no name is set", async () => {
    h.isDesktop.mockReturnValue(true);
    h.getAppSettings.mockResolvedValue(settings(""));
    h.getAnalytics.mockResolvedValue(analytics(0, null));

    const { result } = renderHook(() => useShellIdentity());

    await waitFor(() => expect(h.getAppSettings).toHaveBeenCalled());
    expect(result.current.identity.name).toBe("Local vault");
    expect(result.current.identity.hasName).toBe(false);
    await waitFor(() =>
      expect(result.current.streak).toEqual({ dayStreak: 0, retentionPct: null }),
    );
  });

  it("refreshes on UNDO_EVENT (undo can change the streak)", async () => {
    h.isDesktop.mockReturnValue(true);
    h.getAppSettings.mockResolvedValue(settings("Ada"));
    h.getAnalytics.mockResolvedValue(analytics(5, 0.8));

    const { result } = renderHook(() => useShellIdentity());
    await waitFor(() => expect(result.current.streak?.dayStreak).toBe(5));

    h.getAnalytics.mockResolvedValue(analytics(4, 0.8));
    act(() => {
      window.dispatchEvent(new CustomEvent(UNDO_EVENT));
    });
    await waitFor(() => expect(result.current.streak?.dayStreak).toBe(4));
  });

  it("refreshes on SETTINGS_CHANGED_EVENT (the name was edited in /settings)", async () => {
    h.isDesktop.mockReturnValue(true);
    h.getAppSettings.mockResolvedValue(settings(""));
    h.getAnalytics.mockResolvedValue(analytics(0, null));

    const { result } = renderHook(() => useShellIdentity());
    await waitFor(() => expect(result.current.identity.name).toBe("Local vault"));

    h.getAppSettings.mockResolvedValue(settings("Ada Lovelace"));
    act(() => {
      window.dispatchEvent(new CustomEvent(SETTINGS_CHANGED_EVENT));
    });
    await waitFor(() => expect(result.current.identity.name).toBe("Ada Lovelace"));
    expect(result.current.identity.initials).toBe("AL");
  });

  it("does not query the bridge or expose a streak outside the desktop shell", async () => {
    h.isDesktop.mockReturnValue(false);

    const { result } = renderHook(() => useShellIdentity());

    expect(h.getAppSettings).not.toHaveBeenCalled();
    expect(h.getAnalytics).not.toHaveBeenCalled();
    expect(result.current.streak).toBeNull();
    expect(result.current.identity.name).toBe("Local vault");
  });
});
