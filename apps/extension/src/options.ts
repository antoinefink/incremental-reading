/**
 * Options / pairing page.
 *
 * BROWSER BOUNDARY: runs in Chrome, styled with the re-declared design tokens
 * (`tokens.css`) - NOT the renderer's React/Tailwind. The user pastes the token
 * shown in desktop Settings; "Save & test" pings the app, runs the pairing
 * handshake, and reports paired / not reachable / bad token.
 */

import {
  DEFAULT_CAPTURE_PORT,
  pairWithApp,
  pingApp,
  readPairedConfig,
  writePairedConfig,
} from "./shared";

type StatusKind = "ok" | "warn" | "err";
type ConnectionState = "off" | "testing" | "ok" | "err";

const tokenInput = document.getElementById("token") as HTMLInputElement;
const portInput = document.getElementById("port") as HTMLInputElement;
const saveButton = document.getElementById("save") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLSpanElement;
const connectionCard = document.getElementById("connection-card") as HTMLElement;
const connectionTitle = document.getElementById("connection-title") as HTMLSpanElement;
const connectionDetail = document.getElementById("connection-detail") as HTMLSpanElement;
const toggleToken = document.getElementById("toggle-token") as HTMLButtonElement;

function setStatus(kind: StatusKind, message: string): void {
  statusEl.hidden = false;
  statusEl.className = `status ${kind}`;
  statusEl.textContent = message;
}

function setConnection(state: ConnectionState, title: string, detail: string): void {
  connectionCard.className = `connection-card connection-card--${state}`;
  connectionTitle.textContent = title;
  connectionDetail.textContent = detail;
}

async function load(): Promise<void> {
  const { token, port } = await readPairedConfig();
  if (token) {
    tokenInput.value = token;
    setConnection(
      "off",
      "Token saved",
      "Test the connection to confirm the desktop app is reachable.",
    );
  }
  portInput.value = String(port || DEFAULT_CAPTURE_PORT);
}

async function saveAndTest(): Promise<void> {
  const token = tokenInput.value.trim();
  const port = Number(portInput.value) || DEFAULT_CAPTURE_PORT;
  if (!token) {
    setStatus("warn", "Paste the token from Settings first");
    setConnection("off", "Not connected", "Paste the token from Settings to pair this extension.");
    return;
  }
  await writePairedConfig(token, port);

  saveButton.disabled = true;
  setStatus("warn", "Testing...");
  setConnection("testing", "Testing connection", "Checking the local Interleave capture server.");
  const running = await pingApp(port);
  if (!running) {
    saveButton.disabled = false;
    setStatus("err", "App not reachable - is Interleave running with capture enabled?");
    setConnection(
      "err",
      "Interleave not reachable",
      "Open the desktop app and enable Browser capture in Settings.",
    );
    return;
  }
  const paired = await pairWithApp(token, port);
  saveButton.disabled = false;
  if (!paired) {
    setStatus("err", "Bad token - copy it again from Settings");
    setConnection("err", "Pairing failed", "The token did not match the desktop app.");
    return;
  }
  setStatus("ok", "Paired");
  setConnection("ok", "Connected", "This extension is paired with the local desktop app.");
}

function toggleTokenVisibility(): void {
  const isHidden = tokenInput.type === "password";
  tokenInput.type = isHidden ? "text" : "password";
  toggleToken.textContent = isHidden ? "Hide" : "Show";
  toggleToken.setAttribute("aria-label", isHidden ? "Hide token" : "Show token");
}

toggleToken.addEventListener("click", toggleTokenVisibility);
saveButton.addEventListener("click", () => void saveAndTest());
void load();
