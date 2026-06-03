import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  desktop: true,
  applyTheme: vi.fn(),
  getStoredTheme: vi.fn(() => "light"),
  getAppSettings: vi.fn(),
  createRoot: vi.fn(),
  render: vi.fn(),
}));

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
  h.desktop = true;
  h.applyTheme.mockReset();
  h.getStoredTheme.mockReset();
  h.getStoredTheme.mockReturnValue("light");
  h.getAppSettings.mockReset();
  h.getAppSettings.mockResolvedValue({ settings: { theme: "dark" } });
  h.createRoot.mockReset();
  h.render.mockReset();
  h.createRoot.mockReturnValue({ render: h.render });
});

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("react-dom/client");
  vi.doUnmock("@tanstack/react-router");
  vi.doUnmock("./lib/appApi");
  vi.doUnmock("./router");
  vi.doUnmock("./theme");
});

async function importMain() {
  vi.resetModules();
  vi.doMock("react-dom/client", () => ({ createRoot: h.createRoot }));
  vi.doMock("@tanstack/react-router", async () => {
    const React = await vi.importActual<typeof import("react")>("react");
    return {
      RouterProvider: ({ router }: { router: unknown }) =>
        React.createElement("div", { "data-testid": "router-provider", "data-router": router }),
    };
  });
  vi.doMock("./lib/appApi", () => ({
    appApi: { getAppSettings: h.getAppSettings },
    isDesktop: () => h.desktop,
  }));
  vi.doMock("./router", () => ({ router: { id: "router" } }));
  vi.doMock("./theme", () => ({
    applyTheme: h.applyTheme,
    getStoredTheme: h.getStoredTheme,
  }));

  return import("./main");
}

describe("web app entrypoint", () => {
  it("applies the cached theme, reconciles desktop settings, and mounts the router", async () => {
    await importMain();

    expect(h.getStoredTheme).toHaveBeenCalledOnce();
    expect(h.applyTheme).toHaveBeenCalledWith("light");
    expect(h.createRoot).toHaveBeenCalledWith(document.getElementById("root"));
    expect(h.render).toHaveBeenCalledOnce();
    await waitFor(() => expect(h.applyTheme).toHaveBeenCalledWith("dark"));
  });

  it("does not read desktop settings outside Electron", async () => {
    h.desktop = false;

    await importMain();

    expect(h.getAppSettings).not.toHaveBeenCalled();
    expect(h.applyTheme).toHaveBeenCalledTimes(1);
  });

  it("fails loudly when the root mount element is missing", async () => {
    document.body.innerHTML = "";

    await expect(importMain()).rejects.toThrow("Root element #root not found");
    expect(h.createRoot).not.toHaveBeenCalled();
  });
});
