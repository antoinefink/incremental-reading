/**
 * Streamed vault-I/O unit tests (T059).
 *
 * Proves the LARGE-file path is correct without ever loading a file whole:
 *  - `writeStreamedToVault` over a multi-MB `Readable` writes a file whose ON-DISK
 *    bytes hash to the returned `contentHash` and whose `size` matches;
 *  - an erroring source leaves NO file at the FINAL path (the atomic temp → rename
 *    means a partial write never lands a corrupt asset);
 *  - `hashFileStreamed` matches the buffered `sha256File` on a small file (same
 *    algorithm, streamed vs read-whole) and works on a large file.
 *
 * The large fixture is generated IN-TEST (no committed binary).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256File } from "./backup-manifest";
import { hashFileStreamed, writeStreamedToVault } from "./vault-io";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "interleave-vaultio-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A deterministic multi-MB buffer of pseudo-random bytes (generated, not committed). */
function bigBuffer(sizeBytes: number): Buffer {
  const buf = Buffer.allocUnsafe(sizeBytes);
  // Fill in 64 KiB chunks of randomness — large enough to span many stream chunks.
  for (let offset = 0; offset < sizeBytes; offset += 65_536) {
    const chunk = crypto.randomBytes(Math.min(65_536, sizeBytes - offset));
    chunk.copy(buf, offset);
  }
  return buf;
}

describe("writeStreamedToVault (T059)", () => {
  it("streams a multi-MB source to disk and reports a matching hash + size", async () => {
    const bytes = bigBuffer(5 * 1024 * 1024); // 5 MiB
    const dest = path.join(dir, "media", "asset-1", "original.bin");

    const { contentHash, size } = await writeStreamedToVault({
      source: Readable.from(bytes),
      destAbsPath: dest,
    });

    expect(fs.existsSync(dest)).toBe(true);
    expect(size).toBe(bytes.byteLength);
    // The reported hash equals the hash of the bytes actually on disk.
    const onDisk = fs.readFileSync(dest);
    expect(contentHash).toBe(crypto.createHash("sha256").update(onDisk).digest("hex"));
    expect(contentHash).toBe(crypto.createHash("sha256").update(bytes).digest("hex"));
    // No temp file lingers after a successful write.
    expect(fs.existsSync(`${dest}.tmp`)).toBe(false);
  });

  it("copies from an absolute source PATH (never reading it whole) with the right hash", async () => {
    const bytes = bigBuffer(2 * 1024 * 1024);
    const src = path.join(dir, "incoming.bin");
    fs.writeFileSync(src, bytes);
    const dest = path.join(dir, "media", "asset-2", "original.bin");

    const { contentHash, size } = await writeStreamedToVault({ source: src, destAbsPath: dest });

    expect(size).toBe(bytes.byteLength);
    expect(contentHash).toBe(sha256File(dest));
  });

  it("leaves NO file at the final path when the source errors mid-stream (atomic)", async () => {
    const dest = path.join(dir, "media", "asset-3", "original.bin");
    // A source that yields one chunk then throws.
    const failing = new Readable({
      read() {
        this.push(Buffer.from("partial-data"));
        this.destroy(new Error("boom"));
      },
    });

    await expect(writeStreamedToVault({ source: failing, destAbsPath: dest })).rejects.toThrow(
      /boom/,
    );

    // The final path holds nothing, and the temp file was cleaned up.
    expect(fs.existsSync(dest)).toBe(false);
    expect(fs.existsSync(`${dest}.tmp`)).toBe(false);
  });
});

describe("hashFileStreamed (T059)", () => {
  it("matches the buffered sha256File on a small file", async () => {
    const file = path.join(dir, "small.txt");
    fs.writeFileSync(file, "the spacing effect\n");
    expect(await hashFileStreamed(file)).toBe(sha256File(file));
  });

  it("hashes a large file (streamed, never read whole) to the same value as a buffered hash", async () => {
    const bytes = bigBuffer(4 * 1024 * 1024);
    const file = path.join(dir, "large.bin");
    fs.writeFileSync(file, bytes);
    expect(await hashFileStreamed(file)).toBe(
      crypto.createHash("sha256").update(bytes).digest("hex"),
    );
  });
});
