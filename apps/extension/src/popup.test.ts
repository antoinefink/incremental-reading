// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenSourceOutcome } from "./shared";

const sendMessage = vi.fn();
const openOptionsPage = vi.fn();
type OpenCapturedSource = (
  sourceId: string,
  options?: { readonly activate?: boolean },
) => Promise<OpenSourceOutcome>;

const h = vi.hoisted(() => ({
  openCapturedSource: vi.fn<OpenCapturedSource>(),
}));

vi.mock("./shared", async () => {
  const actual = await vi.importActual<typeof import("./shared")>("./shared");
  return {
    ...actual,
    openCapturedSource: h.openCapturedSource,
  };
});

function installChromeMock() {
  vi.stubGlobal("chrome", {
    tabs: {
      query: vi.fn(async () => [{ id: 5, title: "Current article", url: "https://example.com" }]),
    },
    runtime: {
      lastError: null,
      sendMessage,
      openOptionsPage,
    },
    sidePanel: {
      open: vi.fn(async () => undefined),
    },
  });
}

function installDom() {
  document.body.innerHTML = `
    <p id="page-title"></p>
    <div id="result"></div>
    <button id="save-page"></button>
    <button id="save-inbox"></button>
    <button id="save-selection"></button>
    <button id="open-options"></button>
    <button id="open-panel"></button>
  `;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  installDom();
  installChromeMock();
  h.openCapturedSource.mockResolvedValue({ kind: "ok", sourceId: "src-1" });
  sendMessage.mockImplementation((_message, cb) => {
    cb({
      kind: "ok",
      response: {
        ok: true,
        id: "src-1",
        kind: "page",
        title: "Saved article",
        deduped: false,
      },
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("extension popup", () => {
  it("shows the active tab title and dispatches popup save messages", async () => {
    await import("./popup");

    await vi.waitFor(() =>
      expect(document.getElementById("page-title")?.textContent).toContain("Current article"),
    );

    (document.getElementById("save-selection") as HTMLButtonElement).click();

    expect(sendMessage).toHaveBeenCalledWith({ type: "save-selection" }, expect.any(Function));
    await vi.waitFor(() =>
      expect(document.getElementById("result")?.textContent).toContain("Saved article"),
    );
    expect(document.querySelector("#result .status.ok")).not.toBeNull();
  });

  it("renders an open action after capture success and opens the captured source", async () => {
    await import("./popup");

    (document.getElementById("save-page") as HTMLButtonElement).click();

    const open = await vi.waitFor(() => {
      const button = Array.from(
        document.querySelectorAll<HTMLButtonElement>("#result button"),
      ).find((candidate) => candidate.textContent === "Open in Interleave");
      expect(button).toBeTruthy();
      return button as HTMLButtonElement;
    });

    open.click();

    await vi.waitFor(() =>
      expect(h.openCapturedSource).toHaveBeenCalledWith("src-1", { activate: true }),
    );
    await vi.waitFor(() => expect(open.textContent).toBe("Opened in Interleave"));
  });

  it("opens the existing id returned by a deduped capture", async () => {
    sendMessage.mockImplementation((_message, cb) => {
      cb({
        kind: "ok",
        response: {
          ok: true,
          id: "existing-1",
          kind: "page",
          title: "Saved article",
          deduped: true,
        },
      });
    });
    await import("./popup");

    (document.getElementById("save-page") as HTMLButtonElement).click();

    await vi.waitFor(() =>
      expect(document.getElementById("result")?.textContent).toContain("Already saved"),
    );
    const open = document.querySelector<HTMLButtonElement>("#result button.status-action");
    expect(open).toBeTruthy();
    open?.click();

    await vi.waitFor(() =>
      expect(h.openCapturedSource).toHaveBeenCalledWith("existing-1", { activate: true }),
    );
  });

  it("renders existing warning state when opening reports a bad token", async () => {
    h.openCapturedSource.mockResolvedValueOnce({ kind: "bad-token" });
    await import("./popup");

    (document.getElementById("save-page") as HTMLButtonElement).click();
    const open = await vi.waitFor(() => {
      const button = document.querySelector<HTMLButtonElement>("#result button.status-action");
      expect(button).toBeTruthy();
      return button as HTMLButtonElement;
    });
    open.click();

    await vi.waitFor(() =>
      expect(document.querySelector("#result .open-status")?.textContent).toContain("Bad token"),
    );
    expect(document.querySelector("#result .open-status")?.className).toBe(
      "status warn open-status",
    );
  });

  it("opens the options page from the popup", async () => {
    await import("./popup");

    (document.getElementById("open-options") as HTMLButtonElement).click();

    expect(openOptionsPage).toHaveBeenCalledOnce();
  });
});
