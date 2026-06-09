/**
 * Backup-archive extraction helper — PURE + framework-free (no Electron, no DB).
 *
 * Restore-from-file ingests an UNTRUSTED `.zip` the user picked on disk (moved
 * from another machine, recovered from external storage, or an old archive the
 * retention policy already pruned). The archive could be malformed or hostile,
 * so this helper is the FIRST line of defence: it validates every entry name
 * against zip-slip BEFORE writing anything that could escape `destDir`, and
 * surfaces a clear error on a non-zip / truncated buffer instead of swallowing
 * it. Verification of the extracted contents (manifest / hashes / SQLite
 * integrity) happens downstream in `backup-restore-service.ts`.
 *
 * It deliberately depends only on `node:fs`, `node:path`, and `fflate`
 * (pure-JS, already proven in `@interleave/importers`), mirroring the
 * pure-helper style of `backup-manifest.ts` so it is trivially unit-testable.
 */

import fs from "node:fs";
import path from "node:path";
import { unzipSync } from "fflate";

/**
 * Validate an archive entry path against zip-slip and resolve it to an absolute
 * path that is GUARANTEED to stay inside `destDir`. Mirrors the `safeJoin`
 * discipline in `backup-restore-service.ts` exactly (reject absolute paths,
 * backslashes, empty names, and any `/`-split segment that is empty / `.` /
 * `..`), then re-checks containment against the resolved path. Throws on any
 * violation BEFORE the caller writes a single byte.
 */
export function assertSafeArchiveEntry(destDir: string, entryPath: string): string {
  if (path.isAbsolute(entryPath) || entryPath.includes("\\") || entryPath.length === 0) {
    throw new Error(`backup restore: unsafe archive entry ${entryPath}`);
  }
  const parts = entryPath.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new Error(`backup restore: unsafe archive entry ${entryPath}`);
  }
  const abs = path.join(destDir, ...parts);
  const rootWithSep = destDir.endsWith(path.sep) ? destDir : `${destDir}${path.sep}`;
  if (abs !== destDir && !abs.startsWith(rootWithSep)) {
    throw new Error(`backup restore: unsafe archive entry ${entryPath}`);
  }
  return abs;
}

/**
 * Extract a backup `.zip` into `destDir`. Reads the whole archive into memory
 * (backups are tens of MB at most), parses it with `fflate.unzipSync`, and for
 * each non-directory entry validates the path with {@link assertSafeArchiveEntry}
 * before creating parent dirs and writing the bytes. Directory entries (a
 * trailing `/`) are skipped — their files still extract because each file entry
 * recreates its own parent chain. A truncated / non-zip buffer surfaces as a
 * descriptive Error rather than being swallowed.
 */
export function extractBackupArchive(zipPath: string, destDir: string): void {
  const bytes = new Uint8Array(fs.readFileSync(zipPath));
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch (cause) {
    throw new Error("backup restore: could not read archive", { cause });
  }
  for (const [entryPath, data] of Object.entries(entries)) {
    if (entryPath.endsWith("/")) {
      continue;
    }
    const abs = assertSafeArchiveEntry(destDir, entryPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.from(data));
  }
}
