/**
 * Pure, DB-free URL fetch for web import (T058 / T060).
 *
 * This is the SINGLE implementation of the import fetch: scheme + SSRF guard
 * (entered AND post-redirect final url), redirect following, a timeout, a
 * non-HTML reject, and an 8 MB body-size cap (streaming-measured). It returns the
 * raw HTML + the final (post-redirect) url, or throws a {@link UrlFetchError}
 * with a typed `code`.
 *
 * It has NO database, NO asset vault, NO repository — only `node:fetch` + the
 * pure host-classification helpers. That is exactly why the background-runner
 * `utilityProcess` WORKER (which must never open SQLite) can import it: the worker
 * does the fetch off-main and posts the HTML back, then MAIN runs the snapshot +
 * createSource pipeline through the existing repositories. `UrlImportService`
 * (main side) ALSO delegates here, so the worker and the inline path share one
 * SSRF/timeout/cap implementation and can never drift.
 */

import { isBlockedImportHost, isImportableScheme } from "./url-import-host";

/** The friendly error codes the IPC layer maps to a user-facing message. */
export type UrlFetchErrorCode =
  | "fetch_failed"
  | "timeout"
  | "not_html"
  | "too_large"
  | "http_error"
  | "blocked_host";

/** A typed fetch failure carrying a `code` the IPC layer maps to a friendly line. */
export class UrlFetchError extends Error {
  readonly code: UrlFetchErrorCode;
  constructor(code: UrlFetchErrorCode, message: string) {
    super(message);
    this.name = "UrlFetchError";
    this.code = code;
  }
}

/** Fetch tuning. Conservative defaults; not configurable at the surface. */
export const FETCH_TIMEOUT_MS = 15_000;
export const MAX_BODY_BYTES = 8 * 1024 * 1024; // 8 MB cap on the fetched body.
export const MAX_IMPORT_REDIRECTS = 5;
const USER_AGENT = "Interleave/0.1 (+https://interleave.app; desktop import)";

/** Options for {@link fetchImportablePage}. */
export interface FetchImportablePageOptions {
  /**
   * Permit loopback / private hosts (DEV/E2E ONLY). The E2E serves its article
   * fixture from a 127.0.0.1 HTTP server, which the SSRF guard normally blocks;
   * the harness sets this so the test can reach it. NEVER true in a packaged app.
   */
  readonly allowLoopback?: boolean;
  /** The fetch implementation (defaults to the Node global). Injectable for tests. */
  readonly fetchImpl?: typeof fetch;
}

export interface FetchImportableResponseOptions {
  readonly allowLoopback?: boolean;
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly headers?: RequestInit["headers"];
}

/** Parse + validate a URL against the scheme + SSRF guard; throws on rejection. */
export function assertImportableUrl(raw: string, allowLoopback: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UrlFetchError("fetch_failed", `Not a valid URL: ${raw}`);
  }
  if (!isImportableScheme(url.protocol)) {
    throw new UrlFetchError("blocked_host", `Unsupported scheme: ${url.protocol}`);
  }
  if (!allowLoopback && isBlockedImportHost(url.hostname)) {
    throw new UrlFetchError("blocked_host", `Refusing to fetch a private host: ${url.hostname}`);
  }
  return url;
}

function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

function resolveRedirectLocation(
  response: Response,
  currentUrl: string,
  allowLoopback: boolean,
): string {
  const location = response.headers.get("location");
  if (!location) {
    throw new UrlFetchError("http_error", `Redirect from ${currentUrl} did not include Location`);
  }
  let next: string;
  try {
    next = new URL(location, currentUrl).href;
  } catch {
    throw new UrlFetchError("fetch_failed", `Redirect from ${currentUrl} is not a valid URL`);
  }
  return assertImportableUrl(next, allowLoopback).href;
}

/**
 * Fetch a URL with bounded manual redirects. Each redirect target is validated
 * before the next request is issued, so a public URL cannot redirect the importer
 * into a private host before the SSRF guard runs.
 */
export async function fetchImportableResponse(
  entered: string,
  options: FetchImportableResponseOptions = {},
): Promise<{ response: Response; finalUrl: string }> {
  const allowLoopback = options.allowLoopback ?? false;
  const fetchImpl = options.fetchImpl ?? fetch;
  let currentUrl = assertImportableUrl(entered, allowLoopback).href;

  for (let redirects = 0; redirects <= MAX_IMPORT_REDIRECTS; redirects += 1) {
    let response: Response;
    try {
      const init: RequestInit = { redirect: "manual" };
      if (options.signal) init.signal = options.signal;
      if (options.headers) init.headers = options.headers;
      response = await fetchImpl(currentUrl, init);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new UrlFetchError("timeout", `Timed out fetching ${currentUrl}`);
      }
      throw new UrlFetchError("fetch_failed", `Could not reach ${currentUrl}`);
    }

    if (!isRedirectStatus(response.status)) {
      const finalUrl = response.url || currentUrl;
      return { response, finalUrl: assertImportableUrl(finalUrl, allowLoopback).href };
    }

    if (redirects === MAX_IMPORT_REDIRECTS) {
      throw new UrlFetchError("http_error", `Too many redirects while fetching ${entered}`);
    }
    currentUrl = resolveRedirectLocation(response, currentUrl, allowLoopback);
  }

  throw new UrlFetchError("http_error", `Too many redirects while fetching ${entered}`);
}

/** Read a response body, aborting if it exceeds the size cap (streaming-measured). */
async function readCappedBody(response: Response): Promise<Uint8Array> {
  const body = response.body;
  if (!body) {
    // No stream (e.g. a mocked Response): fall back to the buffered read + cap.
    const buf = new Uint8Array(await response.arrayBuffer());
    if (buf.byteLength > MAX_BODY_BYTES) {
      throw new UrlFetchError("too_large", `Page exceeds ${MAX_BODY_BYTES} bytes`);
    }
    return buf;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new UrlFetchError("too_large", `Page exceeds ${MAX_BODY_BYTES} bytes`);
      }
      chunks.push(value);
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Fetch the page: scheme + SSRF guard (entered AND final url), redirect
 * following, timeout, non-HTML reject, and an 8 MB body-size cap. Returns the raw
 * HTML + the final (post-redirect) url. Throws a {@link UrlFetchError} on any
 * network/scheme/SSRF/size/non-HTML failure.
 */
export async function fetchImportablePage(
  entered: string,
  options: FetchImportablePageOptions = {},
): Promise<{ html: string; finalUrl: string }> {
  const allowLoopback = options.allowLoopback ?? false;
  const fetchImpl = options.fetchImpl ?? fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const { response, finalUrl } = await fetchImportableResponse(entered, {
      allowLoopback,
      fetchImpl,
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
    });

    if (!response.ok) {
      throw new UrlFetchError("http_error", `Server returned ${response.status} for ${entered}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
    // An absent content-type (mime === "") is intentionally permitted: many
    // servers omit the header. A genuinely non-article payload then yields an
    // empty Readability result and still produces a (capture-never-lost) source.
    if (mime !== "" && mime !== "text/html" && mime !== "application/xhtml+xml") {
      throw new UrlFetchError("not_html", `That page is not an article (${mime || "unknown"})`);
    }

    // Enforce the declared content-length cap up front when present.
    const declared = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      throw new UrlFetchError("too_large", `Page exceeds ${MAX_BODY_BYTES} bytes`);
    }

    const bytes = await readCappedBody(response);
    const html = new TextDecoder("utf-8").decode(bytes);
    return { html, finalUrl };
  } finally {
    clearTimeout(timer);
  }
}
