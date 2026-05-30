/**
 * QueueSnackbar (T030) — the undo snackbar for the daily queue's removing actions.
 *
 * Now a thin wrapper over the shared {@link Snackbar} (generalized in T044) so the
 * queue keeps its `queue-snackbar` test hooks while the toast presentation lives in
 * one place. The queue surfaces it after done / dismiss / delete so the action is
 * recoverable WITHOUT navigating away from the list — undo restores the row (the
 * queue's recipe undo). Pure presentation: the parent owns the undo call.
 */

import { Snackbar } from "../Snackbar";

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
  return <Snackbar message={message} onUndo={onUndo} onClose={onClose} testId="queue-snackbar" />;
}
