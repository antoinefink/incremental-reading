/**
 * UrlImportService (T060) — the local-first web-import orchestrator (main side).
 *
 * The ONE place the pure `@interleave/importers` transforms, the filesystem asset
 * vault, and the `local-db` repositories are composed for URL import. It runs
 * ENTIRELY in the Electron main process: it fetches the page (with a timeout, a
 * body-size cap, an SSRF/redirect guard, and a non-HTML reject), extracts the
 * readable article (Readability), sanitizes it, converts it to the constrained
 * ProseMirror doc, writes BOTH `original.html` + `cleaned.html` into the vault
 * (content-hashed `AssetRepository` metadata; bytes NEVER touch SQLite), and
 * creates an `inbox` source through the existing source pipeline — all in ONE
 * transaction appending the right operation_log entries.
 *
 * Construction-time injection (binding on M13): `new UrlImportService({ db,
 * repositories, assetsDir })`. The renderer IPC handler AND M13's loopback
 * capture server receive the SAME built instance, so both callers share one
 * fully-wired service without going through the renderer. The renderer never
 * fetches, never builds the doc, and never touches the vault.
 *
 * `importFromUrl` fetches first; `importFromHtml` (M12 owns this — the M13
 * extension "save page" entry point) skips the fetch and runs the identical
 * step 2–6 pipeline over supplied HTML. Both produce IDENTICAL sources.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  canonicalizeUrl,
  type ElementId,
  type PlainTextConversion,
  type PriorityLabel,
  priorityFromLabel,
} from "@interleave/core";
import type { InterleaveDatabase } from "@interleave/db";
import { extractArticle, htmlToProseMirrorDoc, sanitizeArticleHtml } from "@interleave/importers";
import {
  type AssetRepository,
  type InboxItemSummary,
  InboxQuery,
  newElementId,
  type Repositories,
  type SourceRepository,
} from "@interleave/local-db";
import { sha256 } from "./backup-manifest";
import { isBlockedImportHost, isImportableScheme } from "./url-import-host";

/** The friendly error codes the IPC layer maps to a user-facing message. */
export type UrlImportErrorCode =
  | "fetch_failed"
  | "timeout"
  | "not_html"
  | "too_large"
  | "http_error"
  | "blocked_host";

/** A typed import failure carrying a `code` the IPC layer maps to a friendly line. */
export class UrlImportError extends Error {
  readonly code: UrlImportErrorCode;
  constructor(code: UrlImportErrorCode, message: string) {
    super(message);
    this.name = "UrlImportError";
    this.code = code;
  }
}

/** A discriminated import result. T060 always returns `"imported"`; T061 adds `"duplicate"`. */
export type UrlImportResult = {
  readonly status: "imported";
  readonly id: string;
  readonly item: InboxItemSummary;
};

/** Constructor dependencies (injected once; shared by the IPC + loopback callers). */
export interface UrlImportServiceDeps {
  /** The open Drizzle database (for the atomic source+asset transaction). */
  readonly db: InterleaveDatabase;
  /** The repository bag bound to the same DB. */
  readonly repositories: Repositories;
  /** The asset-vault root (`<dataDir>/assets`). */
  readonly assetsDir: string;
  /**
   * The fetch implementation (defaults to the Node global `fetch`). Injectable so
   * the service test can mock the network without a live server.
   */
  readonly fetchImpl?: typeof fetch;
  /**
   * Permit loopback / private hosts (DEV/E2E ONLY). The E2E serves its article
   * fixture from a `127.0.0.1` HTTP server, which the SSRF guard normally blocks;
   * the harness sets this so the test can reach it. NEVER true in a packaged app —
   * `bootstrap()` only forwards it from `INTERLEAVE_ALLOW_LOOPBACK_IMPORT` when
   * `!app.isPackaged` (mirrors the `INTERLEAVE_DATA_DIR` override discipline).
   */
  readonly allowLoopback?: boolean;
}

/** Arguments to {@link UrlImportService.importFromUrl}. */
export interface ImportFromUrlInput {
  readonly url: string;
  readonly priority?: PriorityLabel;
  readonly reasonAdded?: string | null;
  /** Reserved for T061 dedup ("import new version anyway"). Ignored at T060. */
  readonly forceNewVersion?: boolean;
}

/** Arguments to {@link UrlImportService.importFromHtml} (the M13 capture entry point). */
export interface ImportFromHtmlInput {
  readonly url: string;
  readonly html: string;
  readonly title?: string | null;
  readonly priority?: PriorityLabel;
  readonly reasonAdded?: string | null;
  readonly accessedAt?: string | null;
  readonly forceNewVersion?: boolean;
}

/** Fetch tuning. Conservative defaults; not configurable at the surface. */
const FETCH_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 8 * 1024 * 1024; // 8 MB cap on the fetched body.
const USER_AGENT = "Interleave/0.1 (+https://interleave.app; desktop import)";

/** The shared, internal step 2–6 inputs (after the fetch has produced the HTML). */
interface PipelineInput {
  /** The raw page HTML (→ `original.html`). */
  readonly html: string;
  /** The FINAL url (after redirects) used for `url`/`canonicalUrl`. */
  readonly finalUrl: string;
  /** The as-ENTERED url, preserved verbatim as `originalUrl`. */
  readonly originalUrl: string;
  readonly priority: PriorityLabel;
  readonly reasonAdded: string | null;
  /** An explicit title override (capture path), else extracted/fallback. */
  readonly titleOverride?: string | null;
  /** An explicit accessed timestamp (capture path), else auto-stamped now. */
  readonly accessedAt?: string | null;
}

export class UrlImportService {
  private readonly db: InterleaveDatabase;
  private readonly sources: SourceRepository;
  private readonly assetsRepo: AssetRepository;
  private readonly inbox: InboxQuery;
  private readonly assetsDir: string;
  private readonly fetchImpl: typeof fetch;
  private readonly allowLoopback: boolean;

  constructor(deps: UrlImportServiceDeps) {
    this.db = deps.db;
    this.sources = deps.repositories.sources;
    this.assetsRepo = deps.repositories.assets;
    this.inbox = new InboxQuery(deps.repositories);
    this.assetsDir = deps.assetsDir;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.allowLoopback = deps.allowLoopback ?? false;
  }

  /**
   * Fetch a live web page and import it as an inbox source. Throws a typed
   * {@link UrlImportError} on any network/scheme/SSRF/size/non-HTML failure
   * (nothing is persisted).
   */
  async importFromUrl(input: ImportFromUrlInput): Promise<UrlImportResult> {
    const entered = input.url.trim();
    const { html, finalUrl } = await this.fetchPage(entered);
    return this.runPipeline({
      html,
      finalUrl,
      originalUrl: entered,
      priority: input.priority ?? "C",
      reasonAdded: input.reasonAdded ?? null,
    });
  }

  /**
   * Import a page from ALREADY-RENDERED HTML (the M13 extension "save page"
   * path — the worker has the rendered DOM, getting past paywalls/JS the bare
   * fetch cannot). Skips the fetch; runs the identical step 2–6 pipeline.
   */
  async importFromHtml(input: ImportFromHtmlInput): Promise<UrlImportResult> {
    const entered = input.url.trim();
    // The supplied URL still passes the scheme/SSRF guard (defense in depth).
    this.assertImportableUrl(entered);
    return this.runPipeline({
      html: input.html,
      finalUrl: entered,
      originalUrl: entered,
      priority: input.priority ?? "C",
      reasonAdded: input.reasonAdded ?? null,
      titleOverride: input.title ?? null,
      accessedAt: input.accessedAt ?? null,
    });
  }

  /** Parse + validate a URL against the scheme + SSRF guard; throws on rejection. */
  private assertImportableUrl(raw: string): URL {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new UrlImportError("fetch_failed", `Not a valid URL: ${raw}`);
    }
    if (!isImportableScheme(url.protocol)) {
      throw new UrlImportError("blocked_host", `Unsupported scheme: ${url.protocol}`);
    }
    if (!this.allowLoopback && isBlockedImportHost(url.hostname)) {
      throw new UrlImportError("blocked_host", `Refusing to fetch a private host: ${url.hostname}`);
    }
    return url;
  }

  /**
   * Fetch the page: scheme + SSRF guard (entered AND final url), redirect
   * following, timeout, non-HTML reject, and an 8 MB body-size cap. Returns the
   * raw HTML + the final (post-redirect) url.
   */
  private async fetchPage(entered: string): Promise<{ html: string; finalUrl: string }> {
    this.assertImportableUrl(entered);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.fetchImpl(entered, {
        redirect: "follow",
        signal: controller.signal,
        headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === "AbortError") {
        throw new UrlImportError("timeout", `Timed out fetching ${entered}`);
      }
      throw new UrlImportError("fetch_failed", `Could not reach ${entered}`);
    }

    try {
      // Re-check the FINAL (post-redirect) url against the scheme + SSRF guard —
      // a public URL must not redirect us into a private host.
      const finalUrl = response.url || entered;
      this.assertImportableUrl(finalUrl);

      if (!response.ok) {
        throw new UrlImportError("http_error", `Server returned ${response.status} for ${entered}`);
      }

      const contentType = response.headers.get("content-type") ?? "";
      const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
      // An absent content-type (mime === "") is intentionally permitted: many
      // servers omit the header. A genuinely non-article payload then yields an
      // empty Readability result and still produces a (capture-never-lost) source.
      if (mime !== "" && mime !== "text/html" && mime !== "application/xhtml+xml") {
        throw new UrlImportError("not_html", `That page is not an article (${mime || "unknown"})`);
      }

      // Enforce the declared content-length cap up front when present.
      const declared = Number(response.headers.get("content-length") ?? "");
      if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
        throw new UrlImportError("too_large", `Page exceeds ${MAX_BODY_BYTES} bytes`);
      }

      const bytes = await this.readCappedBody(response);
      const html = new TextDecoder("utf-8").decode(bytes);
      return { html, finalUrl };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Read a response body, aborting if it exceeds the size cap (streaming-measured). */
  private async readCappedBody(response: Response): Promise<Uint8Array> {
    const body = response.body;
    if (!body) {
      // No stream (e.g. a mocked Response): fall back to the buffered read + cap.
      const buf = new Uint8Array(await response.arrayBuffer());
      if (buf.byteLength > MAX_BODY_BYTES) {
        throw new UrlImportError("too_large", `Page exceeds ${MAX_BODY_BYTES} bytes`);
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
          throw new UrlImportError("too_large", `Page exceeds ${MAX_BODY_BYTES} bytes`);
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
   * The shared step 2–6 body both `importFromUrl` + `importFromHtml` call:
   * mint id → Readability → sanitize → HTML→PM → write snapshots + create source
   * in ONE transaction → return the inbox summary.
   */
  private runPipeline(input: PipelineInput): UrlImportResult {
    // 2. Mint the source id up front so the vault path is known before the row.
    const sourceId = newElementId();

    // 3. Pure transforms (importers package): article → clean HTML → PM doc.
    const article = extractArticle(input.html, { url: input.finalUrl });
    const cleanedHtml = sanitizeArticleHtml(article.contentHtml);
    const conversion: PlainTextConversion = htmlToProseMirrorDoc(cleanedHtml);

    // Title fallback chain: explicit override → Readability title → page <title>
    // → the host. Never empty (so the inbox row always has a label).
    const host = safeHost(input.finalUrl);
    const title =
      nonEmpty(input.titleOverride) ??
      nonEmpty(article.title) ??
      nonEmpty(article.pageTitle) ??
      host ??
      "Untitled web page";

    // When Readability found no body, note it so the user knows to read the
    // saved original.html snapshot (the capture is never lost). If the user also
    // supplied a reason, keep their intent first and append the diagnostic note
    // (rather than dropping it) so the inbox row still signals the empty body.
    const noBody = conversion.blocks.length === 0;
    const noBodyNote = "Readability found no article body";
    const userReason = nonEmpty(input.reasonAdded);
    const reasonAdded = userReason
      ? noBody
        ? `${userReason} — ${noBodyNote}`
        : userReason
      : noBody
        ? noBodyNote
        : null;

    const accessedAt = input.accessedAt ?? new Date().toISOString();
    const canonicalUrl = canonicalizeUrl(input.finalUrl);

    // 4. Write the snapshots to the vault FIRST (outside the tx — bytes on disk).
    const sourceDir = path.join(this.assetsDir, "sources", sourceId);
    const originalRel = `sources/${sourceId}/original.html`;
    const cleanedRel = `sources/${sourceId}/cleaned.html`;
    const originalBytes = Buffer.from(input.html, "utf-8");
    const cleanedBytes = Buffer.from(cleanedHtml, "utf-8");

    let wroteDir = false;
    try {
      mkdirSync(sourceDir, { recursive: true });
      wroteDir = true;
      writeFileSync(path.join(this.assetsDir, originalRel), originalBytes);
      writeFileSync(path.join(this.assetsDir, cleanedRel), cleanedBytes);

      // 5. Create the source + its two snapshot-asset rows in ONE transaction so
      //    a failure rolls back the source, document, blocks, ops, AND asset rows
      //    together (no orphan source/asset). The snapshotKey points at cleaned.html.
      this.db.transaction((tx) => {
        this.sources.createWithDocumentWithin(tx, {
          id: sourceId as ElementId,
          title,
          priority: priorityFromLabel(input.priority),
          status: "inbox",
          stage: "raw_source",
          url: input.finalUrl,
          canonicalUrl,
          originalUrl: input.originalUrl,
          author: article.byline,
          accessedAt,
          snapshotKey: cleanedRel,
          reasonAdded,
          conversion,
        });
        this.assetsRepo.createWithin(tx, {
          owningElementId: sourceId as ElementId,
          kind: "source_html",
          vaultRoot: "assets",
          relativePath: originalRel,
          contentHash: sha256(originalBytes),
          mime: "text/html",
          size: originalBytes.byteLength,
        });
        this.assetsRepo.createWithin(tx, {
          owningElementId: sourceId as ElementId,
          kind: "source_html",
          vaultRoot: "assets",
          relativePath: cleanedRel,
          contentHash: sha256(cleanedBytes),
          mime: "text/html",
          size: cleanedBytes.byteLength,
        });
      });
    } catch (err) {
      // If the transaction rolled back (or a write failed), best-effort remove the
      // partial vault dir so no orphan files linger.
      if (wroteDir) {
        try {
          rmSync(sourceDir, { recursive: true, force: true });
        } catch {
          // Best-effort cleanup; surface the original error below.
        }
      }
      throw err;
    }

    // 6. Return the fresh inbox summary (like importManualSource).
    const detail = this.inbox.get(sourceId as ElementId);
    const item = detail?.summary ?? this.inbox.list().find((i) => i.id === sourceId) ?? null;
    if (!item) {
      throw new Error("UrlImportService: created source not found in inbox");
    }
    return { status: "imported", id: sourceId, item };
  }
}

/** Trim a string to a non-empty value, or `null`. */
function nonEmpty(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** The host of a URL (for a title fallback), or `null` when unparseable. */
function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}
