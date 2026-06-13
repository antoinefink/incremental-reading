/**
 * Pure per-page PDF text extraction (T064) — `pdfjs-dist` legacy (Node) build.
 *
 * Takes the raw PDF bytes (a `Uint8Array`) and returns one {@link PdfPage} per
 * page, each carrying its text lines with bounding boxes in a CONSISTENT
 * coordinate space, plus the page width/height and a `hasText` flag (the
 * scanned/image-only signal T066 reads). NO `fs`, NO Electron, NO network — bytes
 * in, structured text out. The orchestrating `PdfImportService` (Electron main)
 * reads the file + writes the vault + runs the DB transaction; this stays pure so
 * it bundles cleanly into `main.cjs` and is unit-testable against fixtures.
 *
 * ## Coordinate convention (sets up T065 — keep this documented)
 *
 * Boxes are recorded in PDF USER SPACE at scale 1, with **y measured from the
 * page TOP** (so a line near the top of the page has a small `y`). PDF native
 * coordinates put the origin at the bottom-left and y increasing upward; we
 * convert to top-down via `y_top = pageHeight - y_pdf - height` so the boxes line
 * up with the rendered text layer (the renderer's viewport is also top-down).
 * `x` is the left edge, `width`/`height` the glyph-run extent. A consumer that
 * rendered the page at scale `s` maps a box to pixels by multiplying by `s`
 * (and a rubber-band pixel rect back to user space by dividing — T065).
 *
 * The legacy build runs headless (no DOM / no canvas): we open with
 * `getDocument({ data, isEvalSupported: false })` and read `getTextContent()`
 * only. The parse runs on the CALLING thread, bounded by the caller's size/page
 * caps.
 *
 * ## Lazily bundled main-thread worker (load-bearing for the bundled `main.cjs`)
 *
 * pdfjs always routes parsing through a "worker". When NO real Web Worker is
 * available (the Electron main / a bundled Node CJS) it falls back to a fake
 * worker that, by default, dynamically `import()`s `pdf.worker.mjs` by PATH — which
 * does not exist next to our single bundled `main.cjs`, so the parse throws
 * "Setting up fake worker failed". We instead import the worker's
 * `WorkerMessageHandler` and register it on `globalThis.pdfjsWorker`; pdfjs then
 * uses that handler ON THE MAIN THREAD with NO path-based import (see pdf.mjs
 * `#mainThreadWorkerMessageHandler`).
 *
 * Keep this loader LAZY. The desktop main imports the `@interleave/importers`
 * barrel at startup for non-PDF helpers; if `pdfjs` is evaluated during bundle
 * startup it probes for its optional native canvas package from `dist/main.cjs`
 * and prints noisy `@napi-rs/canvas`/DOMMatrix warnings. We only need pdfjs when a
 * PDF import is actually running.
 */

/// <reference path="./pdfjs-worker.d.ts" />

type PdfJsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

const workerGlobal = globalThis as { pdfjsWorker?: { WorkerMessageHandler: unknown } };
let pdfjsPromise: Promise<PdfJsModule> | null = null;

/** Load pdfjs only when parsing a PDF, after registering the bundled fake worker. */
async function loadPdfJs(): Promise<PdfJsModule> {
  pdfjsPromise ??= (async () => {
    const { WorkerMessageHandler } = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
    if (!workerGlobal.pdfjsWorker) {
      workerGlobal.pdfjsWorker = { WorkerMessageHandler };
    }
    return await import("pdfjs-dist/legacy/build/pdf.mjs");
  })();
  return await pdfjsPromise;
}

/** One extracted text line on a page, boxed in top-down PDF user space (scale 1). */
export interface PdfTextLine {
  /** The line's visible text (a run of glyphs grouped by baseline). */
  readonly text: string;
  /** Left edge in PDF user space. */
  readonly x: number;
  /** Top edge in PDF user space, measured FROM THE PAGE TOP (see file header). */
  readonly y: number;
  /** Run width in user space. */
  readonly width: number;
  /** Run height in user space (approx. font size). */
  readonly height: number;
}

/** One parsed PDF page: its 1-based number, text lines, dimensions, and text flag. */
export interface PdfPage {
  /** 1-based page number. */
  readonly pageNumber: number;
  /** Text lines in reading order (top-to-bottom, then left-to-right). */
  readonly lines: readonly PdfTextLine[];
  /** Page width in user space (scale 1). */
  readonly width: number;
  /** Page height in user space (scale 1). */
  readonly height: number;
  /** False when the page yields no text items (the scanned/image-only signal). */
  readonly hasText: boolean;
}

/** A raw text item from `getTextContent` (the subset we read). */
interface RawTextItem {
  readonly str: string;
  /** `[a, b, c, d, e, f]` text matrix; `e`=x, `f`=y (PDF bottom-up), `d`≈font size. */
  readonly transform: number[];
  readonly width: number;
  readonly height: number;
}

/** Vertical tolerance (user units) within which two items share a line/baseline. */
const LINE_Y_TOLERANCE = 4;

/**
 * Group `getTextContent` items into visual lines by baseline, then order the
 * lines top-to-bottom and the runs within a line left-to-right, joining runs with
 * a single space. Coordinates are converted to TOP-DOWN user space (see header).
 */
function itemsToLines(items: readonly RawTextItem[], pageHeight: number): PdfTextLine[] {
  type Run = { text: string; x: number; yTop: number; width: number; height: number };
  const runs: Run[] = [];
  for (const item of items) {
    const text = item.str;
    if (text.trim().length === 0) continue;
    const tf = item.transform ?? [1, 0, 0, 1, 0, 0];
    const x = tf[4] ?? 0;
    const yPdf = tf[5] ?? 0; // baseline y in PDF (bottom-up) space
    const height = item.height || Math.abs(tf[3] ?? 0) || 0;
    const width = item.width || 0;
    // Convert to top-down: top edge = pageHeight - baseline - height.
    const yTop = pageHeight - yPdf - height;
    runs.push({ text, x, yTop, width, height });
  }

  // Cluster runs whose top edge is within tolerance into one line.
  runs.sort((a, b) => a.yTop - b.yTop || a.x - b.x);
  const lines: PdfTextLine[] = [];
  let current: Run[] = [];
  let currentY: number | null = null;
  const flush = (): void => {
    if (current.length === 0) return;
    const ordered = [...current].sort((a, b) => a.x - b.x);
    const text = ordered
      .map((r) => r.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (text.length > 0) {
      const x = Math.min(...ordered.map((r) => r.x));
      const yTop = Math.min(...ordered.map((r) => r.yTop));
      const right = Math.max(...ordered.map((r) => r.x + r.width));
      const height = Math.max(...ordered.map((r) => r.height));
      lines.push({ text, x, y: yTop, width: right - x, height });
    }
    current = [];
    currentY = null;
  };
  for (const run of runs) {
    if (currentY === null || Math.abs(run.yTop - currentY) <= LINE_Y_TOLERANCE) {
      current.push(run);
      currentY = currentY === null ? run.yTop : Math.min(currentY, run.yTop);
    } else {
      flush();
      current.push(run);
      currentY = run.yTop;
    }
  }
  flush();
  return lines;
}

/**
 * Extract per-page text from PDF bytes. Resolves to one {@link PdfPage} per page
 * in document order. Each page's `lines` are in reading order with top-down user-
 * space boxes; `hasText` is false for a page with no text items (scanned). Throws
 * if the bytes are not a parseable PDF (the caller maps that to `unreadable` /
 * `encrypted`).
 *
 * @param bytes the raw PDF file bytes.
 */
export async function extractPdfPages(bytes: Uint8Array): Promise<PdfPage[]> {
  const pdfjs = await loadPdfJs();
  // A fresh copy: pdfjs may transfer/detach the buffer, and the caller often
  // reuses the same bytes to stream into the vault.
  const data = bytes.slice();
  const doc = await pdfjs.getDocument({
    data,
    isEvalSupported: false,
    // Headless: no worker, no canvas, no standard-font fetch (text-only parse).
    useWorkerFetch: false,
    useSystemFonts: false,
  }).promise;

  try {
    const pages: PdfPage[] = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items = (content.items as RawTextItem[]).filter((it) => typeof it?.str === "string");
      const lines = itemsToLines(items, viewport.height);
      const hasText = lines.length > 0;
      pages.push({
        pageNumber,
        lines,
        width: viewport.width,
        height: viewport.height,
        hasText,
      });
      page.cleanup();
    }
    return pages;
  } finally {
    await doc.destroy();
  }
}

/** The PDF's document `/Title` metadata, trimmed, or `null`. Pure (reuses pdfjs). */
export async function extractPdfTitle(bytes: Uint8Array): Promise<string | null> {
  const pdfjs = await loadPdfJs();
  const data = bytes.slice();
  const doc = await pdfjs.getDocument({
    data,
    isEvalSupported: false,
    useWorkerFetch: false,
    useSystemFonts: false,
  }).promise;
  try {
    const meta = await doc.getMetadata();
    const info = meta?.info as { Title?: unknown } | undefined;
    const title = typeof info?.Title === "string" ? info.Title.trim() : "";
    return title.length > 0 ? title : null;
  } catch {
    return null;
  } finally {
    await doc.destroy();
  }
}
