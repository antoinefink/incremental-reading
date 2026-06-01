/**
 * Streamed vault I/O primitives (T059) — the LARGE-file path for the asset vault.
 *
 * A multi-hundred-MB PDF / audio / video must NEVER sit whole in memory. These
 * helpers stream a source through a SHA-256 hash WHILE writing it to disk, so the
 * bytes flow in chunks and only the hash + a small buffer are ever resident. They
 * are pure Node (no Electron, no DB) so they unit-test against a temp dir.
 *
 * They COMPLEMENT — they do not replace — the small-file `sha256`/`sha256File`
 * (`backup-manifest.ts`), which `readFileSync`s the whole file. Those stay correct
 * and simpler for the HTML snapshots + the backup manifest; this streamed path is
 * specifically for the large binaries M14/M15 import via {@link AssetVaultService}.
 *
 * Atomic write: the bytes are written to a sibling `<dest>.tmp` and `rename`d into
 * place only after the stream fully flushes, so a partial / aborted / erroring
 * write never leaves a corrupt asset at the final path — the temp file is removed
 * and the error propagates.
 */

import crypto from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** What a streamed write reports back: the content hash + the byte count. */
export interface StreamedWriteResult {
  /** Hex-encoded SHA-256 of the bytes written (computed as they streamed). */
  readonly contentHash: string;
  /** Size in bytes of the file written. */
  readonly size: number;
}

/** Inputs to {@link writeStreamedToVault}. */
export interface WriteStreamedInput {
  /**
   * The bytes to write — either a readable stream (e.g. a download / fetch body)
   * or the ABSOLUTE path of an existing source file to copy in. A path is opened
   * as a `createReadStream` so the source is never read whole into memory.
   */
  readonly source: NodeJS.ReadableStream | string;
  /** The ABSOLUTE destination path inside the vault (its dir is created if missing). */
  readonly destAbsPath: string;
}

/**
 * Stream `source` to `destAbsPath`, hashing as it writes, and atomically rename
 * the temp file into place on success. The bytes are NEVER fully buffered: each
 * chunk is fed to a `crypto.createHash("sha256")` AND a `createWriteStream` via a
 * single `pipeline`, so memory stays flat regardless of file size.
 *
 * On any error (a failing source, a disk-full write) the partial `<dest>.tmp` is
 * removed and the error re-throws, so the final path never holds a corrupt asset.
 */
export async function writeStreamedToVault(
  input: WriteStreamedInput,
): Promise<StreamedWriteResult> {
  const { destAbsPath } = input;
  await fs.mkdir(path.dirname(destAbsPath), { recursive: true });
  const tmpPath = `${destAbsPath}.tmp`;

  const hash = crypto.createHash("sha256");
  let size = 0;
  // A tap that updates the hash + byte count for every chunk, then forwards it to
  // the write stream — so the hash is computed from EXACTLY the bytes written.
  const writeStream = createWriteStream(tmpPath);
  const hashingTap = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      size += chunk.length;
      writeStream.write(chunk, (err) => callback(err ?? undefined));
    },
    final(callback) {
      writeStream.end(() => callback());
    },
  });

  const readable: NodeJS.ReadableStream =
    typeof input.source === "string" ? createReadStream(input.source) : input.source;

  try {
    await pipeline(readable, hashingTap);
    // Ensure the underlying write stream has fully flushed + closed before rename.
    await new Promise<void>((resolve, reject) => {
      if (writeStream.closed) {
        resolve();
        return;
      }
      writeStream.once("close", resolve);
      writeStream.once("error", reject);
    });
    await fs.rename(tmpPath, destAbsPath);
  } catch (err) {
    // Best-effort cleanup of the partial temp file so no corrupt asset lingers.
    writeStream.destroy();
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }

  return { contentHash: hash.digest("hex"), size };
}

/**
 * Hex-encoded SHA-256 of a file on disk, computed by STREAMING the bytes through
 * the hash (no whole-file read). The streaming equivalent of `sha256File`, used by
 * the integrity-verify sweep so re-hashing a large stored asset never loads it
 * whole. Matches `sha256File` exactly on any file (same algorithm, streamed vs
 * buffered).
 */
export async function hashFileStreamed(absPath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  await pipeline(createReadStream(absPath), hash);
  return hash.digest("hex");
}
