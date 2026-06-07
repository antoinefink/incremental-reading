// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pairWithApp, pingApp, writePairedConfig } from "./shared";

const h = vi.hoisted(() => ({
  readPairedConfig: vi.fn(),
  writePairedConfig: vi.fn(),
  pingApp: vi.fn(),
  pairWithApp: vi.fn(),
}));

vi.mock("./shared", async () => {
  const actual = await vi.importActual<typeof import("./shared")>("./shared");
  return {
    ...actual,
    readPairedConfig: h.readPairedConfig,
    writePairedConfig: h.writePairedConfig,
    pingApp: h.pingApp,
    pairWithApp: h.pairWithApp,
  };
});

function installDom() {
  document.body.innerHTML = `
    <section id="connection-card">
      <span id="connection-title"></span>
      <span id="connection-detail"></span>
    </section>
    <input id="token" type="password" />
    <input id="port" />
    <button id="toggle-token" aria-label="Show token">Show</button>
    <button id="save"></button>
    <span id="status" hidden></span>
  `;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  installDom();
  h.readPairedConfig.mockResolvedValue({ token: "saved-token", port: 47616 });
  h.writePairedConfig.mockResolvedValue(undefined);
  h.pingApp.mockResolvedValue(true);
  h.pairWithApp.mockResolvedValue(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function importOptions() {
  await import("./options");
}

describe("extension options page", () => {
  it("loads the paired token and port into the redesigned form", async () => {
    await importOptions();

    await vi.waitFor(() =>
      expect((document.getElementById("token") as HTMLInputElement).value).toBe("saved-token"),
    );
    expect((document.getElementById("port") as HTMLInputElement).value).toBe("47616");
    expect(document.getElementById("connection-title")?.textContent).toBe("Token saved");
  });

  it("toggles token visibility with an accessible label", async () => {
    await importOptions();
    await vi.waitFor(() =>
      expect((document.getElementById("token") as HTMLInputElement).value).toBe("saved-token"),
    );

    (document.getElementById("toggle-token") as HTMLButtonElement).click();

    expect((document.getElementById("token") as HTMLInputElement).type).toBe("text");
    expect(document.getElementById("toggle-token")?.textContent).toBe("Hide");
    expect(document.getElementById("toggle-token")?.getAttribute("aria-label")).toBe("Hide token");
  });

  it("warns before saving when the token is missing", async () => {
    h.readPairedConfig.mockResolvedValue({ token: null, port: 47615 });
    await importOptions();
    await vi.waitFor(() =>
      expect((document.getElementById("port") as HTMLInputElement).value).toBe("47615"),
    );

    (document.getElementById("save") as HTMLButtonElement).click();

    expect(writePairedConfig).not.toHaveBeenCalled();
    expect(document.getElementById("status")?.textContent).toContain("Paste the token");
    expect(document.getElementById("status")?.className).toBe("status warn");
    expect(document.getElementById("connection-title")?.textContent).toBe("Not connected");
  });

  it("persists pairing, pings the app, pairs the extension origin, and reports success", async () => {
    await importOptions();
    await vi.waitFor(() =>
      expect((document.getElementById("token") as HTMLInputElement).value).toBe("saved-token"),
    );

    (document.getElementById("token") as HTMLInputElement).value = "new-token";
    (document.getElementById("port") as HTMLInputElement).value = "47619";
    (document.getElementById("save") as HTMLButtonElement).click();

    await vi.waitFor(() => expect(writePairedConfig).toHaveBeenCalledWith("new-token", 47619));
    expect(pingApp).toHaveBeenCalledWith(47619);
    await vi.waitFor(() => expect(pairWithApp).toHaveBeenCalledWith("new-token", 47619));
    await vi.waitFor(() => expect(document.getElementById("status")?.textContent).toBe("Paired"));
    expect(document.getElementById("status")?.className).toBe("status ok");
    expect(document.getElementById("connection-title")?.textContent).toBe("Connected");
  });

  it("reports when the desktop app is not reachable", async () => {
    h.pingApp.mockResolvedValue(false);
    await importOptions();
    await vi.waitFor(() =>
      expect((document.getElementById("token") as HTMLInputElement).value).toBe("saved-token"),
    );

    (document.getElementById("save") as HTMLButtonElement).click();

    await vi.waitFor(() =>
      expect(document.getElementById("status")?.textContent).toContain("App not reachable"),
    );
    expect(document.getElementById("status")?.className).toBe("status err");
    expect(document.getElementById("connection-title")?.textContent).toBe(
      "Interleave not reachable",
    );
  });

  it("reports bad token pairing failures distinctly", async () => {
    h.pairWithApp.mockResolvedValue(false);
    await importOptions();
    await vi.waitFor(() =>
      expect((document.getElementById("token") as HTMLInputElement).value).toBe("saved-token"),
    );

    (document.getElementById("save") as HTMLButtonElement).click();

    await vi.waitFor(() =>
      expect(document.getElementById("status")?.textContent).toContain("Bad token"),
    );
    expect(document.getElementById("status")?.className).toBe("status err");
    expect(document.getElementById("connection-title")?.textContent).toBe("Pairing failed");
  });
});
