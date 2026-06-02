/**
 * OverloadBanner (T077) — the daily queue's overload valve, wiring the kit's
 * `Banner variant="info"` slot (`design/kit/app/screen-queue.jsx`, left unwired in M5).
 *
 * When the due load exceeds today's review budget (`budget.used > budget.target`), this
 * surfaces "N items over today's budget" + an **"Auto-postpone N"** action. Clicking it
 * fetches the READ-ONLY preview (`queue.autoPostpone`) — exactly WHAT would move
 * (low-priority topics first, then low-priority *mature* cards; high-priority *fragile*
 * cards PROTECTED), from→to, and why — so the user sees the cost BEFORE committing. The
 * confirm then calls `queue.autoPostponeApply` (one transaction, one `batchId`), and the
 * parent re-reads the queue + raises an undo snackbar (the existing batch undo restores
 * BOTH `elements.due_at` and `review_states.due_at`).
 *
 * Pure UI orchestration: no SQL, no scheduling/selection math (all of that is the pure
 * `planAutoPostpone` in `@interleave/scheduler` + the `AutoPostponeService` behind IPC).
 * Renders `null` when the queue is within budget.
 */

import { useCallback, useState } from "react";
import { Icon } from "../../components/Icon";
import { type AutoPostponePreview, appApi, isDesktop } from "../../lib/appApi";

export interface OverloadBannerProps {
  /** Items currently due (the budget gauge's `used`). */
  readonly used: number;
  /** The daily review budget target. */
  readonly target: number;
  /** The clock the due reads + plan compare against (ISO-8601), or undefined for "now". */
  readonly asOf?: string;
  /**
   * Called after a successful apply with the postponed count — the parent re-reads the
   * queue and shows the "Postponed N · Undo" snackbar (undo via the batch `undo.last`).
   */
  readonly onPostponed: (count: number) => void;
}

/** A short from→to "moves +Nd" label for one preview row. */
function moveLabel(fromDueAt: string | null, toDueAt: string): string {
  const to = Date.parse(toDueAt);
  const from = fromDueAt ? Date.parse(fromDueAt) : Number.NaN;
  if (Number.isNaN(to) || Number.isNaN(from)) return "rescheduled";
  const days = Math.max(1, Math.round((to - from) / 86_400_000));
  return `+${days}d`;
}

export function OverloadBanner({ used, target, asOf, onPostponed }: OverloadBannerProps) {
  const over = used - target;
  const [preview, setPreview] = useState<AutoPostponePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openPreview = useCallback(async () => {
    if (!isDesktop() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await appApi.previewAutoPostpone(asOf ? { asOf } : undefined);
      setPreview(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [asOf, busy]);

  const confirm = useCallback(async () => {
    if (!isDesktop() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await appApi.applyAutoPostpone(asOf ? { asOf } : undefined);
      setPreview(null);
      onPostponed(result.postponed);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [asOf, busy, onPostponed]);

  // Within budget — the valve is hidden.
  if (over <= 0) return null;

  return (
    <div className="q-overload-banner" data-testid="queue-overload-banner" role="status">
      <Icon name="gauge" size={16} />
      <div className="q-overload-banner__main">
        <div className="q-overload-banner__title" data-testid="queue-overload-count">
          {over} item{over === 1 ? "" : "s"} over today's budget
        </div>
        <div className="q-overload-banner__body">
          High-priority fragile cards are protected. Auto-postpone the lowest-priority topics &amp;
          mature cards to stay on track?
        </div>
        {error ? (
          <div className="q-overload-banner__body" style={{ color: "var(--danger)" }}>
            {error}
          </div>
        ) : null}

        {preview ? (
          <div className="q-postpone-preview" data-testid="queue-postpone-preview">
            {preview.willPostpone.length === 0 ? (
              <div className="q-overload-banner__body">
                Nothing can be safely postponed — only protected high-value items are over budget.
              </div>
            ) : (
              <>
                <div className="q-overload-banner__body">
                  {preview.willPostpone.length} item
                  {preview.willPostpone.length === 1 ? "" : "s"} will move ({preview.remainingAfter}{" "}
                  left after):
                </div>
                <div className="q-postpone-preview__list">
                  {preview.willPostpone.map((row) => (
                    <div
                      key={row.id}
                      className="q-postpone-preview__row"
                      data-testid="queue-postpone-row"
                    >
                      <span className="q-postpone-preview__row-title">{row.title}</span>
                      <span className="q-postpone-preview__row-move">
                        {moveLabel(row.fromDueAt, row.toDueAt)}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
            <div className="q-postpone-preview__confirm">
              <button
                type="button"
                className="q-overload-banner__btn"
                data-testid="queue-postpone-confirm"
                disabled={busy || preview.willPostpone.length === 0}
                onClick={() => void confirm()}
              >
                <Icon name="postpone" size={14} />
                Postpone {preview.willPostpone.length}
              </button>
              <button
                type="button"
                className="q-overload-banner__btn"
                data-testid="queue-postpone-cancel"
                disabled={busy}
                onClick={() => setPreview(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {preview ? null : (
        <div className="q-overload-banner__actions">
          <button
            type="button"
            className="q-overload-banner__btn"
            data-testid="queue-auto-postpone"
            disabled={busy}
            onClick={() => void openPreview()}
          >
            <Icon name="postpone" size={14} />
            Auto-postpone {over}
          </button>
        </div>
      )}
    </div>
  );
}
