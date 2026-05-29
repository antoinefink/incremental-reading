/**
 * New source modal (T012 — minimal; T013 extends it).
 *
 * A small keyboard-driven dialog reached from the inbox import strip's "Paste
 * text" / "Manual note" options. In T012 it captures a title (and an optional
 * A/B/C/D priority) and creates an inbox source through the typed
 * `appApi.importManualSource` command; T013 adds URL / author / date / body
 * inputs and stores the body as plain text + ProseMirror JSON. Submittable with
 * ⌘↵ / Enter, closeable with Esc — matching the shell's command palette pattern.
 *
 * Pure UI: it gathers field values and calls ONE bridge command; the main process
 * owns persistence + the label→numeric priority mapping (the layering rule).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import { appApi, type PriorityLabelInput } from "../../lib/appApi";
import { Kbd } from "../../shell/Kbd";

const PRIORITY_LABELS: readonly PriorityLabelInput[] = ["A", "B", "C", "D"];

export type NewSourceModalProps = {
  open: boolean;
  onClose: () => void;
  /** Called with the new source id after a successful create. */
  onCreated: (id: string) => void;
};

export function NewSourceModal({ open, onClose, onCreated }: NewSourceModalProps) {
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState<PriorityLabelInput>("C");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset + focus when opened.
  useEffect(() => {
    if (!open) return;
    setTitle("");
    setPriority("C");
    setError(null);
    setSubmitting(false);
    const id = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(id);
  }, [open]);

  const submit = useCallback(async () => {
    const trimmed = title.trim();
    if (trimmed.length === 0 || submitting) return;
    setSubmitting(true);
    try {
      const { id } = await appApi.importManualSource({ title: trimmed, priority });
      onCreated(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }, [title, priority, submitting, onCreated]);

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

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh]"
      data-testid="new-source-modal"
    >
      {/* Backdrop is a real button so click-to-dismiss is keyboard-accessible
          (Esc also closes via the global handler above). */}
      <button
        type="button"
        className="absolute inset-0 bg-black/30"
        aria-label="Close New source"
        tabIndex={-1}
        onClick={onClose}
      />
      <div
        className="relative w-full max-w-lg rounded-xl border border-border bg-surface shadow-lg"
        role="dialog"
        aria-modal="true"
        aria-label="New source"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="flex items-center justify-between border-border border-b px-4 py-3">
            <h2 className="font-semibold text-base text-text">New source</h2>
            <button
              type="button"
              data-testid="new-source-close"
              aria-label="Close"
              onClick={onClose}
              className="rounded p-1 text-text-3 hover:text-text"
            >
              <Icon name="x" size={16} />
            </button>
          </div>

          <div className="space-y-4 px-4 py-4">
            <label className="block">
              <span className="mb-1 block font-medium text-sm text-text-2">Title</span>
              <input
                ref={inputRef}
                data-testid="new-source-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Title of the article, note, or idea…"
                className="w-full rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text outline-none focus:border-accent"
              />
            </label>

            <div>
              <span className="mb-1.5 block font-medium text-sm text-text-2">Priority</span>
              <div className="flex gap-1.5" data-testid="new-source-priority">
                {PRIORITY_LABELS.map((p) => {
                  const active = priority === p;
                  return (
                    <button
                      key={p}
                      type="button"
                      data-testid={`new-source-priority-${p}`}
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
              <p className="text-danger text-sm" data-testid="new-source-error">
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
              data-testid="new-source-submit"
              disabled={title.trim().length === 0 || submitting}
              className="inline-flex items-center gap-2 rounded-md bg-accent px-3.5 py-1.5 font-medium text-sm text-text-on-accent disabled:opacity-50"
            >
              Create source
              <Kbd keys={["⌘", "↵"]} />
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
