import { useState } from "react";
import type { AutoPostponeReceipt, DailyWorkUndoAutoPostponeReceiptResult } from "../lib/appApi";
import { Icon } from "./Icon";

export function AutoPostponeReceiptLine({
  receipt,
  onUndo,
}: {
  receipt: AutoPostponeReceipt | null;
  onUndo: (batchId: string) => Promise<DailyWorkUndoAutoPostponeReceiptResult>;
}) {
  const [state, setState] = useState<"idle" | "pending" | "undone" | "error">("idle");
  const [message, setMessage] = useState("");
  if (!receipt) return null;

  const undone = receipt.status === "undone" || state === "undone";
  const minutes = Math.round(receipt.postponedMinutes);
  const bands = receipt.priorityBands.length > 0 ? receipt.priorityBands.join("/") : "low";
  const summary = undone
    ? `${receipt.postponed} item${receipt.postponed === 1 ? "" : "s"} restored`
    : `${receipt.postponed} item${receipt.postponed === 1 ? "" : "s"} slipped`;

  return (
    <div
      className="mb-3 flex items-center justify-between gap-3 rounded-md border border-border bg-surface-2 px-3 py-2 text-sm"
      data-testid="auto-postpone-receipt"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="grid size-7 shrink-0 place-items-center rounded-md bg-surface text-text-2">
          <Icon name={undone ? "checkCircle" : "postpone"} size={15} />
        </span>
        <div className="min-w-0">
          <div className="font-medium text-text">{summary}</div>
          <div className="truncate text-text-3">
            {minutes} min, bands {bands}, {Math.round(receipt.remainingMinutesAfter)} min left on{" "}
            {receipt.localDay}
          </div>
          <div className="sr-only" role="status" aria-live="polite">
            {message}
          </div>
        </div>
      </div>
      {undone ? (
        <span className="shrink-0 text-text-3" data-testid="auto-postpone-receipt-undone">
          Undone
        </span>
      ) : (
        <button
          type="button"
          className="q-priority__button shrink-0"
          data-testid="auto-postpone-receipt-undo"
          disabled={state === "pending"}
          onClick={async () => {
            setState("pending");
            setMessage("Restoring slipped items.");
            try {
              const result = await onUndo(receipt.batchId);
              if (result.undone) {
                setState("undone");
                setMessage("Slipped items restored.");
              } else {
                setState("error");
                setMessage(result.reason ?? "Could not restore items.");
              }
            } catch (error) {
              setState("error");
              setMessage(error instanceof Error ? error.message : "Could not restore items.");
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
