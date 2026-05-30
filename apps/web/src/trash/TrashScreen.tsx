/**
 * Trash view (T044) — recover or permanently delete soft-deleted elements.
 *
 * Rebuilt from the design kit's `TrashScreen` (`design/kit/app/screen-extra.jsx`):
 * a centered column of `result` rows, each with a `TypeIcon`, a dimmed title, a
 * "{type} · from {source} · deleted {when}" meta line, and per-row Restore +
 * permanent-delete buttons; an "Empty trash" action in the head; an `EmptyState`
 * "Trash is empty"; and the "deleted items are recoverable for {N} days" sub.
 *
 * Architecture (non-negotiable): this is UI ONLY — no SQL, no soft-delete/restore
 * logic. The trash list comes from `appApi.listTrash()` (read-only); Restore /
 * Purge / Empty are typed `appApi.*` calls over the preload bridge, and the main
 * process owns the transaction + the `operation_log` op (restore appends
 * `restore_element`; purge is the only hard delete and appends no op). Restore +
 * the general undo (`appApi.undoLast()`) make accidental deletion recoverable;
 * permanent delete + Empty trash are confirmation-gated (the only destruction).
 */

import { useCallback, useEffect, useState } from "react";
import { Icon, type IconName } from "../components/Icon";
import { Snackbar } from "../components/Snackbar";
import { appApi, isDesktop, type TrashItemSummary } from "../lib/appApi";
import "./trash.css";

/** The lucide icon for an element type (mirrors the kit's `TypeIcon`). */
function typeIcon(type: string): IconName {
  switch (type) {
    case "source":
      return "library";
    case "extract":
      return "layers";
    case "card":
      return "review";
    case "topic":
      return "concepts";
    case "task":
      return "checkCircle";
    default:
      return "inbox";
  }
}

/** A short "deleted {relative}" label from an ISO timestamp. */
function deletedAgo(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "recently";
  const mins = Math.max(0, Math.round((now - then) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export function TrashScreen() {
  const desktop = isDesktop();
  const [items, setItems] = useState<readonly TrashItemSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [confirmPurgeId, setConfirmPurgeId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; onUndo?: () => void } | null>(null);

  const load = useCallback(async () => {
    if (!isDesktop()) {
      setLoading(false);
      return;
    }
    try {
      const res = await appApi.listTrash();
      setItems(res.items);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const restore = useCallback(
    async (item: TrashItemSummary) => {
      setBusyId(item.id);
      setError(null);
      try {
        await appApi.restoreFromTrash({ id: item.id });
        await load();
        // The restore is itself undoable via the general command-level undo
        // (re-trashes the element); offer it on the toast.
        setToast({
          message: `Restored · ${item.title.slice(0, 40)}`,
          onUndo: async () => {
            await appApi.undoLast();
            await load();
            setToast(null);
          },
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  const purge = useCallback(
    async (id: string) => {
      setBusyId(id);
      setConfirmPurgeId(null);
      setError(null);
      try {
        await appApi.purgeFromTrash({ id });
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  const empty = useCallback(async () => {
    setConfirmEmpty(false);
    setError(null);
    try {
      await appApi.emptyTrash();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [load]);

  if (!desktop) {
    return (
      <div className="trash-shell" data-testid="route-trash">
        <div className="trash-empty">
          <div className="trash-empty__icon">
            <Icon name="trash" size={26} />
          </div>
          <h1 className="trash-empty__title">Trash</h1>
          <p className="trash-empty__body">
            Deleted sources, extracts, and cards land here first and can be restored — open the
            Electron app to recover them.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="trash-shell" data-testid="route-trash">
      <div className="trash-head">
        <div>
          <h1 className="trash-title">Trash</h1>
          <p className="trash-sub">Local-first · deleted items are recoverable for 30 days</p>
        </div>
        {items.length > 0 ? (
          confirmEmpty ? (
            <div className="trash-confirm" data-testid="trash-empty-confirm">
              <span>Permanently delete all {items.length}?</span>
              <button
                type="button"
                className="trash-btn trash-btn--danger"
                data-testid="trash-empty-yes"
                onClick={() => void empty()}
              >
                Empty trash
              </button>
              <button
                type="button"
                className="trash-btn"
                data-testid="trash-empty-cancel"
                onClick={() => setConfirmEmpty(false)}
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="trash-btn trash-btn--danger"
              data-testid="trash-empty"
              onClick={() => setConfirmEmpty(true)}
            >
              <Icon name="trash" size={14} />
              Empty trash
            </button>
          )
        ) : null}
      </div>

      {error ? (
        <p className="trash-error" data-testid="trash-error">
          {error}
        </p>
      ) : null}

      {loading ? (
        <p className="trash-loading" data-testid="trash-loading">
          Loading…
        </p>
      ) : items.length === 0 ? (
        <div className="trash-empty" data-testid="trash-empty-state">
          <div className="trash-empty__icon">
            <Icon name="trash" size={26} />
          </div>
          <h2 className="trash-empty__title">Trash is empty</h2>
          <p className="trash-empty__body">
            Nothing to recover. Deleted sources, extracts, and cards land here first and can be
            restored.
          </p>
        </div>
      ) : (
        <div className="trash-list" data-testid="trash-list">
          {items.map((item) => (
            <div className="trash-row" key={item.id} data-testid="trash-row" data-id={item.id}>
              <span className="trash-row__icon">
                <Icon name={typeIcon(item.type)} size={16} />
              </span>
              <div className="trash-row__body">
                <div className="trash-row__title" data-testid="trash-row-title">
                  {item.title}
                </div>
                <div className="trash-row__meta">
                  <span className="trash-row__type">{item.type}</span>
                  {item.sourceTitle ? (
                    <>
                      <span className="trash-row__dot">·</span>
                      <span>from {item.sourceTitle}</span>
                    </>
                  ) : null}
                  <span className="trash-row__dot">·</span>
                  <span>deleted {deletedAgo(item.deletedAt)}</span>
                </div>
              </div>
              <div className="trash-row__actions">
                <button
                  type="button"
                  className="trash-btn"
                  data-testid="trash-restore"
                  disabled={busyId === item.id}
                  onClick={() => void restore(item)}
                >
                  <Icon name="restore" size={14} />
                  Restore
                </button>
                {confirmPurgeId === item.id ? (
                  <>
                    <button
                      type="button"
                      className="trash-btn trash-btn--danger"
                      data-testid="trash-purge-yes"
                      disabled={busyId === item.id}
                      onClick={() => void purge(item.id)}
                    >
                      Delete forever
                    </button>
                    <button
                      type="button"
                      className="trash-btn"
                      data-testid="trash-purge-cancel"
                      onClick={() => setConfirmPurgeId(null)}
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="trash-btn trash-btn--icon trash-btn--danger"
                    data-testid="trash-purge"
                    title="Delete permanently"
                    aria-label="Delete permanently"
                    disabled={busyId === item.id}
                    onClick={() => setConfirmPurgeId(item.id)}
                  >
                    <Icon name="trash" size={14} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <Snackbar
        message={toast?.message ?? null}
        onUndo={toast?.onUndo}
        onClose={() => setToast(null)}
        testId="trash-snackbar"
      />
    </div>
  );
}
