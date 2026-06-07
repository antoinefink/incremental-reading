// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenSourceOutcome } from "./shared";

const sendMessage = vi.fn();
const openOptionsPage = vi.fn();
const queryTabs = vi.fn();
const executeScript = vi.fn();
type OpenCapturedSource = (
  sourceId: string,
  options?: { readonly activate?: boolean },
) => Promise<OpenSourceOutcome>;

const h = vi.hoisted(() => ({
  openCapturedSource: vi.fn<OpenCapturedSource>(),
  readPairedConfig: vi.fn(),
  pingApp: vi.fn(),
}));

vi.mock("./shared", async () => {
  const actual = await vi.importActual<typeof import("./shared")>("./shared");
  return {
    ...actual,
    openCapturedSource: h.openCapturedSource,
    readPairedConfig: h.readPairedConfig,
    pingApp: h.pingApp,
  };
});

function installChromeMock(selection = "Important selected passage") {
  queryTabs.mockResolvedValue([
    { id: 5, title: "Current article", url: "https://example.com/articles/one" },
  ]);
  executeScript.mockResolvedValue([{ result: selection }]);
  vi.stubGlobal("chrome", {
    tabs: {
      query: queryTabs,
    },
    scripting: {
      executeScript,
    },
    runtime: {
      lastError: null,
      sendMessage,
      openOptionsPage,
    },
  });
}

function installDom() {
  document.body.innerHTML = `
    <div class="popup-shell" role="dialog" aria-label="Save to Interleave">
      <span id="connection-pill"></span>
      <main id="popup-body"></main>
      <button id="open-options" type="button"></button>
    </div>
  `;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  installDom();
  installChromeMock();
  h.openCapturedSource.mockResolvedValue({ kind: "ok", sourceId: "src-1" });
  h.readPairedConfig.mockResolvedValue({ token: "token", port: 47615 });
  h.pingApp.mockResolvedValue(true);
  sendMessage.mockImplementation((_message, cb) => {
    cb({
      kind: "ok",
      response: {
        ok: true,
        id: "src-1",
        kind: "selection",
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
  it("shows active tab context, selected text, connected state, and default priority", async () => {
    await import("./popup");

    await vi.waitFor(() =>
      expect(document.querySelector(".page-title")?.textContent).toContain("Current article"),
    );
    await vi.waitFor(() =>
      expect(document.getElementById("connection-pill")?.textContent).toContain("Connected"),
    );

    expect(document.querySelector(".selection-preview")?.textContent).toContain(
      "Important selected passage",
    );
    expect(document.querySelector('[data-priority="C"]')?.getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(document.body.textContent).not.toContain("Save to inbox");
    expect(document.body.textContent).not.toContain("Open side panel");
  });

  it("sends the selected priority with selection saves", async () => {
    await import("./popup");
    await vi.waitFor(() => expect(document.querySelector('[data-priority="A"]')).not.toBeNull());

    (document.querySelector('[data-priority="A"]') as HTMLButtonElement).click();
    (document.getElementById("save-selection") as HTMLButtonElement).click();

    expect(sendMessage).toHaveBeenCalledWith(
      {
        type: "save-selection",
        priority: "A",
        selection: "Important selected passage",
      },
      expect.any(Function),
    );
    await vi.waitFor(() =>
      expect(document.querySelector(".done-title")?.textContent).toBe("Extract saved"),
    );
    expect(document.querySelector(".badge-prio")?.textContent).toContain("A");
  });

  it("uses save-time priority for slow selection saves", async () => {
    let respond: ((outcome: unknown) => void) | undefined;
    sendMessage.mockImplementation((_message, cb) => {
      respond = cb;
    });
    await import("./popup");
    await vi.waitFor(() => expect(document.querySelector('[data-priority="D"]')).not.toBeNull());

    (document.querySelector('[data-priority="D"]') as HTMLButtonElement).click();
    (document.getElementById("save-selection") as HTMLButtonElement).click();

    expect(sendMessage).toHaveBeenCalledWith(
      {
        type: "save-selection",
        priority: "D",
        selection: "Important selected passage",
      },
      expect.any(Function),
    );
    expect((document.querySelector('[data-priority="A"]') as HTMLButtonElement).disabled).toBe(
      true,
    );
    (document.querySelector('[data-priority="A"]') as HTMLButtonElement).click();

    respond?.({
      kind: "ok",
      response: {
        ok: true,
        id: "src-1",
        kind: "selection",
        title: "Saved article",
        deduped: false,
      },
    });

    await vi.waitFor(() =>
      expect(document.querySelector(".done-title")?.textContent).toBe("Extract saved"),
    );
    expect(document.querySelector(".badge-prio")?.textContent).toContain("D");
  });

  it("falls back to a page-only layout when there is no current selection", async () => {
    installDom();
    installChromeMock("");
    await import("./popup");

    await vi.waitFor(() => expect(document.querySelector(".selection-empty")).not.toBeNull());
    expect(document.getElementById("save-selection")).toBeNull();

    (document.getElementById("save-page") as HTMLButtonElement).click();

    expect(sendMessage).toHaveBeenCalledWith(
      { type: "save-page", priority: "C" },
      expect.any(Function),
    );
  });

  it("renders an open action after capture success and opens the captured source", async () => {
    await import("./popup");

    await vi.waitFor(() => expect(document.getElementById("save-selection")).not.toBeNull());
    (document.getElementById("save-selection") as HTMLButtonElement).click();

    const open = await vi.waitFor(() => {
      const button = document.getElementById("open-source") as HTMLButtonElement | null;
      expect(button).toBeTruthy();
      return button as HTMLButtonElement;
    });

    open.click();

    await vi.waitFor(() =>
      expect(h.openCapturedSource).toHaveBeenCalledWith("src-1", { activate: true }),
    );
    await vi.waitFor(() => expect(open.textContent).toBe("Opened in Interleave"));
  });

  it("renders duplicate captures as already saved", async () => {
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

    await vi.waitFor(() => expect(document.getElementById("save-selection")).not.toBeNull());
    (document.getElementById("save-page") as HTMLButtonElement).click();

    await vi.waitFor(() =>
      expect(document.querySelector(".done-title")?.textContent).toContain("Already saved"),
    );
    (document.getElementById("open-source") as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(h.openCapturedSource).toHaveBeenCalledWith("existing-1", { activate: true }),
    );
  });

  it("renders not-paired and opens the options page", async () => {
    h.readPairedConfig.mockResolvedValue({ token: null, port: 47615 });
    await import("./popup");

    await vi.waitFor(() =>
      expect(document.getElementById("connection-pill")?.textContent).toContain("Not paired"),
    );
    expect(document.body.textContent).toContain("Extension not paired");

    (document.getElementById("pair-options") as HTMLButtonElement).click();
    expect(openOptionsPage).toHaveBeenCalledOnce();
  });

  it("renders app-offline state and can retry the connection", async () => {
    h.pingApp.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await import("./popup");

    await vi.waitFor(() =>
      expect(document.getElementById("connection-pill")?.textContent).toContain("App offline"),
    );

    (document.getElementById("retry-connection") as HTMLButtonElement).click();

    await vi.waitFor(() =>
      expect(document.getElementById("connection-pill")?.textContent).toContain("Connected"),
    );
  });

  it("renders app-offline state when the app disappears during save", async () => {
    sendMessage.mockImplementation((_message, cb) => {
      cb({ kind: "not-running" });
    });
    await import("./popup");
    await vi.waitFor(() => expect(document.getElementById("save-selection")).not.toBeNull());

    (document.getElementById("save-selection") as HTMLButtonElement).click();

    await vi.waitFor(() =>
      expect(document.getElementById("connection-pill")?.textContent).toContain("App offline"),
    );
    expect(document.body.textContent).toContain("Interleave is not reachable");
  });

  it("maps a bad token save outcome to the unpaired setup state", async () => {
    sendMessage.mockImplementation((_message, cb) => {
      cb({ kind: "bad-token" });
    });
    await import("./popup");
    await vi.waitFor(() => expect(document.getElementById("save-selection")).not.toBeNull());

    (document.getElementById("save-selection") as HTMLButtonElement).click();

    await vi.waitFor(() =>
      expect(document.getElementById("connection-pill")?.textContent).toContain("Not paired"),
    );
    expect(document.body.textContent).toContain("Extension not paired");
  });

  it("renders open-source failures without leaving the button disabled", async () => {
    h.openCapturedSource.mockResolvedValueOnce({ kind: "bad-token" });
    await import("./popup");
    await vi.waitFor(() => expect(document.getElementById("save-selection")).not.toBeNull());

    (document.getElementById("save-selection") as HTMLButtonElement).click();
    const open = await vi.waitFor(() => {
      const button = document.getElementById("open-source") as HTMLButtonElement | null;
      expect(button).toBeTruthy();
      return button as HTMLButtonElement;
    });

    open.click();

    await vi.waitFor(() =>
      expect(document.getElementById("save-result")?.textContent).toContain("Bad token"),
    );
    expect(open.disabled).toBe(false);
    expect(open.textContent).toContain("Open in Interleave");
  });

  it("ignores stale open-source results after the saved view is dismissed", async () => {
    let resolveOpen: ((outcome: OpenSourceOutcome) => void) | undefined;
    h.openCapturedSource.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOpen = resolve;
        }),
    );
    await import("./popup");
    await vi.waitFor(() => expect(document.getElementById("save-selection")).not.toBeNull());

    (document.getElementById("save-selection") as HTMLButtonElement).click();
    const open = await vi.waitFor(() => {
      const button = document.getElementById("open-source") as HTMLButtonElement | null;
      expect(button).toBeTruthy();
      return button as HTMLButtonElement;
    });
    open.click();
    (document.getElementById("save-another") as HTMLButtonElement).click();

    resolveOpen?.({ kind: "bad-token" });

    await vi.waitFor(() => expect(document.getElementById("save-selection")).not.toBeNull());
    expect(document.getElementById("save-result")?.textContent).not.toContain("Bad token");
  });

  it("opens the options page from the footer", async () => {
    await import("./popup");

    (document.getElementById("open-options") as HTMLButtonElement).click();

    expect(openOptionsPage).toHaveBeenCalledOnce();
  });
});
