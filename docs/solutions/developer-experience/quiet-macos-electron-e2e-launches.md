---
title: Quiet macOS Electron E2E launches
date: 2026-06-08
category: docs/solutions/developer-experience
module: Electron E2E harness
problem_type: developer_experience
component: testing_framework
severity: medium
applies_when:
  - "Playwright launches the real Electron app repeatedly during a local macOS test run."
  - "The app should remain automation-usable without interrupting the user's desktop."
tags: [electron, playwright, e2e, macos, dock]
---

# Quiet macOS Electron E2E launches

## Context

The Electron Playwright suite launches many short-lived desktop app processes. On macOS, a normal Electron launch can register a Dock icon and show/focus a `BrowserWindow`, so a full `pnpm e2e` run can interrupt the developer's desktop even though the tests are automated.

## Guidance

Use an explicit E2E environment flag from the centralized Electron launch helper, then consume it only in the unpackaged macOS main process.

Apply the macOS activation policy as early as possible, before `app.whenReady()`, so Electron starts as an accessory app instead of briefly appearing as a regular Dock app. Hide the Dock again after ready as a belt-and-suspenders step. Keep production packaged launches immune to the flag.

```ts
const isQuietE2e =
  !app.isPackaged && process.platform === "darwin" && process.env.INTERLEAVE_E2E_QUIET === "1";

if (isQuietE2e) {
  app.setActivationPolicy?.("accessory");
}

app.whenReady().then(() => {
  if (isQuietE2e) app.dock?.hide?.();
  createMainWindow({ showOnReady: !isQuietE2e });
});
```

Keep `BrowserWindow({ show: false })` as the base window option and gate only the `ready-to-show` call to `win.show()`. Do not disable painting for hidden windows; Playwright still needs the renderer to load and be automatable.

Also quiet explicit foregrounding paths that tests can trigger, such as second-instance handling or loopback capture `openSource` flows. In quiet E2E they should still route, send IPC, or load URLs, but skip `restore()`, `show()`, and `focus()`.

## Why This Matters

This makes local E2E runs usable while preserving the value of real Electron coverage. The suite still tests the main process, preload bridge, SQLite-backed app data, and renderer behavior, but it no longer produces distracting Dock icons or windows that jump in front of the user.

The macOS platform gate matters. Hidden headed Electron can mask focus and visibility regressions on other platforms, and the original pain is macOS-specific Dock/window behavior.

## When to Apply

- Use this when a Playwright Electron suite launches the real app repeatedly on macOS.
- Use this when a test needs a real Electron app object but not a visible user-facing window.
- Avoid this for normal dev launches, packaged builds, or tests whose purpose is to validate visible app activation.

## Examples

Before:

```ts
win.once("ready-to-show", () => {
  win.show();
});
```

After:

```ts
if (showOnReady) {
  win.once("ready-to-show", () => {
    win.show();
  });
}
```

Regression coverage should include both mock-level and real Electron assertions:

- unit-test that `setActivationPolicy("accessory")` runs before `app.whenReady()`;
- unit-test that quiet mode is ignored for packaged and non-macOS launches;
- unit-test that quiet second-instance and capture-open paths do not call `show()` or `focus()`;
- Electron E2E-test that the window remains hidden, the Dock is hidden on macOS, and the hidden renderer can still be clicked or typed into by Playwright.

## Related

- [Run automatic rolling backups in Electron main, not the renderer](../architecture-patterns/electron-main-rolling-backups-over-renderer-reminders.md)
- [Open app-managed folders through pathless Electron IPC](../architecture-patterns/pathless-backups-open-folder-ipc.md)
