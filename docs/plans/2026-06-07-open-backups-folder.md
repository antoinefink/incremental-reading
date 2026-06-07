---
title: Open Backups Folder From Settings
type: feat
status: completed
date: 2026-06-07
---

# Open Backups Folder From Settings

## Summary

Add a secondary Settings action that opens the managed local `backups/` directory in Finder through a fixed Electron IPC command.

## Problem Frame

Users can create backup ZIPs from Settings, but the UI does not help them find the folder afterward. This matters because local backups still need to be copied off-device manually.

## Requirements

- R1. The Settings `Data & backup` section exposes an "Open backups folder" button beside the existing manual backup action.
- R2. The renderer never supplies or receives an arbitrary filesystem path for this action.
- R3. Electron main opens the canonical `context.paths.backupsDir` with a fixed, payload-free backup command.
- R4. Help copy no longer claims there is no Finder reveal button for backups.
- R5. Focused tests cover the contract, preload wiring, main handler, renderer wrapper, and Settings click behavior.

## Key Technical Decisions

- **Use a backup-specific command:** Add `backups.openFolder()` rather than a generic `files.open(path)` API so the renderer cannot choose filesystem targets.
- **Use `shell.openPath`:** Open `context.paths.backupsDir` from Electron main; report an error when Electron returns a non-empty failure string.
- **Keep the Settings action secondary:** Use the neutral bordered button style and a folder/external-style icon so "Back up now" remains the primary action.

## Scope Boundaries

- Do not implement restore.
- Do not reveal a specific backup archive.
- Do not add a generic filesystem opener or expose the app data directory.
- Do not change backup creation format or retention behavior.

## Implementation Units

### U1. Backup Folder IPC

- **Goal:** Add a fixed `backups.openFolder()` bridge command from contract to main handler.
- **Files:** `apps/desktop/src/shared/channels.ts`, `apps/desktop/src/shared/contract.ts`, `apps/desktop/src/preload/index.ts`, `apps/desktop/src/main/ipc.ts`, `apps/web/src/lib/appApi.ts`.
- **Patterns:** Mirror `backups.create()` for channel grouping, schema placement, preload wiring, and renderer wrapper naming.
- **Test Scenarios:** Schema accepts `undefined` and rejects payloads; preload invokes the fixed channel without payload; main handler uses `context.paths.backupsDir`, returns success, throws without filesystem context, and throws when Electron reports an open error; renderer wrapper forwards to `window.appApi.backups.openFolder()`.
- **Verification:** Focused Vitest tests for shared contract/channels, preload, main IPC, and renderer app API pass.

### U2. Settings Button And Copy

- **Goal:** Render and wire the "Open backups folder" Settings button, and update help text that previously said this was unavailable.
- **Files:** `apps/web/src/pages/Settings.tsx`, `apps/web/src/pages/Settings.test.tsx`, `apps/web/src/help/help-bodies.ts`.
- **Patterns:** Use the existing `SettingRow` and neutral secondary button style in `Data & backup`.
- **Test Scenarios:** Button renders in desktop Settings; clicking it calls the app API once; failures render the existing backup error surface or a specific folder-open error without blocking backup creation.
- **Verification:** Settings tests pass and the UI remains inside the existing Data & backup section rhythm.

## Sources

- `docs/tasks/M9-safety-analytics-backup.md` notes that a Finder reveal affordance should be a separate `shell.openPath` command.
- `apps/desktop/src/main/paths.ts` defines `backupsDir` as the canonical managed backup folder.
- `apps/web/src/pages/Settings.tsx` already owns the manual backup UI.
