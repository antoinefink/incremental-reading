import { fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  desktop: true,
  health: vi.fn(),
  dbStatus: vi.fn(),
  getSettings: vi.fn(),
  updateSetting: vi.fn(),
}));

vi.mock("../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../lib/appApi")>("../lib/appApi");
  return {
    ...actual,
    isDesktop: () => h.desktop,
    appApi: {
      health: h.health,
      dbStatus: h.dbStatus,
      getSettings: h.getSettings,
      updateSetting: h.updateSetting,
    },
  };
});

import { DesktopStatusPanel } from "./DesktopStatusPanel";

beforeEach(() => {
  h.desktop = true;
  h.health.mockReset();
  h.dbStatus.mockReset();
  h.getSettings.mockReset();
  h.updateSetting.mockReset();
  h.health.mockResolvedValue({ status: "ok", version: "0.2.0" });
  h.dbStatus.mockResolvedValue({
    open: true,
    migrated: true,
    journalMode: "wal",
    foreignKeys: true,
    busyTimeoutMs: 5000,
    appliedMigrations: 12,
  });
  h.getSettings.mockResolvedValue({ settings: { "desktop.lastCheck": "checked-before" } });
  h.updateSetting.mockResolvedValue({ ok: true });
});

describe("DesktopStatusPanel", () => {
  it("renders the no-desktop state without touching appApi", () => {
    h.desktop = false;

    const { getByTestId, getByText } = render(<DesktopStatusPanel />);

    expect(getByTestId("desktop-status")).toHaveAttribute("data-desktop", "false");
    expect(getByText(/Running in a browser/)).toBeInTheDocument();
    expect(h.health).not.toHaveBeenCalled();
  });

  it("loads health, database status, and persisted check over the typed bridge", async () => {
    const { getByTestId } = render(<DesktopStatusPanel />);

    await waitFor(() => expect(getByTestId("health-status")).toHaveTextContent("ok"));
    expect(getByTestId("desktop-status")).toHaveAttribute("data-desktop", "true");
    expect(getByTestId("db-open")).toHaveTextContent("true");
    expect(getByTestId("db-migrated")).toHaveTextContent("true");
    expect(getByTestId("db-journal-mode")).toHaveTextContent("wal");
    expect(getByTestId("db-foreign-keys")).toHaveTextContent("true");
    expect(getByTestId("db-busy-timeout")).toHaveTextContent("5000ms");
    expect(getByTestId("db-applied-migrations")).toHaveTextContent("12");
    expect(getByTestId("persisted-value")).toHaveTextContent("checked-before");
    expect(h.getSettings).toHaveBeenCalledWith({ key: "desktop.lastCheck" });
  });

  it("writes a persisted check and refreshes", async () => {
    vi.spyOn(Date.prototype, "toISOString").mockReturnValue("2026-06-03T13:00:00.000Z");
    h.getSettings
      .mockResolvedValueOnce({ settings: { "desktop.lastCheck": "checked-before" } })
      .mockResolvedValueOnce({
        settings: { "desktop.lastCheck": "checked-2026-06-03T13:00:00.000Z" },
      });
    const { getByTestId } = render(<DesktopStatusPanel />);
    await waitFor(() => expect(getByTestId("persisted-value")).toHaveTextContent("checked-before"));

    fireEvent.click(getByTestId("persist-button"));

    await waitFor(() =>
      expect(h.updateSetting).toHaveBeenCalledWith({
        key: "desktop.lastCheck",
        value: "checked-2026-06-03T13:00:00.000Z",
      }),
    );
    await waitFor(() =>
      expect(getByTestId("persisted-value")).toHaveTextContent("checked-2026-06-03T13:00:00.000Z"),
    );
  });
});
