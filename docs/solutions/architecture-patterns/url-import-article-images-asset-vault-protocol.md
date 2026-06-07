---
title: "Store URL-imported article images as asset-vault files served by a narrow protocol"
date: "2026-06-07"
category: "docs/solutions/architecture-patterns/"
module: "url-import"
problem_type: "architecture_pattern"
component: "service_object"
severity: "high"
applies_when:
  - "URL-imported HTML contains images that must become durable local source content."
  - "Imported documents need local asset-vault references instead of remote, file, or data URLs."
  - "Electron must serve trusted local bytes to the renderer without exposing filesystem paths."
related_components:
  - "database"
  - "testing_framework"
  - "tooling"
tags:
  - "url-import"
  - "article-images"
  - "asset-vault"
  - "electron-protocol"
  - "prosemirror"
  - "sanitization"
  - "local-first"
  - "restart-persistence"
---

# Store URL-imported article images as asset-vault files served by a narrow protocol

## Context

URL-imported articles need to preserve figures even when the original website changes or disappears. Hotlinking remote `<img>` URLs breaks the local-first promise, leaks reader activity back to the web, and lets the renderer depend on arbitrary remote resources.

The durable pattern is to treat article images like source-owned assets: Electron main fetches and validates the bytes, stores them under the local asset vault, writes asset metadata in SQLite, and rewrites the source document to a constrained local reference.

## Guidance

Keep the full image import path in Electron main. The renderer should never download article images, receive raw filesystem paths, or persist remote `http`, `file`, or `data` image URLs.

The import pipeline should:

- Pre-mint the source id so image paths and protocol URLs are source-scoped from the start.
- Fetch image candidates with bounded manual redirects, validating each redirect target before issuing the next request.
- Enforce per-image, total-article, count, concurrency, and timeout limits.
- Stream image bytes into `assets/sources/<source_id>/images/` while hashing them.
- Validate the actual bytes against a closed raster allowlist instead of trusting `Content-Type` alone.
- Insert image asset metadata in the same source transaction as the source document and snapshots.
- Remove the source vault directory if image import, conversion, snapshot writes, or the DB transaction fails.

The stored document should use a constrained block node:

```ts
{
  type: "image",
  attrs: {
    src: "article-image://<source_id>/<asset_id>",
    alt: "Figure label",
    width: 640,
    height: 480,
  },
}
```

The sanitizer and editor schema should both reject anything except local `article-image://<source_id>/<asset_id>` references plus safe descriptive attributes. This gives defense in depth: malformed persisted JSON cannot make the reader hotlink a remote image.

Serve the image through a narrow Electron protocol. The handler should resolve both ids through SQLite, require that the asset is owned by the source, require `kind === "image"`, enforce the same raster MIME allowlist, reject path traversal, and stream from the asset vault with `X-Content-Type-Options: nosniff`.

Do not add backup-specific behavior for article images. They are ordinary asset-vault files, so future backup and restore code should handle them through the existing asset vault boundary.

## Why This Matters

This preserves source fidelity while keeping the renderer untrusted. The reader displays durable local bytes, but it still only sees opaque source/asset ids and a custom protocol URL. SQLite owns metadata; the filesystem owns large bytes; Electron main owns all trusted path resolution.

Content-hash dedup needs special care. A text-only cleaned HTML fingerprint can false-match two pages whose words are identical but figures differ. For image-bearing article imports, prefer canonical-URL dedup and skip content-hash dedup until the fingerprint can include stable image identity or content hashes.

Timeout and redirect behavior are part of the security boundary. A fetch timeout that ends when headers arrive can still hang forever on the body stream. A redirect check after `fetch(..., { redirect: "follow" })` happens too late because the private-host request has already been made.

## When to Apply

- A readable import pipeline needs to preserve external subresources as local content.
- Source documents must survive remote resources disappearing.
- The document renderer needs media without raw filesystem access.
- The import flow writes both SQLite metadata and filesystem bytes.
- Duplicate detection could conflate materially different media-bearing documents.

## Examples

The URL import service localizes images before persisting the cleaned snapshot and document, then writes source and asset rows together:

```ts
const localizedImages = await importArticleImages({
  html: article.contentHtml,
  articleUrl: input.finalUrl,
  sourceId,
  assetsDir,
});

const localizedCleanedHtml = sanitizeArticleHtml(localizedImages.html);
const conversion = htmlToProseMirrorDoc(localizedCleanedHtml);

db.transaction((tx) => {
  sources.createWithDocumentWithin(tx, { id: sourceId, conversion, snapshotKey: cleanedRel });
  for (const asset of localizedImages.assetInputs) {
    assets.createWithin(tx, { ...asset.input, id: asset.id });
  }
});
```

The image protocol stays id-based and source-owned:

```ts
const asset = repos.assets.findById(assetId);
if (asset.owningElementId !== sourceId) return notFound();
if (asset.kind !== "image" || !allowedRasterMime(asset.mime)) return notFound();
return streamVaultFile(asset.location.vaultPath);
```

Regression coverage should prove:

- remote and malformed image URLs are stripped from sanitized documents
- local image refs convert to ProseMirror `image` blocks with stable block ids
- image bytes are streamed, hashed, byte-sniffed, and capped
- public image redirects to private hosts are rejected before the second request
- stalled response bodies time out
- MIME types unsupported by the protocol are rejected
- localized `cleaned.html` contains local refs and no remote image URL
- image-bearing articles with different figures are not collapsed by text-only content-hash dedup
- Electron E2E import survives app restart with document JSON, snapshots, and image vault files intact

## Related

- [URL and browser-captured articles should open as internal readable sources](../ui-bugs/url-imported-articles-inbox-processing.md)
- [Open managed backup folders with pathless IPC](./pathless-backups-open-folder-ipc.md)
- [Run automatic rolling backups in Electron main, not the renderer](./electron-main-rolling-backups-over-renderer-reminders.md)
- [Battle-testing matrix and test-hardening execution for core app surfaces](./test-audit-driven-battle-testing.md)
- [URL import service](../../../apps/desktop/src/main/url-import-service.ts)
- [Article image importer](../../../apps/desktop/src/main/article-image-import.ts)
- [Article image protocol](../../../apps/desktop/src/main/article-image-protocol.ts)
- [Article image node](../../../packages/editor/src/nodes/article-image.ts)
- [HTML sanitizer](../../../packages/importers/src/sanitize.ts)
- [URL import E2E](../../../tests/electron/url-import.spec.ts)
