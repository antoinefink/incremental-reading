---
title: "Open managed backup folders with pathless IPC"
date: "2026-06-07"
category: "docs/solutions/architecture-patterns/"
module: "desktop-backups"
problem_type: "architecture_pattern"
component: "service_object"
severity: "medium"
related_components:
  - "electron-main-ipc"
  - "preload-bridge"
  - "settings-ui"
  - "desktop-backups"
applies_when:
  - "A renderer needs to trigger a managed filesystem action without choosing a path."
  - "An Electron feature should open a known app-data folder while preserving main-process filesystem authority."
  - "A Settings affordance exposes local durability artifacts such as backup ZIPs."
  - "A generic file-opening IPC would widen the renderer filesystem surface unnecessarily."
tags:
  - "electron-main"
  - "ipc"
  - "backup-folder"
  - "filesystem-boundary"
  - "settings"
  - "local-first"
  - "renderer-boundary"
  - "pathless-command"
---

# Open managed backup folders with pathless IPC

## Context

Interleave needed a Settings action that opens the local `backups/` folder so users can copy backup ZIPs off-device. The tempting shortcut is a generic renderer command such as `openPath(path)`, but that would let untrusted UI code choose filesystem targets.

The durable pattern is a product-specific, payload-free IPC command. The renderer asks for the known workflow, and Electron main resolves the trusted path.

## Guidance

When adding a UI action that opens an app-managed local folder, define a narrow IPC capability for that exact action. Keep the request void unless the user workflow truly needs a constrained identifier, and resolve every absolute path in Electron main.

For the backups folder action, the shared contract is pathless:

```ts
export const BackupsOpenFolderRequestSchema = z.void();
```

The main handler validates that void request, uses `context.paths.backupsDir`, and calls Electron's shell API:

```ts
BackupsOpenFolderRequestSchema.parse(rawRequest);
const openError = await shell.openPath(context.paths.backupsDir);
```

The renderer wrapper stays payload-free:

```ts
openBackupsFolder(): Promise<BackupsOpenFolderResult> {
  return requireAppApi().backups.openFolder();
}
```

Do not add a generic filesystem opener. If another managed folder needs the same affordance, add another product-specific command such as `exports.openFolder()` so each capability remains reviewable.

## Why This Matters

This preserves Interleave's Electron security boundary. The renderer gets a useful desktop affordance without raw filesystem access, arbitrary path input, or a reusable escape hatch.

It also keeps tests crisp. The IPC tests can assert that `{ path: "/tmp" }` is rejected before `shell.openPath` is called, while the Settings tests can focus on user behavior: click opens the folder command, duplicate clicks are disabled while Finder is opening, and folder-open errors do not block backup creation.

## When to Apply

- A renderer action needs to open backups, exports, logs, diagnostics, or another known app-managed folder.
- The path is already part of trusted app configuration such as `AppPaths`.
- A generic `openPath(path)` would be convenient but too broad.
- The action belongs in Settings or help copy because users need to find local artifacts.

## Examples

The backup-folder action follows the full typed bridge path:

- `apps/desktop/src/shared/channels.ts` adds `backups:openFolder`.
- `apps/desktop/src/shared/contract.ts` adds a void request schema and result type.
- `apps/desktop/src/preload/index.ts` exposes `backups.openFolder()`.
- `apps/desktop/src/main/ipc.ts` opens `context.paths.backupsDir`.
- `apps/web/src/lib/appApi.ts` exposes `appApi.openBackupsFolder()`.
- `apps/web/src/pages/Settings.tsx` renders the secondary "Open backups folder" action.

The focused tests cover every seam:

- contract schema accepts no payload,
- preload invokes the fixed channel,
- main uses the managed backups directory and rejects injected payloads,
- renderer wrapper forwards without arguments,
- Settings button handles success, pending, and error states.

## Related

- [Run automatic rolling backups in Electron main, not the renderer](./electron-main-rolling-backups-over-renderer-reminders.md)
- [Test operation-log and IPC invariants for extract->card mutation paths](./extract-card-ipc-invariant-test-hardening.md)
- [Test-audit driven battle testing](./test-audit-driven-battle-testing.md)
- [URL-imported articles inbox processing](../ui-bugs/url-imported-articles-inbox-processing.md)
- [Open backups folder plan](../../plans/2026-06-07-open-backups-folder.md)
- [Safety, analytics, and backup tasks](../../tasks/M9-safety-analytics-backup.md)
- [Desktop architecture](../../architecture.md)
