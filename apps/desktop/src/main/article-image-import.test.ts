import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ElementId } from "@interleave/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ARTICLE_IMAGE_MAX_IMAGE_BYTES,
  type ArticleImageSkipReason,
  importArticleImages,
} from "./article-image-import";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff, 0xdb]);
const GIF_SIGNATURE = Buffer.from("GIF89a", "ascii");
const WEBP_SIGNATURE = Buffer.from("RIFF0000WEBP", "ascii");

let dir: string;
let assetsDir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "interleave-article-images-"));
  assetsDir = path.join(dir, "assets");
  fs.mkdirSync(assetsDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

interface ImageRoute {
  readonly body?: Buffer;
  readonly contentType?: string;
  readonly contentLength?: number;
  readonly status?: number;
  readonly finalUrl?: string;
}

function imageFetch(routes: Record<string, ImageRoute>): typeof fetch {
  return vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    const route = routes[url];
    if (!route) throw new Error(`unexpected fetch: ${url}`);
    const body = route.body ?? pngBytes("image");
    const headers = new Headers();
    if (route.contentType !== undefined) headers.set("content-type", route.contentType);
    else headers.set("content-type", "image/png");
    if (route.contentLength !== undefined)
      headers.set("content-length", String(route.contentLength));
    else headers.set("content-length", String(body.byteLength));
    const response = new Response(body, { status: route.status ?? 200, headers });
    Object.defineProperty(response, "url", { value: route.finalUrl ?? url });
    return response;
  }) as unknown as typeof fetch;
}

function sha256(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function pngBytes(label: string): Buffer {
  return Buffer.concat([PNG_SIGNATURE, Buffer.from(label)]);
}

function jpegBytes(label: string): Buffer {
  return Buffer.concat([JPEG_SIGNATURE, Buffer.from(label)]);
}

function gifBytes(label: string): Buffer {
  return Buffer.concat([GIF_SIGNATURE, Buffer.from(label)]);
}

function webpBytes(label: string): Buffer {
  return Buffer.concat([WEBP_SIGNATURE, Buffer.from(label)]);
}

function readVaultFile(relativePath: string): Buffer {
  return fs.readFileSync(path.join(assetsDir, ...relativePath.split("/")));
}

function reasons(
  result: Awaited<ReturnType<typeof importArticleImages>>,
): ArticleImageSkipReason[] {
  return result.skipped.map((skip) => skip.reason);
}

describe("importArticleImages", () => {
  it("downloads absolute, relative, protocol-relative, and srcset images into source-scoped vault paths", async () => {
    const sourceId = "source-1" as ElementId;
    const jpg = jpegBytes("jpeg-bytes");
    const png = pngBytes("png-bytes");
    const webp = webpBytes("webp-bytes");
    const large = jpegBytes("large-srcset-bytes");
    const fetchImpl = imageFetch({
      "https://cdn.example/a.jpg": { body: jpg, contentType: "image/jpeg; charset=binary" },
      "https://example.com/relative.png": { body: png, contentType: "image/png" },
      "https://static.example/pic.webp": { body: webp, contentType: "image/webp" },
      "https://example.com/large.jpg": { body: large, contentType: "image/jpeg" },
    });

    const result = await importArticleImages({
      html: `<article>
        <p>before</p>
        <img src="https://cdn.example/a.jpg" alt="A&amp;B" width="640" height="480">
        <img src="/relative.png" title="Relative">
        <img src="//static.example/pic.webp">
        <img srcset="/small.jpg 320w, /large.jpg 1280w" alt="From srcset">
      </article>`,
      articleUrl: "https://example.com/articles/read",
      sourceId,
      assetsDir,
      fetchImpl,
    });

    expect(result.skipped).toEqual([]);
    expect(result.assetInputs).toHaveLength(4);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://example.com/large.jpg",
      expect.objectContaining({ redirect: "manual" }),
    );

    const refs = result.html.match(/article-image:\/\/source-1\/[a-f0-9-]+/g) ?? [];
    expect(refs).toEqual(result.assetInputs.map((asset) => asset.protocolUrl));
    expect(result.html).toContain('alt="A&amp;B"');
    expect(result.html).toContain('title="Relative"');
    expect(result.html).toContain('width="640"');
    expect(result.html).toContain('height="480"');
    expect(result.html).not.toContain("cdn.example");
    expect(result.html).not.toContain("srcset=");

    const firstHash = sha256(jpg);
    expect(result.assetInputs[0]?.input).toMatchObject({
      owningElementId: sourceId,
      kind: "image",
      vaultRoot: "assets",
      relativePath: `sources/source-1/images/001-${firstHash.slice(0, 12)}.jpg`,
      contentHash: firstHash,
      mime: "image/jpeg",
      size: jpg.byteLength,
      width: null,
      height: null,
      durationMs: null,
    });

    for (const asset of result.assetInputs) {
      const bytes = readVaultFile(asset.input.relativePath);
      expect(sha256(bytes)).toBe(asset.input.contentHash);
    }
  });

  it("skips bad image candidates without failing the surrounding article import", async () => {
    const good = gifBytes("good-gif");
    const fetchImpl = imageFetch({
      "https://cdn.example/vector.svg": {
        body: Buffer.from("<svg></svg>"),
        contentType: "image/svg+xml",
      },
      "https://cdn.example/huge.png": {
        body: pngBytes("declared huge"),
        contentType: "image/png",
        contentLength: ARTICLE_IMAGE_MAX_IMAGE_BYTES + 1,
      },
      "https://cdn.example/good.gif": { body: good, contentType: "image/gif" },
    });

    const result = await importArticleImages({
      html: `<article>
        <p>kept text</p>
        <img src="data:image/png;base64,AAAA">
        <img src="http://127.0.0.1/private.png">
        <img src="https://cdn.example/vector.svg">
        <img src="https://cdn.example/huge.png">
        <img src="https://cdn.example/good.gif" alt="good">
      </article>`,
      articleUrl: "https://example.com/read",
      sourceId: "source-2" as ElementId,
      assetsDir,
      fetchImpl,
    });

    expect(result.assetInputs).toHaveLength(1);
    expect(result.html).toContain("kept text");
    expect(result.html).toContain("article-image://source-2/");
    expect(result.html).toContain('alt="good"');
    expect(result.html).not.toContain("data:image");
    expect(result.html).not.toContain("127.0.0.1");
    expect(result.html).not.toContain("vector.svg");
    expect(result.html).not.toContain("huge.png");
    expect(reasons(result)).toEqual([
      "blocked_url",
      "blocked_url",
      "unsupported_mime",
      "image_too_large",
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("enforces image count and total byte limits", async () => {
    const fetchImpl = imageFetch({
      "https://example.com/one.png": { body: pngBytes("one"), contentType: "image/png" },
      "https://example.com/two.png": { body: pngBytes("two"), contentType: "image/png" },
      "https://example.com/three.png": { body: pngBytes("three"), contentType: "image/png" },
    });

    const counted = await importArticleImages({
      html: `<img src="/one.png"><img src="/two.png"><img src="/three.png">`,
      articleUrl: "https://example.com/read",
      sourceId: "source-3" as ElementId,
      assetsDir,
      fetchImpl,
      maxImages: 2,
      maxTotalBytes: pngBytes("one").byteLength + 1,
      concurrency: 1,
    });

    expect(counted.assetInputs).toHaveLength(1);
    expect(reasons(counted)).toEqual(["total_limit", "count_limit"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(counted.html.match(/article-image:\/\/source-3\//g) ?? []).toHaveLength(1);
  });

  it("checks redirect targets before fetching private hosts", async () => {
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url !== "https://public.example/redirect.png") {
        throw new Error(`private target should not be fetched: ${url}`);
      }
      return new Response("", {
        status: 302,
        headers: { location: "http://127.0.0.1/private.png" },
      });
    });

    const result = await importArticleImages({
      html: `<p>x</p><img src="https://public.example/redirect.png">`,
      articleUrl: "https://example.com/read",
      sourceId: "source-4" as ElementId,
      assetsDir,
      fetchImpl,
    });

    expect(result.assetInputs).toEqual([]);
    expect(reasons(result)).toEqual(["blocked_url"]);
    expect(result.html).toBe("<p>x</p>");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(assetsDir, "sources"))).toBe(false);
  });

  it("deduplicates repeated image bytes within one article by sharing a vault path", async () => {
    const bytes = pngBytes("same-image");
    const fetchImpl = imageFetch({
      "https://example.com/a.png": { body: bytes, contentType: "image/png" },
      "https://example.com/b.png": { body: bytes, contentType: "image/png" },
    });

    const result = await importArticleImages({
      html: `<img src="/a.png"><img src="/b.png">`,
      articleUrl: "https://example.com/read",
      sourceId: "source-5" as ElementId,
      assetsDir,
      fetchImpl,
      concurrency: 1,
    });

    expect(result.assetInputs).toHaveLength(2);
    expect(result.assetInputs[0]?.id).not.toBe(result.assetInputs[1]?.id);
    expect(result.assetInputs[0]?.input.relativePath).toBe(
      result.assetInputs[1]?.input.relativePath,
    );
    expect(fs.readdirSync(path.join(assetsDir, "sources", "source-5", "images"))).toHaveLength(1);
  });

  it("limits concurrent image fetches", async () => {
    const sourceId = "source-6" as ElementId;
    const releases: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => {
        releases.push(() => {
          active -= 1;
          resolve();
        });
      });
      const body = pngBytes(url);
      const response = new Response(body, {
        headers: {
          "content-type": "image/png",
          "content-length": String(body.byteLength),
        },
      });
      Object.defineProperty(response, "url", { value: url });
      return response;
    }) as unknown as typeof fetch;
    const html = Array.from({ length: 8 }, (_, index) => `<img src="/${index}.png">`).join("");

    const pending = importArticleImages({
      html,
      articleUrl: "https://example.com/read",
      sourceId,
      assetsDir,
      fetchImpl,
    });

    await waitUntil(() => releases.length === 4);
    expect(maxActive).toBe(4);
    for (const release of releases.splice(0)) release();
    await waitUntil(() => releases.length === 4);
    expect(maxActive).toBe(4);
    for (const release of releases.splice(0)) release();

    const result = await pending;
    expect(fetchImpl).toHaveBeenCalledTimes(8);
    expect(result.assetInputs).toHaveLength(8);
    expect(maxActive).toBe(4);
  });

  it("rejects mislabeled non-image bytes even when the header is allowed", async () => {
    const fetchImpl = imageFetch({
      "https://example.com/fake.png": {
        body: Buffer.from("<svg><script>alert(1)</script></svg>"),
        contentType: "image/png",
      },
    });

    const result = await importArticleImages({
      html: `<img src="/fake.png" alt="fake">`,
      articleUrl: "https://example.com/read",
      sourceId: "source-7" as ElementId,
      assetsDir,
      fetchImpl,
    });

    expect(result.assetInputs).toEqual([]);
    expect(reasons(result)).toEqual(["unsupported_mime"]);
    expect(result.html).toBe("");
  });

  it("times out a response whose body stalls after headers", async () => {
    const fetchImpl = vi.fn(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(PNG_SIGNATURE);
        },
      });
      return new Response(stream, {
        headers: { "content-type": "image/png" },
      });
    }) as unknown as typeof fetch;

    const result = await importArticleImages({
      html: `<img src="/slow.png" alt="slow">`,
      articleUrl: "https://example.com/read",
      sourceId: "source-8" as ElementId,
      assetsDir,
      fetchImpl,
      timeoutMs: 10,
    });

    expect(result.assetInputs).toEqual([]);
    expect(reasons(result)).toEqual(["timeout"]);
  });

  it("does not fail the article on invalid numeric entities in image attrs", async () => {
    const bytes = pngBytes("entity");
    const fetchImpl = imageFetch({
      "https://example.com/entity.png": { body: bytes, contentType: "image/png" },
    });

    const result = await importArticleImages({
      html: `<p>before</p><img src="/entity.png" alt="bad &#x110000;">`,
      articleUrl: "https://example.com/read",
      sourceId: "source-9" as ElementId,
      assetsDir,
      fetchImpl,
    });

    expect(result.assetInputs).toHaveLength(1);
    expect(result.html).toContain("article-image://source-9/");
  });
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for condition");
}
