/**
 * Action popup (T062).
 *
 * BROWSER BOUNDARY: runs in Chrome, styled with the re-declared design tokens.
 * It dispatches save messages to the background worker (which holds the loopback
 * client) and renders the worker's normalized outcome. "Save to inbox" is a page
 * save (the whole page into the inbox) — the richer priority+reason capture is
 * the side panel (T063).
 */

import type { CaptureOutcome, OpenSourceOutcome } from "./shared";
import { openCapturedSource } from "./shared";

const titleEl = document.getElementById("page-title") as HTMLParagraphElement;
const resultEl = document.getElementById("result") as HTMLDivElement;

async function init(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  titleEl.textContent = tab?.title ?? tab?.url ?? "Current tab";
}

function render(outcome: CaptureOutcome): void {
  resultEl.innerHTML = "";
  const el = document.createElement("span");
  switch (outcome.kind) {
    case "ok":
      el.className = "status ok";
      el.textContent = outcome.response.deduped
        ? `Already saved: ${outcome.response.title}`
        : `Saved: ${outcome.response.title}`;
      resultEl.appendChild(el);
      resultEl.appendChild(openButton(outcome.response.id));
      return;
    case "not-paired":
      el.className = "status warn";
      el.textContent = "Not paired — open Options";
      break;
    case "bad-token":
      el.className = "status warn";
      el.textContent = "Bad token — re-pair in Options";
      break;
    case "not-running":
      el.className = "status err";
      el.textContent = "App not running";
      break;
    default:
      el.className = "status err";
      el.textContent = outcome.message;
  }
  resultEl.appendChild(el);
}

function openButton(sourceId: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "status-action";
  button.textContent = "Open in Interleave";
  button.addEventListener("click", () => {
    void openSourceFromButton(sourceId, button);
  });
  return button;
}

async function openSourceFromButton(sourceId: string, button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  button.textContent = "Opening…";
  const outcome = await openCapturedSource(sourceId, { activate: true });
  renderOpenOutcome(outcome, button);
}

function renderOpenOutcome(outcome: OpenSourceOutcome, button: HTMLButtonElement): void {
  if (outcome.kind === "ok") {
    button.textContent = "Opened in Interleave";
    return;
  }
  button.disabled = false;
  button.textContent = "Open in Interleave";

  let status = resultEl.querySelector<HTMLSpanElement>(".open-status");
  if (!status) {
    status = document.createElement("span");
    resultEl.appendChild(status);
  }

  switch (outcome.kind) {
    case "not-paired":
      status.className = "status warn open-status";
      status.textContent = "Not paired — open Options";
      break;
    case "bad-token":
      status.className = "status warn open-status";
      status.textContent = "Bad token — re-pair in Options";
      break;
    case "not-running":
      status.className = "status err open-status";
      status.textContent = "App not running";
      break;
    default:
      status.className = "status err open-status";
      status.textContent = outcome.message;
  }
}

function send(type: "save-page" | "save-selection"): void {
  resultEl.textContent = "Capturing…";
  chrome.runtime.sendMessage({ type }, (outcome: CaptureOutcome) => {
    if (chrome.runtime.lastError) {
      render({ kind: "error", message: chrome.runtime.lastError.message ?? "Failed" });
      return;
    }
    render(outcome);
  });
}

document.getElementById("save-page")?.addEventListener("click", () => send("save-page"));
document.getElementById("save-inbox")?.addEventListener("click", () => send("save-page"));
document.getElementById("save-selection")?.addEventListener("click", () => send("save-selection"));
document.getElementById("open-options")?.addEventListener("click", () => {
  void chrome.runtime.openOptionsPage();
});
// Open the richer T063 capture panel (priority + reason) beside the page.
document.getElementById("open-panel")?.addEventListener("click", () => {
  void (async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id && chrome.sidePanel?.open) {
      await chrome.sidePanel.open({ tabId: tab.id });
      window.close();
    }
  })();
});

void init();
