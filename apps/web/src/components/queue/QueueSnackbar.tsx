/**
 * QueueSnackbar (T030) — the undo snackbar for destructive/removing queue actions.
 *
 * Ported from the design kit's `Snackbar` (`design/kit/app/components.jsx`): a fixed
 * toast at the bottom of the viewport with a message + an "Undo" button, auto-dismissing
 * after a short window (the kit's 5s). The queue surfaces it after done / dismiss /
 * delete so the action is recoverable WITHOUT navigating away from the list — undo
 * restores the row (soft-deleted → `restore`; done/dismiss → prior status) and re-reads
 * the queue. Pure presentation: it holds no domain logic; the parent owns the undo call.
 */

import { useEffect } from "react";
import { Icon } from "../Icon";

/** The auto-dismiss window (ms) — matches the kit's 5s. */
const SNACKBAR_TIMEOUT_MS = 5000;

export function QueueSnackbar({
  message,
  onUndo,
  onClose,
}: {
  /** The toast message, or `null`/empty to render nothing. */
  message: string | null;
  /** The undo handler; omit to hide the Undo button. */
  onUndo?: (() => void) | undefined;
  /** Called when the toast auto-dismisses or is closed. */
  onClose: () => void;
}) {
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(onClose, SNACKBAR_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [message, onClose]);

  if (!message) return null;
  return (
    <div className="snackbar fade-up" role="status" data-testid="queue-snackbar">
      <Icon name="trash" size={14} />
      <span>{message}</span>
      {onUndo ? (
        <button
          type="button"
          className="snackbar__undo"
          data-testid="queue-snackbar-undo"
          onClick={onUndo}
        >
          <Icon name="undo" size={13} />
          Undo
        </button>
      ) : null}
    </div>
  );
}
