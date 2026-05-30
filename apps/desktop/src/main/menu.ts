/**
 * Native application menu (T048) — the macOS app menu skeleton.
 *
 * Installs the standard macOS menu so the packaged app feels native and the
 * editor's clipboard chords work (Edit → Cut/Copy/Paste/Select-All are the system
 * roles the contenteditable reader/card builder rely on). The keyboard-first
 * surface lives in the renderer (the single shortcut registry + `useShellShortcuts`);
 * this menu adds the OS-level affordances and a Help → "Keyboard shortcuts" (⌘/)
 * item that messages the renderer to open the in-app cheat sheet — so the cheat
 * sheet is reachable from the menu bar too.
 *
 * The "Keyboard shortcuts" item is a one-way main → renderer send
 * (`menu:showShortcuts`); the renderer subscribes via the narrow
 * `window.appApi.menu.onShowShortcuts` bridge. No trusted capability leaks: the
 * menu only sends a payload-free signal. The richer macOS polish (File → Back up…,
 * app icon/productName) lands with T050.
 */

import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from "electron";
import { IPC_CHANNELS } from "../shared/channels";

/** Send a payload-free signal to the focused renderer over the given channel. */
function sendToRenderer(channel: string): void {
  const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
  target?.webContents.send(channel);
}

/** Tell the focused renderer to open the in-app cheat sheet. */
function sendShowShortcuts(): void {
  sendToRenderer(IPC_CHANNELS.menuShowShortcuts);
}

/** Tell the focused renderer to run a backup (same command as ⌘B / the palette). */
function sendCreateBackup(): void {
  sendToRenderer(IPC_CHANNELS.menuCreateBackup);
}

/**
 * Build + install the application menu. On macOS this is the global menu bar; on
 * other platforms it is the window menu (the MVP targets macOS, but the structure
 * is portable). Call once after `app.whenReady()`.
 */
export function installApplicationMenu(): void {
  const isMac = process.platform === "darwin";
  const appName = app.name || "Interleave";

  const template: MenuItemConstructorOptions[] = [];

  // macOS app menu (About / Hide / Quit live here on darwin).
  if (isMac) {
    template.push({
      label: appName,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    });
  }

  // File — the macOS polish (T050): a "Back up…" item (⌘B) that asks the renderer
  // to run the SAME backup command as the in-app prompt + ⌘K palette, plus Close.
  template.push({
    label: "File",
    submenu: [
      {
        label: "Back up…",
        accelerator: "CmdOrCtrl+B",
        click: () => sendCreateBackup(),
      },
      { type: "separator" },
      isMac ? { role: "close" } : { role: "quit" },
    ],
  });

  // Edit — the clipboard roles the contenteditable editor needs (T048: editor
  // chords keep working) + undo/redo (native field-level; the app's command-level
  // ⌘Z lives in the renderer's shell handler).
  template.push({
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "selectAll" },
    ],
  });

  // View — reload (dev convenience) + zoom + devtools.
  template.push({
    label: "View",
    submenu: [
      { role: "reload" },
      { role: "toggleDevTools" },
      { type: "separator" },
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      { type: "separator" },
      { role: "togglefullscreen" },
    ],
  });

  // Window.
  template.push({
    label: "Window",
    submenu: isMac
      ? [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "front" }]
      : [{ role: "minimize" }, { role: "close" }],
  });

  // Help — the keyboard-shortcuts entry (⌘/), wired to the in-app cheat sheet.
  template.push({
    role: "help",
    submenu: [
      {
        label: "Keyboard shortcuts",
        accelerator: "CmdOrCtrl+/",
        click: () => sendShowShortcuts(),
      },
    ],
  });

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
