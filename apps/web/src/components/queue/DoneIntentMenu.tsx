/**
 * DoneIntentMenu — the partial-source "Done" intent surface.
 *
 * Replaces the native `window.confirm("N unresolved blocks. Mark it done anyway?")` at the
 * three done-gate call sites (the in-session queue loop, the queue list rows, and the
 * standalone reader) with ONE shared, non-modal, keyboard-navigable popover. Pressing Done
 * on a source that still has unresolved blocks no longer asks a scary yes/no — it offers the
 * three real intents, defaulting focus to the safe one:
 *
 *   • Return later (default) — postpone; keep the read-point, stay in rotation
 *   • Finished               — mark done (the server gate's confirm override is passed)
 *   • Abandon                — dismiss; drop it from the queue
 *
 * Self-contained like {@link ScheduleMenu}: it owns its trigger button + the anchored popover,
 * closes on outside-click / Escape, and focuses the default choice on open. It adds a
 * `getSummary` callback so the FAST PATH (0 unresolved → mark done with no popover) lives in
 * one place rather than being re-derived at each site, and a `triggerSignal` so a keyboard
 * shortcut (`d`) can run the exact same click logic. An internal in-flight guard drops a
 * double-submit regardless of the host's busy model.
 *
 * The server gate stays authoritative: "Finished" routes through the host's `onResolved`, which
 * calls `markDone` with the `confirmUnresolvedBlocks` override — this component never decides
 * completion, it only collects intent and renders an honest per-state breakdown. Pure UI +
 * one summary read; design tokens only.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { SourceBlockProcessingSummaryPayload } from "../../lib/appApi";
import { describeUnresolved, pluralizeBlocks } from "../../pages/queue/doneIntentBreakdown";
import { Icon, type IconName } from "../Icon";
import { Tooltip } from "../Tooltip";
import "./done-intent-menu.css";

/** The three outcome intents the surface collects; the host maps them to mutations. */
export type DoneIntent = "later" | "finished" | "abandon";

const CHOICES: readonly {
  intent: DoneIntent;
  icon: IconName;
  label: string;
  hint: string;
  testId: string;
  danger?: boolean;
}[] = [
  {
    intent: "later",
    icon: "postpone",
    label: "Return later",
    hint: "Keep it in rotation",
    testId: "done-intent-later",
  },
  {
    intent: "finished",
    icon: "checkCircle",
    label: "Finished",
    hint: "Done with this source",
    testId: "done-intent-finished",
  },
  {
    intent: "abandon",
    icon: "x",
    label: "Abandon",
    hint: "Drop it from the queue",
    testId: "done-intent-abandon",
    danger: true,
  },
];

export function DoneIntentMenu({
  getSummary,
  onResolved,
  busy = false,
  resumeLabel = null,
  triggerSignal,
  triggerClassName = "doneintent__trigger",
  triggerIcon = "check",
  triggerLabel,
  triggerTestId = "done-intent-trigger",
  tooltipLabel = "Mark done",
  triggerAriaLabel = "Mark done",
}: {
  /**
   * Fetch the current block-processing summary for the source. Returns `null` to abort
   * silently (e.g. a failed read the host already surfaced). Drives the fast path: when
   * `canMarkDoneWithoutConfirmation` is true the surface marks done immediately with no popover.
   */
  getSummary: () => Promise<SourceBlockProcessingSummaryPayload | null>;
  /** Apply one chosen intent. The host owns the mutation, post-action, and undo. */
  onResolved: (intent: DoneIntent) => void;
  /** Host-level busy (in flight elsewhere): disables the trigger and choices. */
  busy?: boolean;
  /** Optional resume location ("block N of M"); omitted when no read-point exists. */
  resumeLabel?: string | null;
  /** Increment/change to run the trigger logic from an external shortcut (the `d` key). */
  triggerSignal?: number;
  triggerClassName?: string;
  triggerIcon?: IconName;
  /** Optional visible label; omit for a compact icon-only trigger. */
  triggerLabel?: string;
  triggerTestId?: string;
  tooltipLabel?: string;
  triggerAriaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState<SourceBlockProcessingSummaryPayload | null>(null);
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const laterRef = useRef<HTMLButtonElement>(null);
  const submittingRef = useRef(false);
  const fetchingRef = useRef(false);
  const triggerSignalRef = useRef(triggerSignal);

  const handleTrigger = useCallback(async () => {
    // Re-press toggles the popover closed (matches the `d`/click cancel affordance).
    if (open) {
      setOpen(false);
      return;
    }
    if (busy || fetchingRef.current || submittingRef.current) return;
    fetchingRef.current = true;
    try {
      const s = await getSummary();
      if (!s) return;
      if (s.canMarkDoneWithoutConfirmation) {
        // Fast path: nothing unresolved — mark done immediately, no surface.
        submittingRef.current = true;
        onResolved("finished");
        return;
      }
      setSummary(s);
      setOpen(true);
    } finally {
      fetchingRef.current = false;
    }
  }, [open, busy, getSummary, onResolved]);

  // External trigger (keyboard `d`): run the SAME click logic (fetch → fast-path or open).
  useEffect(() => {
    if (triggerSignal === undefined || triggerSignalRef.current === triggerSignal) return;
    triggerSignalRef.current = triggerSignal;
    void handleTrigger();
  }, [triggerSignal, handleTrigger]);

  // Reset the in-flight guard whenever the popover closes.
  useEffect(() => {
    if (!open) submittingRef.current = false;
  }, [open]);

  // Focus the default (Return later) on open; close on outside-click / Escape, restoring
  // focus to the trigger on Escape (keyboard-first hygiene; non-modal so no focus trap).
  useEffect(() => {
    if (!open) return;
    laterRef.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const choose = useCallback(
    (intent: DoneIntent) => {
      if (submittingRef.current) return;
      submittingRef.current = true;
      setOpen(false);
      onResolved(intent);
    },
    [onResolved],
  );

  const segments = summary ? describeUnresolved(summary.stateCounts) : [];

  return (
    <span className="doneintent" ref={rootRef} data-testid="done-intent">
      <Tooltip label={tooltipLabel} disabled={open}>
        <button
          type="button"
          ref={triggerRef}
          className={triggerClassName}
          disabled={busy}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={triggerAriaLabel}
          data-testid={triggerTestId}
          onClick={() => void handleTrigger()}
        >
          <Icon name={triggerIcon} size={14} />
          {triggerLabel ? <span>{triggerLabel}</span> : null}
        </button>
      </Tooltip>
      {open && summary ? (
        <div
          className="doneintent__pop"
          role="dialog"
          aria-modal="false"
          aria-label={`Mark done — ${pluralizeBlocks(summary.unresolvedBlocks)} still open`}
          data-testid="done-intent-pop"
        >
          <div className="doneintent__head">
            <span className="doneintent__count">
              {pluralizeBlocks(summary.unresolvedBlocks)} still open
            </span>
            {resumeLabel ? (
              <span className="doneintent__resume" data-testid="done-intent-resume">
                {resumeLabel}
              </span>
            ) : null}
          </div>
          {segments.length > 0 ? (
            <ul className="doneintent__breakdown" data-testid="done-intent-breakdown">
              {segments.map((s) => (
                <li key={s.key}>
                  <span className="doneintent__seg-count">{s.count}</span> {s.label}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="doneintent__choices">
            {CHOICES.map((c) => (
              <button
                type="button"
                key={c.intent}
                ref={c.intent === "later" ? laterRef : undefined}
                className={`doneintent__choice${c.danger ? " doneintent__choice--danger" : ""}`}
                data-testid={c.testId}
                disabled={busy}
                onClick={() => choose(c.intent)}
              >
                <Icon name={c.icon} size={15} />
                <span className="doneintent__choice-text">
                  <span className="doneintent__choice-label">{c.label}</span>
                  <span className="doneintent__choice-hint">{c.hint}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </span>
  );
}
