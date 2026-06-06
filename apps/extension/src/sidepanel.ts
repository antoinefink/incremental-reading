/**
 * Side Panel capture surface (T063).
 *
 * BROWSER BOUNDARY: this runs in Chrome's Side Panel, NOT the Electron renderer.
 * It is DESIGN-LANGUAGE reuse, not renderer-component reuse — it must NOT import
 * `apps/web`, `@interleave/core`, `@interleave/local-db`, or `window.appApi`. It
 * reuses only the visual design system (the OKLCH tokens + A/B/C/D priority colors
 * re-declared in `tokens.css`) and the zod-only `@interleave/capture-contract`
 * (via `./shared`). Captures travel over the SAME token-protected `127.0.0.1`
 * loopback path the popup uses — there is NO new network surface, NO new endpoint,
 * NO direct DB write.
 *
 * The panel is a richer capture surface than the popup: it shows the active tab +
 * the current selection, lets the user pick a PRIORITY (A/B/C/D, default C) and
 * type a short REASON ("why this matters"), and saves the selection (or the whole
 * page) through the background worker's `/capture` POST. It also renders a bounded
 * RECENT-CAPTURES list that the background worker maintains in `chrome.storage`
 * (the panel subscribes to `chrome.storage.onChanged` — it does NOT read any
 * loopback endpoint; a live inbox-read endpoint is intentionally out of scope).
 */

import type { CaptureOutcome } from "./shared";
import { type RecentCapture, STORAGE_KEYS } from "./shared";

type Priority = "A" | "B" | "C" | "D";

/** Per-priority cadence hint mirrors the kit inbox priority chip group. */
const PRIORITY_HINT: Readonly<Record<Priority, string>> = {
  A: "Protected · high value",
  B: "Important · useful",
  C: "Normal cadence",
  D: "Someday · low / background",
};

// --- DOM handles ------------------------------------------------------------

const tabTitleEl = document.getElementById("tab-title") as HTMLDivElement;
const tabUrlEl = document.getElementById("tab-url") as HTMLDivElement;
const selectionEl = document.getElementById("selection-text") as HTMLDivElement;
const useSelectionBtn = document.getElementById("use-selection") as HTMLButtonElement;
const reasonEl = document.getElementById("reason") as HTMLTextAreaElement;
const prioGroupEl = document.getElementById("prio-group") as HTMLDivElement;
const prioHintEl = document.getElementById("prio-hint") as HTMLSpanElement;
const saveSelectionBtn = document.getElementById("save-selection") as HTMLButtonElement;
const savePageBtn = document.getElementById("save-page") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLDivElement;
const recentEl = document.getElementById("recent-list") as HTMLDivElement;
const openOptionsEl = document.getElementById("open-options") as HTMLButtonElement;

// --- panel state ------------------------------------------------------------

let priority: Priority = "C";
/** The selection the user pulled (panels do not auto-track live selections). */
let currentSelection = "";

// --- priority chips ---------------------------------------------------------

function renderPriority(): void {
  for (const chip of prioGroupEl.querySelectorAll<HTMLButtonElement>(".prio")) {
    const value = chip.dataset.prio as Priority;
    chip.setAttribute("aria-pressed", String(value === priority));
  }
  prioHintEl.textContent = PRIORITY_HINT[priority];
}

prioGroupEl.addEventListener("click", (event) => {
  const target = (event.target as HTMLElement).closest<HTMLButtonElement>(".prio");
  if (!target) return;
  priority = target.dataset.prio as Priority;
  renderPriority();
});

// --- active tab + selection -------------------------------------------------

async function activeTab(): Promise<chrome.tabs.Tab | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ?? null;
}

async function refreshTab(): Promise<void> {
  const tab = await activeTab();
  tabTitleEl.textContent = tab?.title ?? tab?.url ?? "No active tab";
  tabUrlEl.textContent = tab?.url ?? "";
}

/** Pull the current selection from the active tab on demand (no live tracking). */
async function pullSelection(): Promise<void> {
  const tab = await activeTab();
  if (!tab?.id) {
    setSelection("");
    return;
  }
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => window.getSelection()?.toString() ?? "",
    });
    setSelection(typeof result?.result === "string" ? result.result : "");
  } catch {
    setSelection("");
  }
}

function setSelection(text: string): void {
  currentSelection = text.trim();
  if (currentSelection.length > 0) {
    selectionEl.textContent = currentSelection;
    selectionEl.classList.remove("empty");
    saveSelectionBtn.disabled = false;
  } else {
    selectionEl.textContent =
      "No text selected — select on the page, then “Use current selection”.";
    selectionEl.classList.add("empty");
    saveSelectionBtn.disabled = true;
  }
}

// --- save flows (through the SAME background-worker POST path as the popup) --

function setStatus(outcome: CaptureOutcome | { kind: "pending" }): void {
  statusEl.hidden = false;
  statusEl.className = "status";
  let text: string;
  switch (outcome.kind) {
    case "pending":
      text = "Capturing…";
      break;
    case "ok":
      statusEl.classList.add("ok");
      text = outcome.response.deduped
        ? `Already saved: ${outcome.response.title}`
        : `Saved: ${outcome.response.title}`;
      break;
    case "not-paired":
      statusEl.classList.add("warn");
      text = "Not paired — open Options and paste the token.";
      break;
    case "bad-token":
      statusEl.classList.add("warn");
      text = "Bad token — re-pair in Options.";
      break;
    case "not-running":
      statusEl.classList.add("err");
      text = "Interleave app is not running / capture disabled.";
      break;
    default:
      statusEl.classList.add("err");
      text = outcome.message;
  }
  statusEl.textContent = text;
}

/** Build a save message + dispatch it to the background worker; render outcome. */
function dispatchSave(type: "save-page" | "save-selection"): void {
  setStatus({ kind: "pending" });
  const reason = reasonEl.value.trim();
  const message: {
    type: "save-page" | "save-selection";
    priority: Priority;
    reason?: string;
    selection?: string;
  } = {
    type,
    priority,
    ...(reason ? { reason } : {}),
    ...(type === "save-selection" && currentSelection ? { selection: currentSelection } : {}),
  };
  chrome.runtime.sendMessage(message, (outcome: CaptureOutcome) => {
    if (chrome.runtime.lastError) {
      setStatus({ kind: "error", message: chrome.runtime.lastError.message ?? "Failed" });
      return;
    }
    setStatus(outcome);
  });
}

// --- recent captures (subscribe to chrome.storage; no loopback read) --------

function renderRecent(list: readonly RecentCapture[]): void {
  recentEl.innerHTML = "";
  if (list.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No captures yet.";
    recentEl.appendChild(empty);
    return;
  }
  for (const entry of list) {
    const row = document.createElement("div");
    row.className = "recent-row";

    const kind = document.createElement("span");
    kind.className = `recent-kind recent-kind--${entry.kind}`;
    kind.textContent = entry.kind === "page" ? "Page" : "Selection";

    const title = document.createElement("span");
    title.className = "recent-title";
    title.textContent = entry.title || "(untitled)";
    title.title = entry.title;

    const when = document.createElement("span");
    when.className = "recent-when";
    when.textContent = relativeTime(entry.timestamp);

    row.append(kind, title, when);
    recentEl.appendChild(row);
  }
}

function relativeTime(ts: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

async function loadRecent(): Promise<void> {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.recentCaptures);
  const list = Array.isArray(stored[STORAGE_KEYS.recentCaptures])
    ? (stored[STORAGE_KEYS.recentCaptures] as RecentCapture[])
    : [];
  renderRecent(list);
}

// Live-update the recent list as the worker appends on each successful capture.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  const change = changes[STORAGE_KEYS.recentCaptures];
  if (!change) return;
  const next = Array.isArray(change.newValue) ? (change.newValue as RecentCapture[]) : [];
  renderRecent(next);
});

// --- wiring -----------------------------------------------------------------

useSelectionBtn.addEventListener("click", () => void pullSelection());
saveSelectionBtn.addEventListener("click", () => dispatchSave("save-selection"));
savePageBtn.addEventListener("click", () => dispatchSave("save-page"));
openOptionsEl.addEventListener("click", () => void chrome.runtime.openOptionsPage());

// A pinned selection belongs to the tab it was pulled from. If the user switches
// tabs — or the active tab navigates — invalidate it and refresh the header, so a
// save can never send tab A's text against tab B's source (a lineage mismatch).
async function invalidateSelectionAndRefresh(): Promise<void> {
  setSelection("");
  await refreshTab();
}

chrome.tabs.onActivated.addListener(() => void invalidateSelectionAndRefresh());
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.url && tab.active) void invalidateSelectionAndRefresh();
});

async function init(): Promise<void> {
  renderPriority();
  setSelection("");
  await Promise.all([refreshTab(), pullSelection(), loadRecent()]);
}

void init();
