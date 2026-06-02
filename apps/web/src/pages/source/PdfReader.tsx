/**
 * PDF reading mode (T064) — the `pdfjs-dist` canvas + selectable text layer the
 * `SourceReader` swaps in when a source is a PDF (`documents.get` →
 * `sourceFormat: "pdf"`).
 *
 * It loads the original PDF bytes ONCE through the typed `sources.getPdfData`
 * command (the renderer never resolves a vault path), renders pages LAZILY — only
 * the page(s) near the viewport are drawn, so a 500-page PDF stays responsive —
 * and overlays `pdfjs-dist`'s `TextLayer` so the user can SELECT text on a page.
 * Selecting text + pressing Extract (or `E`) lifts it into an `extract` whose
 * `source_locations.page` links it to the page it came from; the page is read off
 * `document_blocks.page` (the `blockPages` map) for that page's first block id.
 *
 * The read-point is PAGE-granular: scrolling to (or pressing "Set read-point" on)
 * a page persists that page's FIRST block id via `readPoints.set`, so reopening
 * resumes at the page. Pure UI: it calls the typed commands only — no fs/parse/SQL
 * in the renderer. Outside the desktop shell it degrades to a calm fallback.
 */

import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy, TextLayer } from "pdfjs-dist";
// Vite resolves the worker file to a served URL (`?url`) so pdfjs runs its parse
// off the main thread in the renderer (a normal renderer dependency).
import PdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import { appApi, isDesktop } from "../../lib/appApi";
import "./pdf-reader.css";

GlobalWorkerOptions.workerSrc = PdfWorkerUrl;

/** The render scale (zoom) — fixed for T064; a future control can vary it. */
const RENDER_SCALE = 1.4;
/** How many pages above/below the viewport to keep rendered (windowing). */
const RENDER_WINDOW = 1;

/** The ordered (page → first block id) map derived from `blockPages`. */
function pageToFirstBlock(blockPages: Readonly<Record<string, number>>): Map<number, string> {
  // `blockPages` is insertion-ordered (document order) main-side, so the FIRST
  // entry seen for a page is that page's first block (its "Page N" heading).
  const out = new Map<number, string>();
  for (const [blockId, page] of Object.entries(blockPages)) {
    if (!out.has(page)) out.set(page, blockId);
  }
  return out;
}

export interface PdfReaderProps {
  /** The PDF source element id. */
  readonly elementId: string;
  /** The block→page map (stable block id → 1-based page) from `documents.get`. */
  readonly blockPages: Readonly<Record<string, number>>;
  /** Called when the active page changes (so the shell can show page N of M). */
  readonly onActivePageChange?: (page: number, total: number) => void;
  /** Toast helper from the parent reader (status messages). */
  readonly toast: (message: string) => void;
}

/** One rendered page's measured state. */
interface PageState {
  readonly pageNumber: number;
  readonly width: number;
  readonly height: number;
}

export function PdfReader({ elementId, blockPages, onActivePageChange, toast }: PdfReaderProps) {
  const desktop = isDesktop();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const docRef = useRef<PDFDocumentProxy | null>(null);
  const [pages, setPages] = useState<readonly PageState[]>([]);
  const [activePage, setActivePage] = useState(1);
  const [status, setStatus] = useState<"loading" | "ready" | "error" | "empty">("loading");
  const [error, setError] = useState<string | null>(null);

  const firstBlockByPage = useMemo(() => pageToFirstBlock(blockPages), [blockPages]);

  // Keep the active-page callback in a ref so the load effect does NOT depend on
  // its (per-render) identity — otherwise a fresh inline callback re-runs the load
  // effect on every parent render, cancelling the in-flight doc in a loop.
  const onActivePageChangeRef = useRef(onActivePageChange);
  onActivePageChangeRef.current = onActivePageChange;

  // Load the PDF bytes + size each page (without rendering them all — only the
  // viewport sizes, so the scroller has the right total height).
  useEffect(() => {
    if (!desktop || !elementId) return;
    let cancelled = false;
    setStatus("loading");
    setError(null);
    void (async () => {
      try {
        const { bytes } = await appApi.getSourcePdfData({ elementId });
        if (cancelled) return;
        if (!bytes) {
          setStatus("empty");
          return;
        }
        const doc = await getDocument({ data: new Uint8Array(bytes) }).promise;
        if (cancelled) {
          await doc.destroy();
          return;
        }
        docRef.current = doc;
        const measured: PageState[] = [];
        for (let n = 1; n <= doc.numPages; n++) {
          const page = await doc.getPage(n);
          const vp = page.getViewport({ scale: RENDER_SCALE });
          measured.push({ pageNumber: n, width: vp.width, height: vp.height });
          page.cleanup();
        }
        if (cancelled) return;
        setPages(measured);
        setStatus("ready");
        onActivePageChangeRef.current?.(1, measured.length);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setStatus("error");
        }
      }
    })();
    return () => {
      cancelled = true;
      const doc = docRef.current;
      docRef.current = null;
      if (doc) void doc.destroy();
    };
  }, [desktop, elementId]);

  // Track the active page as the user scrolls (the page whose top is nearest the
  // viewport top), so the read-point + progress reflect where they are.
  const onScroll = useCallback(() => {
    const root = scrollRef.current;
    if (!root) return;
    const pageEls = root.querySelectorAll<HTMLElement>("[data-pdf-page]");
    const rootRect = root.getBoundingClientRect();
    // The active page is the one with the LARGEST visible area in the viewport
    // (robust when a page is only partially scrolled in, unlike a top-nearest rule).
    let best = 1;
    let bestVisible = -1;
    for (const el of pageEls) {
      const n = Number(el.getAttribute("data-pdf-page"));
      const r = el.getBoundingClientRect();
      const visible = Math.max(
        0,
        Math.min(r.bottom, rootRect.bottom) - Math.max(r.top, rootRect.top),
      );
      if (visible > bestVisible) {
        bestVisible = visible;
        best = n;
      }
    }
    setActivePage((prev) => {
      if (prev !== best) onActivePageChangeRef.current?.(best, pages.length);
      return best;
    });
  }, [pages.length]);

  /** The 1-based page a given DOM node lives on (for an extract's location). */
  const pageOfNode = useCallback((node: Node | null): number | null => {
    let el: HTMLElement | null = node instanceof HTMLElement ? node : (node?.parentElement ?? null);
    while (el) {
      const attr = el.getAttribute?.("data-pdf-page");
      if (attr) return Number(attr);
      el = el.parentElement;
    }
    return null;
  }, []);

  /** Extract the current text selection on the page → an `extract` linked to its page. */
  const onExtract = useCallback(async () => {
    if (!desktop) return;
    const sel = window.getSelection();
    const text = sel?.toString().trim() ?? "";
    if (!sel || sel.isCollapsed || text.length === 0) {
      toast("Select some text on the page first");
      return;
    }
    const page = pageOfNode(sel.anchorNode) ?? activePage;
    const firstBlockId = firstBlockByPage.get(page);
    if (!firstBlockId) {
      toast("Could not resolve the page for this selection");
      return;
    }
    try {
      await appApi.createExtraction({
        sourceElementId: elementId,
        selectedText: text,
        blockIds: [firstBlockId],
        page,
      });
      toast(`Extracted from page ${page}`);
      sel.removeAllRanges();
    } catch {
      toast("Could not extract");
    }
  }, [desktop, elementId, activePage, firstBlockByPage, pageOfNode, toast]);

  /**
   * Persist a page-granular read-point. The target page is the page of the current
   * text selection (so "set read-point" while a passage on page N is selected lands
   * on page N), falling back to the active (scrolled) page when nothing is selected.
   */
  const setReadPoint = useCallback(async () => {
    if (!desktop) return;
    const sel = window.getSelection();
    const selPage = sel && !sel.isCollapsed ? (pageOfNode(sel.anchorNode) ?? null) : null;
    const targetPage = selPage ?? activePage;
    const firstBlockId = firstBlockByPage.get(targetPage);
    if (!firstBlockId) {
      toast("No read-point anchor for this page");
      return;
    }
    try {
      await appApi.setReadPoint({
        elementId,
        documentId: elementId,
        blockId: firstBlockId,
        offset: 0,
      });
      toast(`Read-point set on page ${targetPage}`);
    } catch {
      toast("Could not set read-point");
    }
  }, [desktop, elementId, activePage, firstBlockByPage, pageOfNode, toast]);

  // Keyboard: `E` extracts the current page selection; `␣` sets the page read-point.
  useEffect(() => {
    if (!desktop) return;
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.toLowerCase() === "e") {
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed) {
          e.preventDefault();
          void onExtract();
        }
      } else if (e.key === " " || e.code === "Space") {
        if (target?.isContentEditable) return;
        e.preventDefault();
        void setReadPoint();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [desktop, onExtract, setReadPoint]);

  if (!desktop) {
    return (
      <div className="pdf-reader-state" data-testid="pdf-reader-no-desktop">
        Open the desktop app to read a PDF.
      </div>
    );
  }

  return (
    <div className="pdf-reader" data-testid="pdf-reader">
      <div className="pdf-reader-bar">
        <button
          type="button"
          className="reader-btn reader-btn--primary"
          data-testid="pdf-set-readpoint"
          // Preserve the active text selection: a plain click's mousedown would
          // collapse it before the handler reads the selection's page.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => void setReadPoint()}
        >
          <Icon name="bookmark" size={14} /> Set read-point
        </button>
        <button
          type="button"
          className="reader-btn"
          data-testid="pdf-extract"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => void onExtract()}
        >
          <Icon name="extract" size={14} /> Extract selection
        </button>
        <span className="pdf-reader-pagecount" data-testid="pdf-page-indicator">
          {status === "ready" ? `Page ${activePage} of ${pages.length}` : "—"}
        </span>
      </div>

      {status === "loading" ? (
        <p className="pdf-reader-state" data-testid="pdf-reader-loading">
          Loading PDF…
        </p>
      ) : status === "error" ? (
        <p className="pdf-reader-state pdf-reader-state--error" data-testid="pdf-reader-error">
          {error ?? "Failed to load the PDF."}
        </p>
      ) : status === "empty" ? (
        <p className="pdf-reader-state" data-testid="pdf-reader-empty">
          This source has no PDF bytes in the vault.
        </p>
      ) : (
        <div
          className="pdf-reader-scroll"
          data-testid="pdf-reader-scroll"
          ref={scrollRef}
          onScroll={onScroll}
        >
          {pages.map((p) => (
            <PdfPageView key={p.pageNumber} docRef={docRef} page={p} activePage={activePage} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One page slot — a fixed-size box (so the scroller height is correct without
 * rendering everything) that LAZILY draws its canvas + text layer only when it is
 * within the render window of the active page.
 */
function PdfPageView({
  docRef,
  page,
  activePage,
}: {
  docRef: React.MutableRefObject<PDFDocumentProxy | null>;
  page: PageState;
  activePage: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textRef = useRef<HTMLDivElement | null>(null);
  const renderedRef = useRef(false);
  const shouldRender = Math.abs(page.pageNumber - activePage) <= RENDER_WINDOW;

  useEffect(() => {
    if (!shouldRender || renderedRef.current) return;
    const doc = docRef.current;
    const canvas = canvasRef.current;
    const textEl = textRef.current;
    if (!doc || !canvas || !textEl) return;
    let cancelled = false;
    void (async () => {
      const pdfPage = await doc.getPage(page.pageNumber);
      if (cancelled) return;
      const viewport = pdfPage.getViewport({ scale: RENDER_SCALE });
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      await pdfPage.render({ canvasContext: ctx, viewport }).promise;
      if (cancelled) return;
      // Text layer for selection (positioned over the canvas).
      const textContent = await pdfPage.getTextContent();
      if (cancelled) return;
      textEl.replaceChildren();
      textEl.style.width = `${viewport.width}px`;
      textEl.style.height = `${viewport.height}px`;
      const textLayer = new TextLayer({
        textContentSource: textContent,
        container: textEl,
        viewport,
      });
      await textLayer.render();
      renderedRef.current = true;
      pdfPage.cleanup();
    })();
    return () => {
      cancelled = true;
    };
  }, [shouldRender, docRef, page.pageNumber]);

  return (
    <div
      className="pdf-page"
      data-pdf-page={page.pageNumber}
      data-testid={`pdf-page-${page.pageNumber}`}
      style={{ width: page.width, height: page.height }}
    >
      <canvas ref={canvasRef} className="pdf-page-canvas" />
      <div ref={textRef} className="pdf-page-text textLayer" />
    </div>
  );
}
