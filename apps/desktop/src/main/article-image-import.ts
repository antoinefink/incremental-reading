import fs from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { AssetId, ElementId } from "@interleave/core";
import { type CreateAssetInput, newAssetId } from "@interleave/local-db";
import {
  assertImportableUrl,
  FETCH_TIMEOUT_MS,
  fetchImportableResponse,
  UrlFetchError,
} from "./url-fetch";
import { writeStreamedToVault } from "./vault-io";

export const ARTICLE_IMAGE_MAX_IMAGES = 60;
export const ARTICLE_IMAGE_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const ARTICLE_IMAGE_MAX_TOTAL_BYTES = 50 * 1024 * 1024;
export const ARTICLE_IMAGE_CONCURRENCY = 4;

const ARTICLE_IMAGE_USER_AGENT = "Interleave/0.1 (+https://interleave.app; article images)";
const HASH_PREFIX_LENGTH = 12;
const MAX_TEXT_ATTR_CHARS = 512;

const IMAGE_MIME_EXTENSIONS = new Map<string, string>([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
]);

export type ArticleImageSkipReason =
  | "missing_url"
  | "blocked_url"
  | "malformed_url"
  | "fetch_failed"
  | "timeout"
  | "http_error"
  | "unsupported_mime"
  | "image_too_large"
  | "total_limit"
  | "count_limit"
  | "write_failed";

export interface ArticleImageImportInput {
  /** Readability article HTML, before sanitizer/schema conversion. */
  readonly html: string;
  /** Final page URL used as the base for relative and protocol-relative image URLs. */
  readonly articleUrl: string;
  /** Pre-minted source element id; image paths and protocol URLs are source-scoped. */
  readonly sourceId: ElementId | string;
  /** Absolute `<dataDir>/assets` vault root. */
  readonly assetsDir: string;
  /** DEV/E2E only, matching url-fetch's loopback escape hatch. */
  readonly allowLoopback?: boolean;
  readonly fetchImpl?: typeof fetch;
  readonly maxImages?: number;
  readonly maxImageBytes?: number;
  readonly maxTotalBytes?: number;
  readonly concurrency?: number;
  readonly timeoutMs?: number;
}

export interface ArticleImageAssetMetadataInput {
  /** Pre-minted asset id used in the rewritten `article-image://` URL. */
  readonly id: AssetId;
  /** Metadata row values to insert with the same id inside the source transaction. */
  readonly input: CreateAssetInput;
  /** Original resolved candidate URL before redirects. */
  readonly sourceUrl: string;
  /** Final URL after redirects, re-checked by the import host guard. */
  readonly finalUrl: string;
  readonly protocolUrl: string;
  readonly ordinal: number;
}

export interface ArticleImageSkip {
  readonly ordinal: number;
  readonly reason: ArticleImageSkipReason;
  readonly sourceUrl: string | null;
  readonly message: string;
}

export interface ArticleImageImportResult {
  readonly html: string;
  readonly assetInputs: readonly ArticleImageAssetMetadataInput[];
  readonly skipped: readonly ArticleImageSkip[];
}

interface ImageTag {
  readonly ordinal: number;
  readonly start: number;
  readonly end: number;
  readonly attrs: ReadonlyMap<string, string>;
}

interface ImportLimits {
  readonly maxImages: number;
  readonly maxImageBytes: number;
  readonly maxTotalBytes: number;
  readonly concurrency: number;
  readonly timeoutMs: number;
}

interface SharedImportState {
  totalBytes: number;
  readonly byHash: Map<string, ArticleImageAssetMetadataInput>;
}

interface ProcessedTag {
  readonly ordinal: number;
  readonly replacement: string;
  readonly asset: ArticleImageAssetMetadataInput | null;
  readonly skip: ArticleImageSkip | null;
}

interface Candidate {
  readonly rawUrl: string;
  readonly score: number;
  readonly order: number;
}

interface BudgetedStream {
  readonly stream: NodeJS.ReadableStream;
  readonly release: () => void;
}

class ImageSkipError extends Error {
  readonly reason: ArticleImageSkipReason;
  readonly sourceUrl: string | null;

  constructor(reason: ArticleImageSkipReason, message: string, sourceUrl: string | null) {
    super(message);
    this.name = "ImageSkipError";
    this.reason = reason;
    this.sourceUrl = sourceUrl;
  }
}

export async function importArticleImages(
  input: ArticleImageImportInput,
): Promise<ArticleImageImportResult> {
  const allowLoopback = input.allowLoopback ?? false;
  const sourceId = assertSafePathSegment(String(input.sourceId), "sourceId");
  const assetsDir = path.resolve(input.assetsDir);
  const fetchImpl = input.fetchImpl ?? fetch;
  const limits: ImportLimits = {
    maxImages: input.maxImages ?? ARTICLE_IMAGE_MAX_IMAGES,
    maxImageBytes: input.maxImageBytes ?? ARTICLE_IMAGE_MAX_IMAGE_BYTES,
    maxTotalBytes: input.maxTotalBytes ?? ARTICLE_IMAGE_MAX_TOTAL_BYTES,
    concurrency: input.concurrency ?? ARTICLE_IMAGE_CONCURRENCY,
    timeoutMs: input.timeoutMs ?? FETCH_TIMEOUT_MS,
  };
  assertPositiveLimit(limits.maxImages, "maxImages");
  assertPositiveLimit(limits.maxImageBytes, "maxImageBytes");
  assertPositiveLimit(limits.maxTotalBytes, "maxTotalBytes");
  assertPositiveLimit(limits.concurrency, "concurrency");
  assertPositiveLimit(limits.timeoutMs, "timeoutMs");

  const baseUrl = assertImportableUrl(input.articleUrl, allowLoopback);
  const tags = findImageTags(input.html);
  if (tags.length === 0) return { html: input.html, assetInputs: [], skipped: [] };

  const state: SharedImportState = { totalBytes: 0, byHash: new Map() };
  const withinLimit = tags.slice(0, limits.maxImages);
  const overLimit = tags.slice(limits.maxImages).map<ProcessedTag>((tag) => ({
    ordinal: tag.ordinal,
    replacement: "",
    asset: null,
    skip: {
      ordinal: tag.ordinal,
      reason: "count_limit",
      sourceUrl: firstRawImageUrl(tag.attrs),
      message: `Skipping article image ${tag.ordinal}: image count limit exceeded`,
    },
  }));

  const processed = await runLimited(withinLimit, limits.concurrency, (tag) =>
    processImageTag({
      tag,
      baseUrl,
      sourceId,
      assetsDir,
      allowLoopback,
      fetchImpl,
      limits,
      state,
    }),
  );
  const byOrdinal = new Map<number, ProcessedTag>(
    [...processed, ...overLimit].map((item) => [item.ordinal, item]),
  );

  return {
    html: rewriteImageTags(input.html, tags, byOrdinal),
    assetInputs: processed.flatMap((item) => (item.asset ? [item.asset] : [])),
    skipped: [...processed, ...overLimit].flatMap((item) => (item.skip ? [item.skip] : [])),
  };
}

async function processImageTag(input: {
  readonly tag: ImageTag;
  readonly baseUrl: URL;
  readonly sourceId: string;
  readonly assetsDir: string;
  readonly allowLoopback: boolean;
  readonly fetchImpl: typeof fetch;
  readonly limits: ImportLimits;
  readonly state: SharedImportState;
}): Promise<ProcessedTag> {
  const candidates = imageCandidates(input.tag.attrs);
  if (candidates.length === 0) {
    return {
      ordinal: input.tag.ordinal,
      replacement: "",
      asset: null,
      skip: {
        ordinal: input.tag.ordinal,
        reason: "missing_url",
        sourceUrl: null,
        message: `Skipping article image ${input.tag.ordinal}: no usable src or srcset`,
      },
    };
  }

  let lastError: ImageSkipError | null = null;
  for (const candidate of candidates) {
    try {
      const imported = await importOneCandidate({
        rawUrl: candidate.rawUrl,
        tag: input.tag,
        baseUrl: input.baseUrl,
        sourceId: input.sourceId,
        assetsDir: input.assetsDir,
        allowLoopback: input.allowLoopback,
        fetchImpl: input.fetchImpl,
        limits: input.limits,
        state: input.state,
      });
      return {
        ordinal: input.tag.ordinal,
        replacement: buildImageTag(imported.protocolUrl, input.tag.attrs),
        asset: imported,
        skip: null,
      };
    } catch (err) {
      if (err instanceof ImageSkipError) {
        lastError = err;
        continue;
      }
      lastError = new ImageSkipError(
        "fetch_failed",
        err instanceof Error ? err.message : "Image import failed",
        candidate.rawUrl,
      );
    }
  }

  return {
    ordinal: input.tag.ordinal,
    replacement: "",
    asset: null,
    skip: {
      ordinal: input.tag.ordinal,
      reason: lastError?.reason ?? "fetch_failed",
      sourceUrl: lastError?.sourceUrl ?? null,
      message:
        lastError?.message ?? `Skipping article image ${input.tag.ordinal}: image import failed`,
    },
  };
}

async function importOneCandidate(input: {
  readonly rawUrl: string;
  readonly tag: ImageTag;
  readonly baseUrl: URL;
  readonly sourceId: string;
  readonly assetsDir: string;
  readonly allowLoopback: boolean;
  readonly fetchImpl: typeof fetch;
  readonly limits: ImportLimits;
  readonly state: SharedImportState;
}): Promise<ArticleImageAssetMetadataInput> {
  const sourceUrl = resolveAndGuardUrl(input.rawUrl, input.baseUrl, input.allowLoopback);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.limits.timeoutMs);

  try {
    const { response, finalUrl } = await fetchImage({
      url: sourceUrl,
      fetchImpl: input.fetchImpl,
      allowLoopback: input.allowLoopback,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new ImageSkipError("http_error", `Image server returned ${response.status}`, sourceUrl);
    }

    const declaredMime = allowedImageMime(response.headers.get("content-type"), sourceUrl);
    const declaredSize = parseContentLength(response.headers.get("content-length"));
    if (declaredSize != null && declaredSize > input.limits.maxImageBytes) {
      throw new ImageSkipError(
        "image_too_large",
        `Image exceeds ${input.limits.maxImageBytes} bytes`,
        sourceUrl,
      );
    }
    if (
      declaredSize != null &&
      input.state.totalBytes + declaredSize > input.limits.maxTotalBytes
    ) {
      throw new ImageSkipError(
        "total_limit",
        `Article image budget exceeds ${input.limits.maxTotalBytes} bytes`,
        sourceUrl,
      );
    }

    const assetId = newAssetId();
    const ordinal = input.tag.ordinal;
    const stagingRel = `sources/${input.sourceId}/images/.${formatOrdinal(ordinal)}-${assetId}.download`;
    const stagingAbs = resolveVaultPath(input.assetsDir, stagingRel);
    const body = await responseBody(response);
    const budgeted = capStream(body, input.state, input.limits, sourceUrl, controller.signal);

    let written: { readonly contentHash: string; readonly size: number };
    try {
      written = await writeStreamedToVault({
        source: budgeted.stream,
        destAbsPath: stagingAbs,
      });
    } catch (err) {
      budgeted.release();
      await fs.rm(stagingAbs, { force: true }).catch(() => {});
      if (err instanceof ImageSkipError) throw err;
      if (controller.signal.aborted || isAbortError(err)) {
        throw new ImageSkipError("timeout", `Timed out fetching image ${sourceUrl}`, sourceUrl);
      }
      throw new ImageSkipError(
        "write_failed",
        err instanceof Error ? err.message : "Could not write image to the asset vault",
        sourceUrl,
      );
    }

    let mime: string;
    try {
      mime = await sniffAllowedImageMime(stagingAbs, sourceUrl);
      if (mime !== declaredMime) {
        throw new ImageSkipError(
          "unsupported_mime",
          `Image MIME mismatch: declared ${declaredMime}, bytes are ${mime}`,
          sourceUrl,
        );
      }
    } catch (err) {
      budgeted.release();
      await fs.rm(stagingAbs, { force: true }).catch(() => {});
      if (err instanceof ImageSkipError) throw err;
      throw new ImageSkipError(
        "unsupported_mime",
        err instanceof Error ? err.message : "Could not validate downloaded image bytes",
        sourceUrl,
      );
    }

    const duplicate = input.state.byHash.get(written.contentHash) ?? null;
    const protocolUrl = `article-image://${input.sourceId}/${assetId}`;
    if (duplicate) {
      await fs.rm(stagingAbs, { force: true }).catch(() => {});
      return {
        id: assetId,
        input: {
          ...duplicate.input,
          owningElementId: input.sourceId as ElementId,
          width: null,
          height: null,
        },
        sourceUrl,
        finalUrl,
        protocolUrl,
        ordinal,
      };
    }

    const ext = extensionForMime(mime);
    const finalRel = `sources/${input.sourceId}/images/${formatOrdinal(ordinal)}-${written.contentHash.slice(
      0,
      HASH_PREFIX_LENGTH,
    )}.${ext}`;
    const finalAbs = resolveVaultPath(input.assetsDir, finalRel);
    try {
      await fs.rename(stagingAbs, finalAbs);
    } catch (err) {
      budgeted.release();
      await fs.rm(stagingAbs, { force: true }).catch(() => {});
      throw new ImageSkipError(
        "write_failed",
        err instanceof Error ? err.message : "Could not finalize image in the asset vault",
        sourceUrl,
      );
    }

    const imported: ArticleImageAssetMetadataInput = {
      id: assetId,
      input: {
        owningElementId: input.sourceId as ElementId,
        kind: "image",
        vaultRoot: "assets",
        relativePath: finalRel,
        contentHash: written.contentHash,
        mime,
        size: written.size,
        width: null,
        height: null,
        durationMs: null,
      },
      sourceUrl,
      finalUrl,
      protocolUrl,
      ordinal,
    };
    input.state.byHash.set(written.contentHash, imported);
    return imported;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchImage(input: {
  readonly url: string;
  readonly fetchImpl: typeof fetch;
  readonly allowLoopback: boolean;
  readonly signal: AbortSignal;
}): Promise<{ readonly response: Response; readonly finalUrl: string }> {
  try {
    return await fetchImportableResponse(input.url, {
      allowLoopback: input.allowLoopback,
      fetchImpl: input.fetchImpl,
      signal: input.signal,
      headers: {
        "User-Agent": ARTICLE_IMAGE_USER_AGENT,
        Accept: "image/jpeg,image/png,image/webp,image/gif",
      },
    });
  } catch (err) {
    if (err instanceof UrlFetchError) throw toFetchSkipError(err, input.url);
    if (isAbortError(err)) {
      throw new ImageSkipError("timeout", `Timed out fetching image ${input.url}`, input.url);
    }
    throw new ImageSkipError("fetch_failed", `Could not fetch image ${input.url}`, input.url);
  }
}

function resolveAndGuardUrl(rawUrl: string, baseUrl: URL, allowLoopback: boolean): string {
  let resolved: string;
  try {
    resolved = new URL(rawUrl.trim(), baseUrl).href;
  } catch (err) {
    throw new ImageSkipError(
      "malformed_url",
      err instanceof Error ? err.message : `Malformed image URL: ${rawUrl}`,
      rawUrl,
    );
  }
  try {
    return assertImportableUrl(resolved, allowLoopback).href;
  } catch (err) {
    throw toUrlSkipError(err, resolved);
  }
}

function toUrlSkipError(err: unknown, sourceUrl: string): ImageSkipError {
  if (err instanceof UrlFetchError) {
    return toFetchSkipError(err, sourceUrl);
  }
  return new ImageSkipError(
    "malformed_url",
    err instanceof Error ? err.message : `Malformed image URL: ${sourceUrl}`,
    sourceUrl,
  );
}

function toFetchSkipError(err: UrlFetchError, sourceUrl: string): ImageSkipError {
  if (err.code === "timeout") {
    return new ImageSkipError("timeout", err.message, sourceUrl);
  }
  if (err.code === "fetch_failed") {
    return new ImageSkipError("fetch_failed", err.message, sourceUrl);
  }
  if (err.code === "http_error") {
    return new ImageSkipError("http_error", err.message, sourceUrl);
  }
  if (err.code === "blocked_host") {
    return new ImageSkipError("blocked_url", err.message, sourceUrl);
  }
  return new ImageSkipError("malformed_url", err.message, sourceUrl);
}

function allowedImageMime(contentType: string | null, sourceUrl: string): string {
  const mime = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!IMAGE_MIME_EXTENSIONS.has(mime)) {
    throw new ImageSkipError(
      "unsupported_mime",
      `Unsupported article image MIME type: ${mime || "unknown"}`,
      sourceUrl,
    );
  }
  return mime;
}

async function sniffAllowedImageMime(absPath: string, sourceUrl: string): Promise<string> {
  const handle = await fs.open(absPath, "r");
  try {
    const bytes = Buffer.alloc(16);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const head = bytes.subarray(0, bytesRead);
    if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
      return "image/jpeg";
    }
    if (
      head.length >= 8 &&
      head[0] === 0x89 &&
      head[1] === 0x50 &&
      head[2] === 0x4e &&
      head[3] === 0x47 &&
      head[4] === 0x0d &&
      head[5] === 0x0a &&
      head[6] === 0x1a &&
      head[7] === 0x0a
    ) {
      return "image/png";
    }
    const ascii = head.toString("ascii");
    if (ascii.startsWith("GIF87a") || ascii.startsWith("GIF89a")) {
      return "image/gif";
    }
    if (head.length >= 12 && ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") {
      return "image/webp";
    }
  } finally {
    await handle.close();
  }
  throw new ImageSkipError(
    "unsupported_mime",
    "Downloaded bytes are not an allowed image",
    sourceUrl,
  );
}

function extensionForMime(mime: string): string {
  const ext = IMAGE_MIME_EXTENSIONS.get(mime);
  if (!ext) throw new Error(`Unsupported article image MIME type: ${mime}`);
  return ext;
}

function parseContentLength(raw: string | null): number | null {
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

async function responseBody(response: Response): Promise<NodeJS.ReadableStream> {
  if (response.body) {
    return Readable.fromWeb(response.body as WebReadableStream<Uint8Array>);
  }
  return Readable.from(Buffer.from(await response.arrayBuffer()));
}

function capStream(
  source: NodeJS.ReadableStream,
  state: SharedImportState,
  limits: ImportLimits,
  sourceUrl: string,
  signal: AbortSignal,
): BudgetedStream {
  let imageBytes = 0;
  let countedBytes = 0;
  const destroySource = (): void => {
    const destroy = (source as { destroy?: (error?: Error) => void }).destroy;
    if (typeof destroy === "function") {
      destroy.call(source);
    }
  };
  const cap = new Transform({
    transform(chunk: Buffer | Uint8Array | string, _encoding, callback) {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
      const nextImageBytes = imageBytes + bytes.byteLength;
      if (nextImageBytes > limits.maxImageBytes) {
        callback(
          new ImageSkipError(
            "image_too_large",
            `Image exceeds ${limits.maxImageBytes} bytes`,
            sourceUrl,
          ),
        );
        return;
      }
      if (state.totalBytes + bytes.byteLength > limits.maxTotalBytes) {
        callback(
          new ImageSkipError(
            "total_limit",
            `Article image budget exceeds ${limits.maxTotalBytes} bytes`,
            sourceUrl,
          ),
        );
        return;
      }
      imageBytes = nextImageBytes;
      countedBytes += bytes.byteLength;
      state.totalBytes += bytes.byteLength;
      callback(null, bytes);
    },
  });
  cap.once("error", () => {
    destroySource();
  });
  const onAbort = (): void => {
    cap.destroy();
    destroySource();
  };
  if (signal.aborted) {
    onAbort();
  } else {
    signal.addEventListener("abort", onAbort, { once: true });
    cap.once("close", () => signal.removeEventListener("abort", onAbort));
  }
  return {
    stream: source.pipe(cap),
    release: () => {
      state.totalBytes = Math.max(0, state.totalBytes - countedBytes);
      countedBytes = 0;
    },
  };
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function imageCandidates(attrs: ReadonlyMap<string, string>): readonly Candidate[] {
  const out: Candidate[] = [];
  const srcset = trimToNull(attrs.get("srcset"));
  if (srcset) out.push(...parseSrcset(srcset));

  const src = trimToNull(attrs.get("src"));
  if (src) out.push({ rawUrl: src, score: 0, order: out.length });

  const seen = new Set<string>();
  return out
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .filter((candidate) => {
      const key = candidate.rawUrl.trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function parseSrcset(srcset: string): Candidate[] {
  return splitSrcset(srcset).flatMap((entry, order) => {
    const trimmed = entry.trim();
    if (!trimmed) return [];
    const parts = trimmed.split(/\s+/);
    const rawUrl = parts[0];
    if (!rawUrl) return [];
    return [{ rawUrl, score: descriptorScore(parts[1] ?? ""), order }];
  });
}

function splitSrcset(srcset: string): string[] {
  const entries: string[] = [];
  let current = "";
  let parenDepth = 0;
  for (const char of srcset) {
    if (char === "(") parenDepth += 1;
    if (char === ")" && parenDepth > 0) parenDepth -= 1;
    if (char === "," && parenDepth === 0) {
      entries.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  entries.push(current);
  return entries;
}

function descriptorScore(descriptor: string): number {
  const trimmed = descriptor.trim().toLowerCase();
  if (trimmed.endsWith("w")) {
    const width = Number(trimmed.slice(0, -1));
    return Number.isFinite(width) && width > 0 ? width : 1;
  }
  if (trimmed.endsWith("x")) {
    const density = Number(trimmed.slice(0, -1));
    return Number.isFinite(density) && density > 0 ? density * 1000 : 1;
  }
  return 1;
}

function findImageTags(html: string): ImageTag[] {
  const tags: ImageTag[] = [];
  const lower = html.toLowerCase();
  let index = 0;
  while (index < html.length) {
    const start = lower.indexOf("<img", index);
    if (start === -1) break;
    const afterName = html[start + 4] ?? "";
    if (afterName && !/[\s/>]/.test(afterName)) {
      index = start + 4;
      continue;
    }
    const end = findTagEnd(html, start + 4);
    if (end === -1) break;
    const raw = html.slice(start, end);
    tags.push({
      ordinal: tags.length + 1,
      start,
      end,
      attrs: parseAttributes(raw),
    });
    index = end;
  }
  return tags;
}

function findTagEnd(html: string, start: number): number {
  let quote: '"' | "'" | null = null;
  for (let index = start; index < html.length; index += 1) {
    const char = html[index];
    if ((char === '"' || char === "'") && quote == null) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = null;
      continue;
    }
    if (char === ">" && quote == null) return index + 1;
  }
  return -1;
}

function parseAttributes(tag: string): ReadonlyMap<string, string> {
  const attrs = new Map<string, string>();
  let index = tag.search(/\s/);
  if (index === -1) return attrs;
  const limit = tag.endsWith(">") ? tag.length - 1 : tag.length;
  while (index < limit) {
    while (index < limit && /[\s/]/.test(tag[index] ?? "")) index += 1;
    const nameStart = index;
    while (index < limit && !/[\s=/>]/.test(tag[index] ?? "")) index += 1;
    const name = tag.slice(nameStart, index).toLowerCase();
    if (!name) break;
    while (index < limit && /\s/.test(tag[index] ?? "")) index += 1;
    let value = "";
    if (tag[index] === "=") {
      index += 1;
      while (index < limit && /\s/.test(tag[index] ?? "")) index += 1;
      const quote = tag[index];
      if (quote === '"' || quote === "'") {
        index += 1;
        const valueStart = index;
        while (index < limit && tag[index] !== quote) index += 1;
        value = tag.slice(valueStart, index);
        if (tag[index] === quote) index += 1;
      } else {
        const valueStart = index;
        while (index < limit && !/[\s/>]/.test(tag[index] ?? "")) index += 1;
        value = tag.slice(valueStart, index);
      }
    }
    attrs.set(name, decodeHtmlAttribute(value));
  }
  return attrs;
}

function rewriteImageTags(
  html: string,
  tags: readonly ImageTag[],
  replacements: ReadonlyMap<number, ProcessedTag>,
): string {
  let out = "";
  let cursor = 0;
  for (const tag of tags) {
    out += html.slice(cursor, tag.start);
    out += replacements.get(tag.ordinal)?.replacement ?? "";
    cursor = tag.end;
  }
  out += html.slice(cursor);
  return out;
}

function buildImageTag(protocolUrl: string, attrs: ReadonlyMap<string, string>): string {
  const rendered = [`src="${escapeHtmlAttribute(protocolUrl)}"`];
  const alt = safeTextAttr(attrs.get("alt"));
  if (alt != null) rendered.push(`alt="${escapeHtmlAttribute(alt)}"`);
  const title = safeTextAttr(attrs.get("title"));
  if (title != null) rendered.push(`title="${escapeHtmlAttribute(title)}"`);
  const { width, height } = imageDimensions(attrs);
  if (width != null) rendered.push(`width="${width}"`);
  if (height != null) rendered.push(`height="${height}"`);
  return `<img ${rendered.join(" ")}>`;
}

function imageDimensions(attrs: ReadonlyMap<string, string>): {
  width: number | null;
  height: number | null;
} {
  return {
    width: parseDimension(attrs.get("width")),
    height: parseDimension(attrs.get("height")),
  };
}

function parseDimension(value: string | undefined): number | null {
  const trimmed = value?.trim() ?? "";
  if (!/^\d{1,6}$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return parsed > 0 && parsed <= 100_000 ? parsed : null;
}

function safeTextAttr(value: string | undefined): string | null {
  const trimmed = trimToNull(value);
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_TEXT_ATTR_CHARS);
}

function trimToNull(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function firstRawImageUrl(attrs: ReadonlyMap<string, string>): string | null {
  const src = trimToNull(attrs.get("src"));
  if (src) return src;
  const srcset = trimToNull(attrs.get("srcset"));
  return srcset ? (parseSrcset(srcset)[0]?.rawUrl ?? null) : null;
}

function formatOrdinal(ordinal: number): string {
  return String(ordinal).padStart(3, "0");
}

function resolveVaultPath(assetsDir: string, relativePath: string): string {
  const root = path.resolve(assetsDir);
  const abs = path.resolve(root, ...relativePath.split("/"));
  if (abs !== root && !abs.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Article image path escapes asset vault: ${relativePath}`);
  }
  return abs;
}

function assertSafePathSegment(value: string, label: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`Invalid ${label} for article image path: ${value}`);
  }
  return value;
}

function assertPositiveLimit(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

async function runLimited<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function runWorker(): Promise<void> {
    while (true) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item == null) return;
      results[index] = await worker(item);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker());
  await Promise.all(workers);
  return results;
}

function decodeHtmlAttribute(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|amp|quot|apos|lt|gt);/gi, (entity, body: string) => {
    const lower = body.toLowerCase();
    if (lower === "amp") return "&";
    if (lower === "quot") return '"';
    if (lower === "apos") return "'";
    if (lower === "lt") return "<";
    if (lower === "gt") return ">";
    if (lower.startsWith("#x")) {
      const codePoint = Number.parseInt(lower.slice(2), 16);
      return isValidCodePoint(codePoint) ? String.fromCodePoint(codePoint) : entity;
    }
    if (lower.startsWith("#")) {
      const codePoint = Number.parseInt(lower.slice(1), 10);
      return isValidCodePoint(codePoint) ? String.fromCodePoint(codePoint) : entity;
    }
    return entity;
  });
}

function isValidCodePoint(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff;
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
