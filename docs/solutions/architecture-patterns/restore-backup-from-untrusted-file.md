---
title: "Restore a backup from an untrusted file on disk"
date: "2026-06-09"
category: "docs/solutions/architecture-patterns/"
module: "desktop-backup-restore"
problem_type: "architecture_pattern"
component: "service_object"
severity: "high"
related_components:
  - "database"
  - "preload-bridge"
  - "settings-ui"
  - "testing_framework"
applies_when:
  - "Adding a restore/import path that ingests a user-chosen file the app did not produce"
  - "Relaxing a 'main-managed identifier only, never a renderer path' IPC boundary"
  - "Unzipping or otherwise decompressing an untrusted archive in the main process"
tags:
  - "backup-restore"
  - "electron-main"
  - "ipc"
  - "untrusted-archive"
  - "zip-slip"
  - "zip-bomb"
  - "renderer-boundary"
  - "local-first"
---

# Restore a backup from an untrusted file on disk

## Context

Interleave already restored app-managed backups by a regex-guarded `timestamp` that resolved to
`backups/<timestamp>/` — the renderer could only name an artifact the app itself produced, never a
path (see [electron-sqlite-backup-restore-reset-coordination](./electron-sqlite-backup-restore-reset-coordination.md)).
Users needed to restore a backup the app does **not** manage: a portable `.zip` moved from another
machine, recovered from external storage, or older than the retention window keeps. That requires
two things the original design deliberately excluded — a way to pick an **arbitrary path**, and a
way to ingest an **untrusted archive**. This note records how to add both without widening the
trust boundary into a generic file-read primitive, and the threat model the untrusted-archive path
must defend.

## Guidance

**1. Resolve "arbitrary path" through a main-owned picker + a narrow act command — not a renderer path.**
Mirror the existing import pickers (`sources.pickImportFile` → `sources.importEpub({ path })`): a
main-owned `dialog.showOpenDialog` returns the chosen path, and a separate narrow command acts on
it. The renderer receives only the path the OS dialog produced; it never gains a generic
filesystem capability. The act command (`backups.restoreFile`) can do exactly one thing —
extract+verify+install a backup — so a renderer-supplied path is not a file-read oracle. Re-validate
main-side with a strict zod schema (`z.string().min(1)`, `confirm: z.literal(true)`,
`phrase: z.literal("RESTORE BACKUP")`).

**2. Converge file-restore onto the EXISTING verify + atomic install-with-rollback pipeline.**
Do not fork the install path. Split verification so it can run against an explicit directory
(`verifyBackupDir(dir)`), then have both the timestamp restore and the file restore feed the same
`verifyBackupDir → copyBackupToStage → beginLocalDataReplacement → beforeReplaceLocalData →
installStageWithRollback → completeLocalDataReplacement`. The app's own backup `.zip` already stores
`manifest.json` / `app.sqlite` / `assets/...` at the archive root, so an extracted archive is shaped
exactly like `backups/<timestamp>/` and verifies with no special-casing. One verification + one
rollback policy means the two paths cannot drift.

**3. Treat the archive as hostile. Two distinct guards, both BEFORE any install:**

- **Zip-slip (path traversal):** validate every entry name before writing — reject absolute paths,
  backslashes, empty/`.`/`..` segments, and re-check that the resolved path stays inside the
  destination. Keep this guard in ONE shared function used by both the extractor and the
  manifest-file verifier (a security-sensitive check duplicated in two files will eventually be
  patched in only one).
- **Zip-bomb (unbounded decompression):** an untrusted `.zip` read fully into memory can expand to
  exhaust RAM before any hash/manifest check runs. Stat-and-reject an oversized archive before
  reading, and enforce a cumulative uncompressed-size cap **during** decompression — with fflate,
  pass a `filter` that sums `UnzipFileInfo.originalSize` (the uncompressed size) and throws once it
  exceeds the cap, so the bomb is aborted before its entries are materialized.

**4. Extract under the app data dir, never `os.tmpdir()`.** The staging dir must share a filesystem
with the live store so the install is an atomic `rename`. Clean up the extract dir AND the stage dir
in `finally` on both success and failure.

**5. Keep the result honest.** A file restore has no app-managed timestamp; report the backup's
recorded `manifest.createdAt` (a real ISO timestamp), not the zip filename, in any field typed or
consumed as a timestamp.

## Why This Matters

Whole-store replacement is the most destructive local operation in the app — it swaps the canonical
SQLite DB and the asset vault. Two failure classes are unique to ingesting a file the app did not
produce: a hostile archive that escapes the extraction directory (zip-slip → arbitrary file write)
and one that exhausts memory before verification (zip-bomb → main-process crash). Both must fail
**before** the install begins so the live store is never touched. The picker/act split keeps the
relaxed "arbitrary path" affordance from becoming a generic renderer file-read primitive — the path
originates in a main-owned dialog and the only thing the renderer can do with it is attempt a
backup restore that main fully re-validates. Converging on the existing rollback pipeline means the
hard-won "verify → lock → drain writers → close → move-to-rollback (incl. WAL/SHM) → install →
reopen → restart-required, roll back on any failure" sequence protects the new path for free.

## When to Apply

- Adding any restore/import that consumes a user-chosen file the app didn't create.
- Relaxing a "main-managed identifier only, never a renderer path" IPC contract — reach for a
  main-owned picker + a narrow act command, not a widened path schema on the existing command.
- Decompressing or parsing any untrusted archive in a trusted (main) process.

## Examples

**Picker + narrow act command (the trust seam):**

```ts
// main: the ONLY backup .zip path that crosses to the renderer originates here.
ipcMain.handle(IPC_CHANNELS.backupsPickArchive, async (event) => {
  const paths = await pickBackupArchivePath(event); // showOpenDialog, .zip filter, scoped to sender
  return paths.length === 0 ? { cancelled: true } : { path: paths[0] };
});

// main: re-validates; restoreFile is NOT a generic read — it only restores a backup.
ipcMain.handle(IPC_CHANNELS.backupsRestoreFile, async (_e, raw) => {
  const req = BackupsRestoreFileRequestSchema.parse(raw); // .strict(), path.min(1), confirm+phrase literals
  return makeBackupRestoreService(true).restoreBackupFromArchive(req.path);
});
```

**Zip-bomb backstop via the decompression filter (abort before materializing):**

```ts
let totalUncompressed = 0;
const entries = unzipSync(bytes, {
  filter: (file) => {
    totalUncompressed += file.originalSize; // originalSize = UNCOMPRESSED; size = compressed
    if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      throw new Error("backup restore: archive expands too large");
    }
    return true;
  },
});
```

**Shared zip-slip guard (one source of truth, two callers):**

```ts
// safe-archive-path.ts — used by BOTH the extractor and the manifest-file verifier.
export function safeContainedJoin(root: string, rel: string, errorLabel: string): string {
  if (path.isAbsolute(rel) || rel.includes("\\") || rel.length === 0) throw new Error(`${errorLabel} ${rel}`);
  const parts = rel.split("/");
  if (parts.some((p) => p.length === 0 || p === "." || p === "..")) throw new Error(`${errorLabel} ${rel}`);
  const abs = path.join(root, ...parts);
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (abs !== root && !abs.startsWith(rootWithSep)) throw new Error(`${errorLabel} ${rel}`);
  return abs;
}
```

A note on a non-threat learned here: `fflate.unzipSync` returns entry **bytes**, and the extractor
writes them with `fs.writeFileSync` — it never creates a symlink, even for a symlink-mode zip entry.
So an archive cannot smuggle a symlink that escapes the destination; the only escape vector is the
entry **name**, which the zip-slip guard covers. A regression test locks this in.

## Related

- [electron-sqlite-backup-restore-reset-coordination](./electron-sqlite-backup-restore-reset-coordination.md)
  — the shared verify + lock-and-rollback + restart-boundary pipeline this path reuses (now via the
  `verifyBackupDir` split). That doc's "never by arbitrary filesystem path" rule is extended here:
  a main-owned picker may hand main one path that main re-validates as an untrusted archive.
- [pathless-backups-open-folder-ipc](./pathless-backups-open-folder-ipc.md) — contrast: that rule
  forbids a *reusable generic opener / renderer-supplied raw path*; a picker that returns one path
  to main (which re-validates and can only restore a backup with it) is not that escape hatch.
- [electron-main-rolling-backups-over-renderer-reminders](./electron-main-rolling-backups-over-renderer-reminders.md)
  — the restore-ready archive shape + manifest this path consumes.
- Code: `apps/desktop/src/main/backup-archive.ts`, `apps/desktop/src/main/safe-archive-path.ts`,
  `apps/desktop/src/main/backup-restore-service.ts` (`verifyBackupDir`, `restoreBackupFromArchive`,
  `runInstallPipeline`), `apps/desktop/src/main/ipc.ts` (`backups.pickArchive` / `backups.restoreFile`),
  `apps/web/src/pages/Settings.tsx`, `tests/electron/backup-restore-file.spec.ts`. The import-picker
  trust model this mirrors lives in `sources.pickImportFile` → `sources.importEpub` (no solution doc).
