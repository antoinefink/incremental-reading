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
import { Icon, type IconName } from "./Icon";

/** The auto-dismiss window (ms) — matches the kit's 5s. */
export const SNACKBAR_TIMEOUT_MS = 5000;

/**
 * A longer auto-dismiss window for a snackbar whose Undo restores a LARGE,
 * order-independent batch (T135 — a branch delete of many nodes). The extra time
 * keeps the only cheap "undo the whole branch" affordance reachable a bit longer
 * than an everyday single-row delete.
 */
export const SNACKBAR_TIMEOUT_LONG_MS = 9000;

export function Snackbar({
  message,
  onUndo,
  onClose,
  testId = "snackbar",
  icon = "trash",
  timeoutMs = SNACKBAR_TIMEOUT_MS,
}: {
  /** The toast message, or `null`/empty to render nothing. */
  message: string | null;
  /** The undo handler; omit to hide the Undo button. */
  onUndo?: (() => void) | undefined;
  /** Called when the toast auto-dismisses or is closed. */
  onClose: () => void;
  /** Test hook id (the queue keeps its `queue-snackbar` id for existing specs). */
  testId?: string;
  /**
   * The leading icon (default `trash` — the delete/undo toast). Pass `check`
   * (CircleCheck per icon-map) for the honorable mark-done / topic-rest variant so a
   * "kept alive" outcome doesn't read as a destructive one (T135).
   */
  icon?: IconName;
  /** Override the auto-dismiss window (e.g. {@link SNACKBAR_TIMEOUT_LONG_MS} for a big batch). */
  timeoutMs?: number | undefined;
}) {
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(onClose, timeoutMs);
    return () => clearTimeout(t);
  }, [message, onClose, timeoutMs]);

  if (!message) return null;
  return (
    <div className="snackbar fade-up" role="status" data-testid={testId}>
      <Icon name={icon} size={14} />
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
