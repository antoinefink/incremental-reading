/**
 * Import-from-URL modal (T060) — the automatic web-import dialog.
 *
 * Reached from the inbox import strip's "Paste URL" chip. It captures a single
 * URL (+ optional priority + reason) and asks the MAIN process to fetch, clean,
 * snapshot, and import the live page through the one typed
 * `appApi.importUrlSource` command. The renderer NEVER fetches, cleans, or
 * persists — all of that runs main-side. Submittable with ⌘↵ / Enter, closeable
 * with Esc; shows a busy state while the main process works and an inline,
 * friendly error on failure.
 *
 * Pure UI: it gathers field values and calls ONE bridge command; the main process
 * owns the network fetch, Readability, sanitize, vault write, and persistence.
 */

import { canonicalizeUrl } from "@interleave/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import { appApi, isDesktop, type PriorityLabelInput } from "../../lib/appApi";
import { Kbd } from "../../shell/Kbd";

const PRIORITY_LABELS: readonly PriorityLabelInput[] = ["A", "B", "C", "D"];

/** Map a typed import-error code to a friendly one-liner; default to the raw message. */
function friendlyError(message: string): string {
  // The main process throws `UrlImportError` with a `code:` that arrives in the
  // IPC error message string. Map the known codes to calm, specific copy.
  if (/blocked_host/i.test(message)) return "That address can't be imported.";
  if (/timeout/i.test(message)) return "Timed out reaching that page.";
  if (/not_html/i.test(message)) return "That page isn't an article.";
  if (/too_large/i.test(message)) return "That page is too large to import.";
  if (/http_error/i.test(message)) return "That page returned an error.";
  if (/fetch_failed/i.test(message)) return "Couldn't reach that page.";
  return message;
}

export type ImportUrlModalProps = {
  open: boolean;
  onClose: () => void;
  /** Called with the new source id after a successful import. */
  onImported: (id: string) => void;
};

export function ImportUrlModal({ open, onClose, onImported }: ImportUrlModalProps) {
  const [url, setUrl] = useState("");
  const [reason, setReason] = useState("");
  const [priority, setPriority] = useState<PriorityLabelInput>("C");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // A live read-back of the canonical URL the main process WILL derive — uses the
  // same pure `@interleave/core` normalizer; the renderer never persists it.
  const canonicalPreview = useMemo(() => canonicalizeUrl(url), [url]);

  // Reset + focus when opened.
  useEffect(() => {
    if (!open) return;
    setUrl("");
    setReason("");
    setPriority("C");
    setError(null);
    setSubmitting(false);
    const id = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(id);
  }, [open]);

  const submit = useCallback(async () => {
    const trimmed = url.trim();
    if (trimmed.length === 0 || submitting || !isDesktop()) return;
    setSubmitting(true);
    setError(null);
    try {
      const trimmedReason = reason.trim();
      const result = await appApi.importUrlSource({
        url: trimmed,
        priority,
        ...(trimmedReason ? { reasonAdded: trimmedReason } : {}),
      });
      if (result.status === "imported") {
        onImported(result.id);
      }
    } catch (e) {
      setError(friendlyError(e instanceof Error ? e.message : String(e)));
      setSubmitting(false);
    }
  }, [url, reason, priority, submitting, onImported]);

  // Esc to close, ⌘↵ to submit while open.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void submit();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, submit]);

  if (!open) return null;

  const fieldClass =
    "w-full rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text outline-none focus:border-accent";

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh]"
      data-testid="import-url-modal"
    >
      <button
        type="button"
        className="absolute inset-0 bg-black/30"
        aria-label="Close Import from URL"
        tabIndex={-1}
        onClick={onClose}
      />
      <div
        className="relative flex max-h-[80vh] w-full max-w-xl flex-col rounded-xl border border-border bg-surface shadow-lg"
        role="dialog"
        aria-modal="true"
        aria-label="Import from URL"
      >
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="flex items-center justify-between border-border border-b px-4 py-3">
            <h2 className="font-semibold text-base text-text">Import from URL</h2>
            <button
              type="button"
              data-testid="import-url-close"
              aria-label="Close"
              onClick={onClose}
              className="rounded p-1 text-text-3 hover:text-text"
            >
              <Icon name="x" size={16} />
            </button>
          </div>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
            <label className="block">
              <span className="mb-1 block font-medium text-sm text-text-2">URL</span>
              <input
                ref={inputRef}
                data-testid="import-url-input"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://…"
                className={fieldClass}
              />
            </label>

            {canonicalPreview && canonicalPreview !== url.trim() ? (
              <p className="text-text-3 text-xs" data-testid="import-url-canonical">
                Canonical: <span className="break-all font-mono">{canonicalPreview}</span>
              </p>
            ) : null}

            <p className="text-text-3 text-xs">
              The app fetches the page, extracts the readable article, and saves a snapshot — all
              locally.
            </p>

            <label className="block">
              <span className="mb-1 block font-medium text-sm text-text-2">Reason (optional)</span>
              <input
                data-testid="import-url-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why is this worth keeping?"
                className={fieldClass}
              />
            </label>

            <div>
              <span className="mb-1.5 block font-medium text-sm text-text-2">Priority</span>
              <div className="flex gap-1.5" data-testid="import-url-priority">
                {PRIORITY_LABELS.map((p) => {
                  const active = priority === p;
                  return (
                    <button
                      key={p}
                      type="button"
                      data-testid={`import-url-priority-${p}`}
                      aria-pressed={active}
                      onClick={() => setPriority(p)}
                      className={
                        active
                          ? "inline-flex flex-1 items-center justify-center gap-1.5 rounded-md border border-accent-soft-bd bg-accent-soft px-2 py-1 font-medium text-accent-text text-sm"
                          : "inline-flex flex-1 items-center justify-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 font-medium text-sm text-text-2 hover:text-text"
                      }
                    >
                      <span
                        className="size-2 rounded-full"
                        style={{ background: `var(--prio-${p.toLowerCase()})` }}
                      />
                      {p}
                    </button>
                  );
                })}
              </div>
            </div>

            {error ? (
              <p className="text-danger text-sm" data-testid="import-url-error">
                {error}
              </p>
            ) : null}
          </div>

          <div className="flex items-center justify-end gap-2 border-border border-t px-4 py-3">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-border bg-surface px-3 py-1.5 font-medium text-sm text-text-2 hover:text-text"
            >
              Cancel
            </button>
            <button
              type="submit"
              data-testid="import-url-submit"
              disabled={url.trim().length === 0 || submitting}
              className="inline-flex items-center gap-2 rounded-md bg-accent px-3.5 py-1.5 font-medium text-sm text-text-on-accent disabled:opacity-50"
            >
              {submitting ? (
                <>
                  <Icon name="clock" size={14} className="animate-spin" />
                  Fetching…
                </>
              ) : (
                <>
                  Import
                  <Kbd keys={["⌘", "↵"]} />
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
