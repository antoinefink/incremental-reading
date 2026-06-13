import { useState } from "react";
import type { ExtractAgingReceipt, ExtractAgingUndoReceiptResult } from "../lib/appApi";
import { Icon } from "./Icon";

export function ExtractAgingReceiptLine({
  receipt,
  onUndo,
}: {
  receipt: ExtractAgingReceipt | null;
  onUndo: (batchId: string) => Promise<ExtractAgingUndoReceiptResult>;
}) {
  const [state, setState] = useState<"idle" | "pending" | "undone" | "error">("idle");
  const [message, setMessage] = useState("");
  if (!receipt) return null;

  const undone = receipt.status === "undone" || state === "undone";
  const summary = undone
    ? `${receipt.demoted} extract${receipt.demoted === 1 ? "" : "s"} restored`
    : `${receipt.demoted} extract${receipt.demoted === 1 ? "" : "s"} returned to reference`;
  const remaining =
    receipt.remainingCandidateCount > 0
      ? `${receipt.remainingCandidateCount} still eligible`
      : "sweep complete";

  return (
    <div
      className="mb-3 flex items-center justify-between gap-3 rounded-md border border-border bg-surface-2 px-3 py-2 text-sm"
      data-testid="extract-aging-receipt"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="grid size-7 shrink-0 place-items-center rounded-md bg-surface text-text-2">
          <Icon name={undone ? "checkCircle" : "extract"} size={15} />
        </span>
        <div className="min-w-0">
          <div className="font-medium text-text">{summary}</div>
          <div className="truncate text-text-3">
            {receipt.policy}, after {receipt.thresholds.returnThreshold} returns /{" "}
            {receipt.thresholds.ageDays} days, {remaining} on {receipt.localDay}
          </div>
          <div className="sr-only" role="status" aria-live="polite">
            {message}
          </div>
        </div>
      </div>
      {undone ? (
        <span className="shrink-0 text-text-3" data-testid="extract-aging-receipt-undone">
          Undone
        </span>
      ) : (
        <button
          type="button"
          className="q-priority__button shrink-0"
          data-testid="extract-aging-receipt-undo"
          disabled={state === "pending"}
          onClick={async () => {
            setState("pending");
            setMessage("Restoring returned extracts.");
            try {
              const result = await onUndo(receipt.batchId);
              if (result.undo.undone) {
                setState("undone");
                setMessage("Returned extracts restored.");
              } else {
                setState("error");
                setMessage(result.undo.reason ?? "Could not restore extracts.");
              }
            } catch (error) {
              setState("error");
              setMessage(error instanceof Error ? error.message : "Could not restore extracts.");
            }
          }}
        >
          <Icon name="undo" size={13} />
          {state === "pending" ? "Undoing" : state === "error" ? "Retry" : "Undo"}
        </button>
      )}
    </div>
  );
}
