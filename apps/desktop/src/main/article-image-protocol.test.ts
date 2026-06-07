import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ProtocolHandler = (request: Request) => Response | Promise<Response>;

const electronMock = vi.hoisted(() => ({
  handlers: new Map<string, ProtocolHandler>(),
  registerSchemesAsPrivileged: vi.fn(),
  handle: vi.fn((scheme: string, handler: ProtocolHandler) => {
    electronMock.handlers.set(scheme, handler);
  }),
}));

vi.mock("electron", () => ({
  protocol: {
    registerSchemesAsPrivileged: electronMock.registerSchemesAsPrivileged,
    handle: electronMock.handle,
  },
}));

import {
  ARTICLE_IMAGE_SCHEME,
  registerArticleImageProtocol,
  registerArticleImageSchemePrivileges,
} from "./article-image-protocol";

let dir: string;
let assetsDir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "interleave-article-image-protocol-"));
  assetsDir = path.join(dir, "assets");
  fs.mkdirSync(assetsDir, { recursive: true });
  electronMock.handlers.clear();
  electronMock.registerSchemesAsPrivileged.mockClear();
  electronMock.handle.mockClear();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeAsset(relativePath: string, content: string): void {
  const abs = path.join(assetsDir, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function imageAsset(
  overrides: Partial<{
    id: string;
    owningElementId: string;
    kind: string;
    root: string;
    relativePath: string;
    mime: string;
    size: number;
  }> = {},
) {
  const id = overrides.id ?? "asset-1";
  const relativePath = overrides.relativePath ?? "sources/source-1/images/asset-1.png";
  return {
    id,
    owningElementId: overrides.owningElementId ?? "source-1",
    kind: overrides.kind ?? "image",
    location: {
      assetId: id,
      vaultPath: {
        root: overrides.root ?? "assets",
        relativePath,
      },
    },
    contentHash: "sha256:asset-1",
    mime: overrides.mime ?? "image/png",
    size: overrides.size ?? 10,
    width: null,
    height: null,
    durationMs: null,
    createdAt: "2026-06-07T00:00:00.000Z",
  };
}

function dbServiceFor(options: {
  readonly source?: unknown | null;
  readonly asset?: unknown | null;
}) {
  return {
    repos: {
      sources: {
        findById: vi.fn(() => options.source ?? { source: { elementId: "source-1" } }),
      },
      assets: {
        findById: vi.fn(() => options.asset ?? null),
      },
    },
  };
}

function handler(): ProtocolHandler {
  const registered = electronMock.handlers.get(ARTICLE_IMAGE_SCHEME);
  if (!registered) throw new Error("article-image protocol handler was not registered");
  return registered;
}

async function readText(res: Response): Promise<string> {
  return new TextDecoder().decode(await res.arrayBuffer());
}

describe("article-image protocol", () => {
  it("registers the article image scheme as secure and stream-capable", () => {
    registerArticleImageSchemePrivileges();

    expect(electronMock.registerSchemesAsPrivileged).toHaveBeenCalledWith([
      {
        scheme: ARTICLE_IMAGE_SCHEME,
        privileges: {
          secure: true,
          stream: true,
          bypassCSP: false,
        },
      },
    ]);
  });

  it("streams source-owned image assets with content type and length", async () => {
    const relativePath = "sources/source-1/images/asset-1.png";
    writeAsset(relativePath, "image-bytes");
    const dbService = dbServiceFor({ asset: imageAsset({ relativePath }) });
    registerArticleImageProtocol(dbService as never, assetsDir);

    const res = await handler()(new Request("article-image://source-1/asset-1"));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Content-Length")).toBe("11");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await readText(res)).toBe("image-bytes");
    expect(dbService.repos.sources.findById).toHaveBeenCalledWith("source-1");
    expect(dbService.repos.assets.findById).toHaveBeenCalledWith("asset-1");
  });

  it("rejects malformed IDs before resolving database rows", async () => {
    const dbService = dbServiceFor({ asset: imageAsset() });
    registerArticleImageProtocol(dbService as never, assetsDir);

    for (const url of [
      "article-image:///",
      "article-image://source-1",
      "article-image://source-1/asset-1/extra",
      "article-image://source-1/a%2Fb",
      "article-image://source-1/%2e%2e",
      "article-image://source-1/asset-1?download=1",
      "article-image://source-1/asset.1",
    ]) {
      const res = await handler()({ url, headers: new Headers() } as Request);
      expect(res.status, url).toBe(400);
    }

    expect(dbService.repos.sources.findById).not.toHaveBeenCalled();
    expect(dbService.repos.assets.findById).not.toHaveBeenCalled();
  });

  it("rejects missing source rows and unknown assets", async () => {
    registerArticleImageProtocol(dbServiceFor({ source: null }) as never, assetsDir);
    expect(await handler()(new Request("article-image://source-1/asset-1"))).toHaveProperty(
      "status",
      404,
    );

    electronMock.handlers.clear();
    registerArticleImageProtocol(dbServiceFor({ asset: null }) as never, assetsDir);
    expect(await handler()(new Request("article-image://source-1/asset-1"))).toHaveProperty(
      "status",
      404,
    );
  });

  it("rejects assets with the wrong owner, kind, MIME, or vault root", async () => {
    for (const asset of [
      imageAsset({ owningElementId: "other-source" }),
      imageAsset({ kind: "source_html" }),
      imageAsset({ mime: "text/html" }),
      imageAsset({ mime: "image/svg+xml" }),
      imageAsset({ mime: "image/tiff" }),
      imageAsset({ root: "exports" }),
    ]) {
      electronMock.handlers.clear();
      registerArticleImageProtocol(dbServiceFor({ asset }) as never, assetsDir);
      const res = await handler()(new Request("article-image://source-1/asset-1"));
      expect(res.status).toBe(404);
    }
  });

  it("rejects missing files and asset paths that escape the asset vault", async () => {
    registerArticleImageProtocol(
      dbServiceFor({
        asset: imageAsset({ relativePath: "sources/source-1/images/missing.png" }),
      }) as never,
      assetsDir,
    );
    expect(await handler()(new Request("article-image://source-1/asset-1"))).toHaveProperty(
      "status",
      404,
    );

    fs.writeFileSync(path.join(dir, "secret.png"), "secret");
    for (const relativePath of [
      "../secret.png",
      "sources/source-1/images/../../secret.png",
      "/tmp/secret.png",
      "sources\\source-1\\images\\asset-1.png",
    ]) {
      electronMock.handlers.clear();
      registerArticleImageProtocol(
        dbServiceFor({ asset: imageAsset({ relativePath }) }) as never,
        assetsDir,
      );
      const res = await handler()(new Request("article-image://source-1/asset-1"));
      expect(res.status, relativePath).toBe(404);
    }
  });
});
