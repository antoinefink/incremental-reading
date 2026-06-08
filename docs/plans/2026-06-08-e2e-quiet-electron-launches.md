---
title: Quiet Electron Launches For Local E2E
status: completed
date: 2026-06-08
origin: user request
execution: code
---

# Quiet Electron Launches For Local E2E

## Problem

Running `pnpm e2e` locally on macOS launches many Electron application instances. Each instance currently shows in the Dock and each BrowserWindow is shown on `ready-to-show`, which interrupts the user and creates Dock spam during the Electron Playwright suite.

## Scope

In scope:
- Local Electron Playwright launches from `tests/electron/launch.ts`.
- macOS Dock visibility and activation behavior during E2E.
- Main-window visibility during automated test launches.
- Unit tests proving the quiet-mode branching.
- A targeted Electron E2E assertion proving test launches use quiet mode.

Out of scope:
- CI display infrastructure such as Xvfb.
- Production packaged app behavior.
- Renderer-only Chromium E2E behavior.
- Rewriting the E2E suite lifecycle or batching specs.

## Requirements

- `pnpm e2e` local Electron launches on macOS must not show repeated Dock icons.
- Electron test windows must not pop in front of the user during normal E2E runs.
- Production and normal dev launches must still show the app window and Dock icon.
- Tests that need to inspect a page must still be able to use Playwright against the hidden window.
- Capture/open-source flows must still be able to surface a window when they are invoked as user-facing behavior.

## Existing Patterns

- `tests/electron/launch.ts` already centralizes all `_electron.launch` calls and injects E2E-only environment variables.
- `apps/desktop/src/main/index.ts` already gates dev/E2E conveniences through explicit `INTERLEAVE_*` environment variables.
- `apps/desktop/src/main/window.ts` already creates the BrowserWindow with `show: false`, then calls `show()` on `ready-to-show`.
- `apps/desktop/src/main/index.test.ts` mocks Electron main-process APIs and is the right place to test app activation policy / Dock branching.
- `apps/desktop/src/main/window.test.ts` currently focuses on pure navigation decisions; add pure window-visibility helpers rather than trying to instantiate real Electron in Vitest.

## Decisions

1. Add an explicit `INTERLEAVE_E2E_QUIET=1` environment flag in `tests/electron/launch.ts`.
   Rationale: the renderer and main process can make test-only choices without guessing from `NODE_ENV=production`, `INTERLEAVE_DATA_DIR`, or Playwright internals.

2. In main startup, treat quiet mode as unpackaged-only.
   Rationale: a shipped app must never become hidden because a user environment variable leaked in. This mirrors existing unpackaged-only handling for loopback import escapes.

3. On macOS quiet mode, hide the Dock icon / use accessory activation policy before bootstrap opens windows.
   Rationale: Dock spam is an application-level concern, not a BrowserWindow concern.

4. In quiet mode, create the main BrowserWindow but do not call `show()` on `ready-to-show`.
   Rationale: Playwright can drive hidden Electron windows through `_electron`; suppressing window display avoids foreground interruption while preserving app behavior for tests.

5. Keep explicit foreground operations foregrounded.
   Rationale: if app code calls `focusWindow` for a capture/open-source path, that is a behavior under test and should still call `show()` / `focus()`.

## Implementation Units

### U1: Add Quiet-Mode Launch Contract

Files:
- Modify: `tests/electron/launch.ts`

Approach:
- Add `INTERLEAVE_E2E_QUIET=1` to the environment passed to `_electron.launch`.
- Keep existing launch defaults unchanged otherwise.

Test scenarios:
- Covered indirectly by U3 and Electron E2E.

Verification:
- Electron E2E can observe the flag through main-process behavior.

### U2: Main-Process Quiet Mode

Files:
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/src/main/window.ts`
- Modify: `apps/desktop/src/main/index.test.ts`
- Modify: `apps/desktop/src/main/window.test.ts`

Approach:
- Add small pure helpers for resolving quiet-E2E mode and whether a window should auto-show.
- Add an optional `showOnReady`/equivalent flag to `createMainWindow`; default true.
- Pass false only when quiet mode is enabled.
- Add a macOS app-presentation helper that calls `app.dock.hide()` and, where available, `app.setActivationPolicy("accessory")` during quiet mode; otherwise keep installing the Dock icon.
- Preserve normal dev/production behavior by default.

Test scenarios:
- macOS normal dev launch still installs the Dock icon.
- macOS quiet E2E launch hides Dock / sets accessory activation and does not set the icon.
- quiet mode is ignored for packaged apps.
- `createMainWindow` does not register a `ready-to-show` show callback when `showOnReady` is false.
- `createMainWindow` defaults to showing on `ready-to-show`.

Verification:
- `pnpm test -- apps/desktop/src/main/index.test.ts apps/desktop/src/main/window.test.ts`

### U3: E2E Regression Assertion

Files:
- Modify: `tests/electron/desktop.spec.ts`

Approach:
- Add or extend a desktop spec to evaluate main-process state for the first window and app presentation policy in E2E.
- Assert the launched window is not visible by default under the harness.
- On macOS, assert the Dock is hidden where Electron exposes that state, or assert the main-process quiet-mode flag/presentation branch via a small exposed test helper if direct state is unavailable.

Test scenarios:
- Electron project launch yields a usable page while the BrowserWindow remains hidden.
- The assertion is cross-platform safe; macOS-only checks must be gated by `process.platform`.

Verification:
- `pnpm e2e --project=electron tests/electron/desktop.spec.ts`

## Verification Plan

- `pnpm typecheck`
- `pnpm test -- apps/desktop/src/main/index.test.ts apps/desktop/src/main/window.test.ts`
- `pnpm e2e --project=electron tests/electron/desktop.spec.ts`
- If time permits, `pnpm e2e --project=electron` to confirm the broader suite still launches quietly.

## Risks

- Some Electron APIs vary by version. Keep the app-presentation helper defensive around `dock` and `setActivationPolicy`.
- Hidden windows may behave differently for tests that depend on focus. If a spec requires visible focus, add an explicit test option later rather than making all launches visible again.
- macOS Dock hiding is process-level and should be applied before window creation.
