// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type OpenSourceOutcome, STORAGE_KEYS } from "./shared";

const sendMessage = vi.fn();
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

let storageListener:
  | ((changes: Record<string, { newValue?: unknown }>, area: "local" | "sync") => void)
  | undefined;

function installDom() {
  document.body.innerHTML = `
    <div id="tab-title"></div>
    <div id="tab-url"></div>
    <div id="selection-text"></div>
    <button id="use-selection"></button>
    <textarea id="reason"></textarea>
    <div id="prio-group">
      <button class="prio" data-prio="A"></button>
      <button class="prio" data-prio="B"></button>
      <button class="prio" data-prio="C"></button>
      <button class="prio" data-prio="D"></button>
    </div>
    <span id="prio-hint"></span>
    <button id="save-selection"></button>
    <button id="save-page"></button>
    <div id="status" hidden></div>
    <div id="recent-list"></div>
    <button id="open-options"></button>
  `;
}

function installChromeMock() {
  storageListener = undefined;
  vi.stubGlobal("chrome", {
    tabs: {
      query: vi.fn(async () => [{ id: 8, title: "Panel tab", url: "https://example.com/panel" }]),
      onActivated: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn() },
    },
    scripting: {
      executeScript: vi.fn(async () => [{ result: "Selected text" }]),
    },
    runtime: {
      lastError: null,
      sendMessage,
      openOptionsPage: vi.fn(),
    },
    storage: {
      local: {
        get: vi.fn(async () => ({
          [STORAGE_KEYS.recentCaptures]: [
            { id: "old-1", title: "Old capture", kind: "page", timestamp: Date.now() },
          ],
        })),
      },
      onChanged: {
        addListener: vi.fn((fn) => {
          storageListener = fn;
        }),
      },
    },
  });
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  installDom();
  installChromeMock();
  h.openCapturedSource.mockResolvedValue({ kind: "ok", sourceId: "src-panel" });
  sendMessage.mockImplementation((_message, cb) => {
    cb({
      kind: "ok",
      response: {
        ok: true,
        id: "src-panel",
        kind: "selection",
        title: "Saved from panel",
        deduped: false,
      },
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("extension side panel", () => {
  it("loads tab metadata, pulled selection, priority hint, and recent captures", async () => {
    await import("./sidepanel");

    await vi.waitFor(() =>
      expect(document.getElementById("tab-title")?.textContent).toContain("Panel tab"),
    );
    expect(document.getElementById("selection-text")?.textContent).toContain("Selected text");
    expect((document.getElementById("save-selection") as HTMLButtonElement).disabled).toBe(false);
    expect(document.getElementById("prio-hint")?.textContent).toContain("Normal cadence");
    expect(document.getElementById("recent-list")?.textContent).toContain("Old capture");
  });

  it("sends priority, reason, and pinned selection through the background worker", async () => {
    await import("./sidepanel");
    await vi.waitFor(() =>
      expect(document.getElementById("selection-text")?.textContent).toContain("Selected text"),
    );

    (document.querySelector("[data-prio='A']") as HTMLButtonElement).click();
    (document.getElementById("reason") as HTMLTextAreaElement).value = "This matters";
    (document.getElementById("save-selection") as HTMLButtonElement).click();

    expect(sendMessage).toHaveBeenCalledWith(
      {
        type: "save-selection",
        priority: "A",
        reason: "This matters",
        selection: "Selected text",
      },
      expect.any(Function),
    );
    await vi.waitFor(() =>
      expect(document.getElementById("status")?.textContent).toContain("Saved from panel"),
    );
    expect(document.getElementById("status")?.className).toBe("status ok");
  });

  it("renders an open action in successful capture status and opens that source", async () => {
    await import("./sidepanel");
    await vi.waitFor(() =>
      expect(document.getElementById("selection-text")?.textContent).toContain("Selected text"),
    );

    (document.getElementById("save-selection") as HTMLButtonElement).click();
    const open = await vi.waitFor(() => {
      const button = document.querySelector<HTMLButtonElement>("#status button.status-action");
      expect(button).toBeTruthy();
      return button as HTMLButtonElement;
    });

    open.click();

    await vi.waitFor(() =>
      expect(h.openCapturedSource).toHaveBeenCalledWith("src-panel", { activate: true }),
    );
    await vi.waitFor(() =>
      expect(document.getElementById("status")?.textContent).toContain("Opened in Interleave"),
    );
    expect(document.getElementById("status")?.className).toBe("status ok");
  });

  it("opens the existing id returned by a deduped capture", async () => {
    sendMessage.mockImplementation((_message, cb) => {
      cb({
        kind: "ok",
        response: {
          ok: true,
          id: "existing-panel",
          kind: "page",
          title: "Saved from panel",
          deduped: true,
        },
      });
    });
    await import("./sidepanel");

    (document.getElementById("save-page") as HTMLButtonElement).click();

    await vi.waitFor(() =>
      expect(document.getElementById("status")?.textContent).toContain("Already saved"),
    );
    const open = document.querySelector<HTMLButtonElement>("#status button.status-action");
    expect(open).toBeTruthy();
    open?.click();

    await vi.waitFor(() =>
      expect(h.openCapturedSource).toHaveBeenCalledWith("existing-panel", { activate: true }),
    );
  });

  it("live-updates recent captures from storage changes", async () => {
    await import("./sidepanel");
    await vi.waitFor(() => expect(storageListener).toBeTypeOf("function"));

    storageListener?.(
      {
        [STORAGE_KEYS.recentCaptures]: {
          newValue: [
            { id: "new-1", title: "New capture", kind: "selection", timestamp: Date.now() },
          ],
        },
      },
      "local",
    );

    expect(document.getElementById("recent-list")?.textContent).toContain("New capture");
  });

  it("opens recent capture rows and renders existing not-running error state", async () => {
    h.openCapturedSource.mockResolvedValueOnce({ kind: "not-running" });
    await import("./sidepanel");

    const open = await vi.waitFor(() => {
      const button = document.querySelector<HTMLButtonElement>("#recent-list .recent-open");
      expect(button).toBeTruthy();
      return button as HTMLButtonElement;
    });
    open.click();

    await vi.waitFor(() =>
      expect(h.openCapturedSource).toHaveBeenCalledWith("old-1", { activate: true }),
    );
    await vi.waitFor(() =>
      expect(document.getElementById("status")?.textContent).toContain("not running"),
    );
    expect(document.getElementById("status")?.className).toBe("status err");
  });
});
