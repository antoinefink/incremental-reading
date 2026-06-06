---
title: "Run automatic rolling backups in Electron main, not the renderer"
date: "2026-06-06"
category: "docs/solutions/architecture-patterns/"
module: "desktop-backups"
problem_type: "architecture_pattern"
component: "background_job"
severity: "high"
related_components:
  - "service_object"
  - "database"
  - "testing_framework"
  - "documentation"
applies_when:
  - "A local-first Electron feature needs trusted SQLite, filesystem, or app-data path access."
  - "A durability workflow should run quietly without relying on renderer reminders or user memory."
  - "Automatic maintenance artifacts need retention that preserves manual user-created artifacts."
  - "Manual UI actions should remain available while routine durability work moves to a main-process lifecycle service."
tags:
  - "automatic-backups"
  - "electron-main"
  - "backup-retention"
  - "local-first"
  - "sqlite"
  - "asset-vault"
  - "renderer-boundary"
  - "data-durability"
---

# Run automatic rolling backups in Electron main, not the renderer

## Context

Interleave is a local-first desktop app, so backup work touches trusted app-data paths, the SQLite store, and the asset vault. A renderer banner that asks the user to back up is only a reminder: it depends on the window being open, puts durability on the user's memory, and encourages backup logic to leak toward React.

The better pattern is a quiet Electron main lifecycle service that keeps making restore-ready backups using the same backup format as the manual backup command.

## Guidance

Put automatic local maintenance in Electron main when it needs filesystem, database, app lifecycle, or trusted path access. The renderer can still expose explicit commands such as "create backup now", but routine durability should not be a UI prompt.

Start the automatic backup service after app paths, SQLite, migrations, IPC, and the local runner are initialized. Stop it before closing the database so in-flight work cannot write against torn-down resources.

Scheduler failure isolation is part of the contract. A failed backup tick should be logged without crashing startup, later ticks should be able to retry, and manual-vs-automatic races should serialize before re-checking whether another backup already satisfied the due window.

Use one canonical backup implementation for both manual and automatic backups:

- SQLite is copied through the same safe backup path.
- Asset vault files are copied through the same manifest-producing path.
- The backup archive shape stays restore-ready.
- Automatic artifacts get a trusted prefix so pruning can distinguish them from manual archives.

Retention should thin backups over time rather than keeping every archive forever. The shipped schedule keeps dense recent history, then gradually coarser history:

```ts
[
  { maxAgeMs: 2 * DAY_MS, intervalMs: HOUR_MS },
  { maxAgeMs: 7 * DAY_MS, intervalMs: 6 * HOUR_MS },
  { maxAgeMs: 30 * DAY_MS, intervalMs: DAY_MS },
  { maxAgeMs: 12 * WEEK_MS, intervalMs: WEEK_MS },
  { maxAgeMs: 2 * YEAR_MS, intervalMs: MONTH_MS },
];
```

Manual backups should suppress an immediate automatic duplicate if one was just created, but automatic retention must not delete manual backups. That means due checks can consider all valid backup timestamps, while pruning only acts on automatic artifacts.

Treat backup retention as data-integrity code. Tests should cover:

- future-dated automatic artifacts
- partial artifacts where one side of the backup exists without its pair
- backup failures that must not crash startup or prevent later retries
- shutdown while a backup is in flight
- manual and automatic backups created at nearly the same time
- size accounting for both archives and matching unpacked directories
- retention boundaries between hourly, six-hourly, daily, weekly, and monthly buckets
- deterministic E2E setup that disables automatic background work unless the test opts in

## Why This Matters

Backups are only useful when they happen before the user needs them. A banner optimizes for awareness, but automatic rolling backups optimize for recovery. Keeping the service in Electron main also preserves the project's security boundary: React does not gain raw filesystem or SQLite access just to support durability.

Local rolling backups are still same-device protection. They help with recent app mistakes, accidental edits, and restore drills, but they do not replace future off-device encrypted backups for disk failure, loss, or theft.

The manual/automatic distinction matters because a user-created backup is an intentional artifact. Automatic pruning can manage its own artifacts aggressively, but deleting manual backups as a side effect of a background job would silently destroy user data.

## When to Apply

- The workflow protects user data, local files, or durable app state.
- The work needs trusted app-data paths or direct interaction with SQLite.
- The renderer is only reminding the user to do something that the app can do safely itself.
- The artifacts need a retention policy, size cap, or lifecycle independent from user-created exports.

## Examples

Before, the UI had a single large prompt that asked the user to make a backup:

```tsx
<BackupPrompt onCreateBackup={createBackup} />;
```

After, Electron main owns the recurring work and the renderer keeps only explicit manual backup controls:

```ts
const backupService = new BackupService(paths);
const automaticBackups = new AutomaticBackupService({
  backupService,
  backupDirectory: paths.backups,
});

await automaticBackups.start();
```

If a user manually creates a backup at 10:00, the automatic service can treat that timestamp as satisfying the next due check. Later retention still prunes only archives that it created itself.

## Related

- [Automatic rolling backups plan](../../plans/2026-06-06-002-feat-automatic-rolling-backups-plan.md)
- [Desktop architecture](../../architecture.md)
- [Safety, analytics, and backup tasks](../../tasks/M9-safety-analytics-backup.md)
- [MVP ship tasks](../../tasks/M10-ship-mvp.md)
- [Automatic backup service](../../../apps/desktop/src/main/automatic-backup-service.ts)
- [Automatic backup service tests](../../../apps/desktop/src/main/automatic-backup-service.test.ts)
- [Manual backup service](../../../apps/desktop/src/main/backup-service.ts)
- [Backup E2E coverage](../../../tests/electron/backup.spec.ts)
