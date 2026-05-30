/**
 * Snackbar (T044) — the shared undo toast.
 *
 * Generalized from the queue's `QueueSnackbar` (T030) so EVERY surface that does an
 * undoable mutation (reader, review, inspector, trash, bulk actions) can reuse one
 * toast. Ported from the design kit's `Snackbar` (`design/kit/app/components.jsx`):
 * a fixed toast at the bottom of the viewport with a message + an "Undo" button,
 * auto-dismissing after the kit's 5s. Pure presentation — it holds NO domain logic;
 * the parent owns the undo call (`appApi.undo.last()` for the general command-level
 * undo, or the queue's recipe undo).
 */

import { useEffect } from "react";
import { Icon } from "./Icon";

/** The auto-dismiss window (ms) — matches the kit's 5s. */
export const SNACKBAR_TIMEOUT_MS = 5000;

export function Snackbar({
  message,
  onUndo,
  onClose,
  testId = "snackbar",
}: {
  /** The toast message, or `null`/empty to render nothing. */
  message: string | null;
  /** The undo handler; omit to hide the Undo button. */
  onUndo?: (() => void) | undefined;
  /** Called when the toast auto-dismisses or is closed. */
  onClose: () => void;
  /** Test hook id (the queue keeps its `queue-snackbar` id for existing specs). */
  testId?: string;
}) {
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(onClose, SNACKBAR_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [message, onClose]);

  if (!message) return null;
  return (
    <div className="snackbar fade-up" role="status" data-testid={testId}>
      <Icon name="trash" size={14} />
      <span>{message}</span>
      {onUndo ? (
        <button
          type="button"
          className="snackbar__undo"
          data-testid={`${testId}-undo`}
          onClick={onUndo}
        >
          <Icon name="undo" size={13} />
          Undo
        </button>
      ) : null}
    </div>
  );
}
