/**
 * Asset-vault vocabulary (T005, desktop pivot).
 *
 * SQLite is the canonical local database; the **filesystem asset vault** is the
 * canonical store for large binaries (PDFs, HTML snapshots, images, audio,
 * video, exports, backups). These types are the bridge between the two and
 * enforce one invariant: **the bytes never live in SQLite, only metadata does**,
 * and **the renderer never sees or resolves a raw filesystem path** — the
 * Electron main/DB service owns vault access.
 *
 * Framework-agnostic: no `fs`, no `path`, no Electron import here. Path
 * *resolution* (relative → absolute against the app data directory) happens in
 * the Electron layer; this package only models the relative, vault-rooted shape.
 */

import type { AssetKind, VaultRoot } from "./enums";
import type { AssetId, ElementId, IsoTimestamp } from "./ids";

/**
 * A relative, vault-rooted path. It is ALWAYS relative to one of the logical
 * vault roots ({@link VaultRoot}: `assets` / `exports` / `backups`) and is
 * resolved to an absolute on-disk path only by the Electron main process against
 * the app data directory. The renderer passes/receives these but never resolves
 * them — keeping arbitrary filesystem access out of the renderer.
 *
 * Example: `{ root: "assets", relativePath: "sources/<source_id>/original.pdf" }`.
 */
export interface LocalVaultPath {
  readonly root: VaultRoot;
  /**
   * Path relative to `root`, using POSIX `/` separators and no leading slash and
   * no `..` segments (the resolver rejects path traversal). e.g.
   * `sources/<source_id>/original.pdf`, `media/<asset_id>/original.bin`.
   */
  readonly relativePath: string;
}

/**
 * Where an asset's bytes live in the vault (`assets.location`). Pairs the stable
 * {@link AssetId} with its {@link LocalVaultPath}. This is intentionally
 * separate from {@link Asset} so a future cloud-sync layer can carry an
 * additional remote/object-storage location without changing the metadata row
 * shape.
 */
export interface AssetLocation {
  readonly assetId: AssetId;
  readonly vaultPath: LocalVaultPath;
}

/**
 * Metadata for a large binary owned by an element (`assets` table). The actual
 * bytes are on disk in the vault (see {@link AssetLocation}); SQLite stores only
 * this metadata: a stable id, the owning element, kind, MIME, size, content hash
 * (for integrity/dedup), optional media dimensions/duration, and timestamps.
 * Storing blob payloads in SQLite is forbidden.
 */
export interface Asset {
  readonly id: AssetId;
  /** The element that owns this asset (e.g. the `source` for its PDF). */
  readonly owningElementId: ElementId;
  readonly kind: AssetKind;
  /** Where the bytes live in the vault. */
  readonly location: AssetLocation;
  /** Content hash (e.g. sha-256 hex) for integrity checks and dedup. */
  readonly contentHash: string;
  readonly mime: string;
  /** Size in bytes. */
  readonly size: number;
  /** Pixel width for images, else `null`. */
  readonly width: number | null;
  /** Pixel height for images, else `null`. */
  readonly height: number | null;
  /** Duration in milliseconds for audio/video, else `null`. */
  readonly durationMs: number | null;
  readonly createdAt: IsoTimestamp;
}
