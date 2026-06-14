/**
 * Card-edit write-barrier choice + receipt (T125) — the renderer half.
 *
 * A SUBSTANTIVE card-body rewrite stops inheriting the FSRS stability its old
 * formulation earned. At the explicit COMMIT of an edit (Done / Resolve — never an
 * autosave; autosaves stay body-only and keep the schedule), the host renders
 * {@link ReStabilizeChoice}. It classifies the edit with the pure `classifyCardEdit`
 * heuristic and:
 *  - **typo** (or an occlusion-label tweak) → resolves immediately, no UI, schedule kept;
 *  - **substantive** → offers a compact keep-schedule vs re-verify-soon choice,
 *    pre-selected to re-verify (the spec's "defaults sensibly"), `K` flips, `Enter`
 *    confirms. Only `re_stabilize` sends `editChoice` to demote the PERSISTED state.
 *
 * After a demotion the host shows {@link ReStabilizeReceipt} — a one-tap "Keep schedule
 * instead" reversal (the guarded receipt undo). UI only: every mutation is a typed
 * `appApi.*` call; the main process owns the transaction + the FSRS demotion.
 */

import { type CardEditBody, classifyCardEdit } from "@interleave/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { appApi, type CardReStabilizeSummary } from "../lib/appApi";

/** The outcome the host acts on after the choice resolves. */
export interface ReStabilizeChoiceResult {
  /** The demotion receipt when the user re-stabilized; `null` when the schedule was kept. */
  readonly reStabilized: CardReStabilizeSummary | null;
}

interface ReStabilizeChoiceProps {
  readonly cardId: string;
  /** The card kind (`qa` / `cloze` / `image_occlusion`). */
  readonly kind: string;
  /** The body BEFORE the edit (captured when the editor opened). */
  readonly before: CardEditBody;
  /** The committed body AFTER the edit. */
  readonly after: CardEditBody;
  /** Resolve the choice (or, for a typo, resolve immediately with no UI). */
  readonly onResolved: (result: ReStabilizeChoiceResult) => void;
}

/** Build the `cards.update` body patch from the committed body for the kind. */
function bodyPatch(
  kind: string,
  body: CardEditBody,
): { prompt?: string; answer?: string; cloze?: string } {
  if (kind === "cloze") return { cloze: body.cloze ?? "" };
  if (kind === "image_occlusion") return { answer: body.answer ?? "" };
  return { prompt: body.prompt ?? "", answer: body.answer ?? "" };
}

export function ReStabilizeChoice({
  cardId,
  kind,
  before,
  after,
  onResolved,
}: ReStabilizeChoiceProps) {
  // Only Q&A / cloze cards carry answer-bearing prose the classifier reasons about; an
  // occlusion label tweak is treated as a typo (no demotion).
  const isSubstantive =
    (kind === "qa" || kind === "cloze") &&
    classifyCardEdit(kind, before, after).editClass === "substantive";
  const [choice, setChoice] = useState<"re_stabilize" | "keep">("re_stabilize");
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resolvedRef = useRef(false);

  const resolve = useCallback(
    (result: ReStabilizeChoiceResult) => {
      if (resolvedRef.current) return;
      resolvedRef.current = true;
      onResolved(result);
    },
    [onResolved],
  );

  // A typo edit needs no decision — resolve once, keeping the schedule.
  useEffect(() => {
    if (!isSubstantive) resolve({ reStabilized: null });
  }, [isSubstantive, resolve]);

  const confirm = useCallback(async () => {
    if (applying || resolvedRef.current) return;
    if (choice === "keep") {
      // The body was already saved by the host's autosave/commit — keep the schedule.
      resolve({ reStabilized: null });
      return;
    }
    setApplying(true);
    setError(null);
    try {
      const res = await appApi.updateCard({
        cardId,
        ...bodyPatch(kind, after),
        editChoice: "re_stabilize",
      });
      resolve({ reStabilized: res.reStabilized });
    } catch (e) {
      // Do NOT silently fall back to keep-schedule: the user asked to re-verify and the
      // demotion failed. Surface the error so they can retry or explicitly keep the
      // schedule — never pretend the schedule was kept on purpose.
      setError(e instanceof Error ? e.message : String(e));
      setApplying(false);
    }
  }, [applying, choice, cardId, kind, after, resolve]);

  // Keyboard: `K` flips the selection, `Enter` confirms. Scoped to the choice (ignored
  // while a text field has focus) so it never collides with the repair bar's E/S keys.
  useEffect(() => {
    if (!isSubstantive) return;
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
      const k = e.key.toLowerCase();
      if (k === "k") {
        e.preventDefault();
        setChoice((c) => (c === "re_stabilize" ? "keep" : "re_stabilize"));
      } else if (e.key === "Enter") {
        e.preventDefault();
        void confirm();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isSubstantive, confirm]);

  if (!isSubstantive) return null;

  return (
    <div className="rv-restab" data-testid="restabilize-choice">
      <p className="rv-restab__prompt">
        You changed the answer. Re-verify the new wording soon, or keep its schedule?
      </p>
      <div className="rv-restab__options">
        <button
          type="button"
          aria-pressed={choice === "re_stabilize"}
          className={`rv-restab__opt${choice === "re_stabilize" ? " rv-restab__opt--active" : ""}`}
          data-testid="restabilize-choice-reverify"
          disabled={applying}
          onClick={() => setChoice("re_stabilize")}
        >
          <Icon name="clock" size={14} />
          Re-verify soon
        </button>
        <button
          type="button"
          aria-pressed={choice === "keep"}
          className={`rv-restab__opt${choice === "keep" ? " rv-restab__opt--active" : ""}`}
          data-testid="restabilize-choice-keep"
          disabled={applying}
          onClick={() => setChoice("keep")}
        >
          Keep schedule
        </button>
        <span className="rv-restab__hint">K to flip · Enter to confirm</span>
        <button
          type="button"
          className="rv-btn rv-btn--primary"
          data-testid="restabilize-choice-confirm"
          disabled={applying}
          onClick={() => void confirm()}
        >
          Confirm
        </button>
      </div>
      {error ? (
        <p className="rv-edit__error" data-testid="restabilize-choice-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

interface ReStabilizeReceiptProps {
  readonly cardId: string;
  readonly reviewLogId: string;
  /** Dismiss the receipt (after an undo, or when the host advances). */
  readonly onDone: () => void;
}

/**
 * The "Re-verifying soon · Keep schedule instead" receipt shown after a demotion. The
 * undo restores the exact prior FSRS schedule (guarded — refused if the card was reviewed
 * since the edit). UI only.
 */
export function ReStabilizeReceipt({ cardId, reviewLogId, onDone }: ReStabilizeReceiptProps) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const undo = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await appApi.reStabilizeUndoCard({ cardId, reviewLogId });
      if (res.undone) {
        onDone();
      } else {
        setNote(res.reason ?? "Couldn't keep the schedule");
        setBusy(false);
      }
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }, [busy, cardId, reviewLogId, onDone]);

  return (
    <div className="rv-restab-receipt" data-testid="restabilize-receipt" role="status">
      <span className="rv-restab-receipt__msg">
        <Icon name="clock" size={14} />
        Re-verifying soon
      </span>
      {note ? (
        <span className="rv-restab-receipt__note">{note}</span>
      ) : (
        <button
          type="button"
          className="rv-restab-receipt__undo"
          data-testid="restabilize-receipt-undo"
          disabled={busy}
          onClick={() => void undo()}
        >
          Keep schedule instead
        </button>
      )}
      <button
        type="button"
        className="rv-restab-receipt__dismiss"
        aria-label="Dismiss"
        data-testid="restabilize-receipt-dismiss"
        onClick={onDone}
      >
        <Icon name="x" size={13} />
      </button>
    </div>
  );
}
