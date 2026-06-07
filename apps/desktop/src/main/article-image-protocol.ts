/**
 * Privileged `article-image://` protocol (U3) — streams downloaded article images
 * from the local asset vault without exposing raw filesystem paths to the renderer.
 *
 * The URL is `article-image://<source_id>/<asset_id>`. MAIN resolves both ids
 * through SQLite asset metadata, verifies the asset is an image owned by the source,
 * validates the MIME, then streams the vault file rooted at `assetsDir`.
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { protocol } from "electron";
import type { DbService } from "./db-service";

/** The custom scheme used to render local article images. */
export const ARTICLE_IMAGE_SCHEME = "article-image";

/**
 * Register the scheme as privileged. MUST be called before `app.whenReady()` so
 * Electron treats it as a secure streaming scheme in both dev and production.
 */
export function registerArticleImageSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ARTICLE_IMAGE_SCHEME,
      privileges: { secure: true, stream: true, bypassCSP: false },
    },
  ]);
}

/** Install the `article-image://<source_id>/<asset_id>` streaming handler. */
export function registerArticleImageProtocol(dbService: DbService, assetsDir: string): void {
  protocol.handle(ARTICLE_IMAGE_SCHEME, async (request) => {
    const parsed = parseArticleImageUrl(request.url);
    if (!parsed) return new Response("Bad article image id", { status: 400 });

    const source = dbService.repos.sources.findById(parsed.sourceId as never);
    if (!source) return new Response("Not found", { status: 404 });

    const asset = dbService.repos.assets.findById(parsed.assetId as never);
    if (!asset) return new Response("Not found", { status: 404 });
    if (asset.owningElementId !== parsed.sourceId) {
      return new Response("Not found", { status: 404 });
    }
    if (asset.kind !== "image" || !isImageMime(asset.mime)) {
      return new Response("Not found", { status: 404 });
    }

    const abs = resolveAssetPath(assetsDir, asset.location.vaultPath);
    if (!abs) return new Response("Not found", { status: 404 });

    let size: number;
    try {
      const file = await stat(abs);
      if (!file.isFile()) return new Response("Not found", { status: 404 });
      size = file.size;
    } catch {
      return new Response("Not found", { status: 404 });
    }

    const stream = createReadStream(abs);
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 200,
      headers: {
        "Content-Type": asset.mime,
        "Content-Length": String(size),
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}

interface ParsedArticleImageUrl {
  readonly sourceId: string;
  readonly assetId: string;
}

function parseArticleImageUrl(rawUrl: string): ParsedArticleImageUrl | null {
  const prefix = `${ARTICLE_IMAGE_SCHEME}://`;
  if (!rawUrl.toLowerCase().startsWith(prefix)) return null;

  const pathPart = rawUrl.slice(prefix.length);
  if (!pathPart || /[?#]/.test(pathPart)) return null;

  const parts = pathPart.split("/");
  if (parts.length !== 2) return null;

  const sourceId = decodeId(parts[0] ?? "");
  const assetId = decodeId(parts[1] ?? "");
  if (!sourceId || !assetId) return null;

  return { sourceId, assetId };
}

function decodeId(raw: string): string | null {
  try {
    const decoded = decodeURIComponent(raw).trim();
    return isSafeId(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(id);
}

function isImageMime(mime: string): boolean {
  return ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(mime.toLowerCase());
}

function resolveAssetPath(
  assetsDir: string,
  vaultPath: { readonly root: string; readonly relativePath: string },
): string | null {
  if (vaultPath.root !== "assets") return null;

  const relativePath = vaultPath.relativePath;
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes("\\")) {
    return null;
  }

  const parts = relativePath.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    return null;
  }

  const root = path.resolve(assetsDir);
  const abs = path.resolve(root, ...parts);
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return abs;
}
