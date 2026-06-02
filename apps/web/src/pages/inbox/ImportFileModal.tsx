/**
 * Import-from-file modal (T067) — the local file-import dialog.
 *
 * Reached from the inbox import strip's "Import file…" chip. It mirrors
 * {@link ImportUrlModal}: the user clicks "Choose EPUB…" (which calls the MAIN file
 * picker via `appApi.pickImportFile({ kind })`), sees the chosen filename + an
 * optional priority chip group, then imports with ⌘↵ (or the Import button). The
 * renderer NEVER reads or parses the file — it calls ONE picker + ONE import command;
 * all parse/persist runs main-side. Esc closes; a busy spinner shows while main
 * parses; an inline friendly error shows on failure.
 *
 * It takes a `kind` so the SAME modal is reused by T068–T070 (Markdown/HTML,
 * highlights, Anki) — only EPUB is wired in T067.
 */

import { useCallback, useEffect, useState } from "react";
import { Icon } from "../../components/Icon";
import { appApi, isDesktop, type PriorityLabelInput } from "../../lib/appApi";
import { Kbd } from "../../shell/Kbd";

const PRIORITY_LABELS: readonly PriorityLabelInput[] = ["A", "B", "C", "D"];

/** The file kinds this modal can import (only `epub` is wired in T067). */
export type ImportFileKind = "epub";

/** Per-kind copy + picker config. */
const KIND_CONFIG: Record<ImportFileKind, { title: string; choose: string; ext: string }> = {
  epub: { title: "Import EPUB", choose: "Choose EPUB…", ext: ".epub" },
};

/** Map a thrown EPUB-import `code: message` error line to a friendly message. */
function friendlyError(message: string): string {
  const codes: Record<string, string> = {
    not_epub: "That file is not an EPUB.",
    not_a_zip: "That file is not a valid EPUB.",
    no_opf: "That EPUB is malformed (no package file).",
    no_spine: "That EPUB declares no readable chapters.",
    empty_book: "That EPUB has no chapter content.",
    drm: "That EPUB is DRM-protected and can't be imported.",
    too_large: "That EPUB is too large to import.",
    unreadable: "That EPUB could not be read.",
  };
  const sep = message.indexOf(":");
  const code = sep > 0 ? message.slice(0, sep).trim() : "";
  return codes[code] ?? "Could not import that file.";
}

/** Just the filename of an absolute path (for the chosen-file label). */
function basename(absPath: string): string {
  const parts = absPath.split(/[\\/]/);
  return parts[parts.length - 1] ?? absPath;
}

export type ImportFileModalProps = {
  open: boolean;
  /** The file kind to import (selects the picker filter + copy). */
  kind: ImportFileKind;
  onClose: () => void;
  /** Called with the new BOOK source id after a successful import. */
  onImported: (id: string) => void;
};

export function ImportFileModal({ open, kind, onClose, onImported }: ImportFileModalProps) {
  const config = KIND_CONFIG[kind];
  const [path, setPath] = useState<string | null>(null);
  const [priority, setPriority] = useState<PriorityLabelInput>("C");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset on open.
  useEffect(() => {
    if (!open) return;
    setPath(null);
    setPriority("C");
    setError(null);
    setSubmitting(false);
  }, [open]);

  // Open the native picker (main-side) and remember the chosen path.
  const choose = useCallback(async () => {
    if (!isDesktop() || submitting) return;
    setError(null);
    try {
      const result = await appApi.pickImportFile({ kind });
      if ("cancelled" in result) return;
      setPath(result.paths[0] ?? null);
    } catch (e) {
      setError(friendlyError(e instanceof Error ? e.message : String(e)));
    }
  }, [kind, submitting]);

  // Import the chosen file (main parses + persists).
  const submit = useCallback(async () => {
    if (!path || submitting || !isDesktop()) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await appApi.importEpubSource({ path, priority });
      if (result.status === "imported") {
        onImported(result.bookId);
      }
    } catch (e) {
      setError(friendlyError(e instanceof Error ? e.message : String(e)));
      setSubmitting(false);
    }
  }, [path, priority, submitting, onImported]);

  // Esc to close, ⌘↵ to import while open.
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

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh]"
      data-testid="import-file-modal"
    >
      <button
        type="button"
        className="absolute inset-0 bg-black/30"
        aria-label={`Close ${config.title}`}
        tabIndex={-1}
        onClick={onClose}
      />
      <div
        className="relative flex max-h-[80vh] w-full max-w-xl flex-col rounded-xl border border-border bg-surface shadow-lg"
        role="dialog"
        aria-modal="true"
        aria-label={config.title}
      >
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="flex items-center justify-between border-border border-b px-4 py-3">
            <h2 className="font-semibold text-base text-text">{config.title}</h2>
            <button
              type="button"
              data-testid="import-file-close"
              aria-label="Close"
              onClick={onClose}
              className="rounded p-1 text-text-3 hover:text-text"
            >
              <Icon name="x" size={16} />
            </button>
          </div>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
            <div>
              <button
                type="button"
                data-testid="import-file-choose"
                onClick={() => void choose()}
                className="inline-flex items-center gap-2 rounded-md border border-border bg-surface-2 px-3 py-2 font-medium text-sm text-text hover:border-border-strong"
              >
                <Icon name="upload" size={14} />
                {config.choose}
              </button>
              {path ? (
                <p className="mt-2 break-all text-sm text-text-2" data-testid="import-file-chosen">
                  {basename(path)}
                </p>
              ) : (
                <p className="mt-2 text-text-3 text-xs">
                  The whole book imports locally as chapters — its original {config.ext} is kept in
                  your vault.
                </p>
              )}
            </div>

            <div>
              <span className="mb-1.5 block font-medium text-sm text-text-2">Priority</span>
              <div className="flex gap-1.5" data-testid="import-file-priority">
                {PRIORITY_LABELS.map((p) => {
                  const active = priority === p;
                  return (
                    <button
                      key={p}
                      type="button"
                      data-testid={`import-file-priority-${p}`}
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
              <p className="text-danger text-sm" data-testid="import-file-error">
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
              data-testid="import-file-submit"
              disabled={!path || submitting}
              className="inline-flex items-center gap-2 rounded-md bg-accent px-3.5 py-1.5 font-medium text-sm text-text-on-accent disabled:opacity-50"
            >
              {submitting ? (
                <>
                  <Icon name="clock" size={14} className="animate-spin" />
                  Importing…
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
