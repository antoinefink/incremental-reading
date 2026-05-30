/**
 * "Process queue" learning loop (T031) — the keyboard-first daily grind.
 *
 * Takes the T029 due queue (`queue.list`, honoring the active filters/clock) and
 * presents it ONE ELEMENT AT A TIME, rendering the right surface for each type —
 * a compact read/process panel for attention items (source / topic / extract /
 * task) and a card prompt/reveal STUB for cards (full FSRS grading is M7/T037) —
 * with the T030 actions (open-in-full / postpone / raise / lower / done / dismiss /
 * delete / skip) available inline. After EVERY action it advances the cursor to the
 * next due item automatically, so a user can process ten mixed sources/extracts/
 * cards end to end WITHOUT ever returning to the list. A progress readout
 * ("3 / 12 · est. N min") and a presentational budget/mode `Segmented` header frame
 * the session; finishing shows the "Queue clear" done state.
 *
 * Architecture (non-negotiable): the loop introduces NO new mutation path — every
 * action calls the SAME typed `appApi.actOnQueueItem` (`queue.act`) /
 * `appApi.setElementPriority` (`elements.setPriority`) commands the queue list uses,
 * so the keyboard shortcuts (T048) and the list (T030) stay in sync behind one
 * validated IPC surface. The renderer never touches SQLite/Node/fs. Cards stay on
 * FSRS, attention items on the attention scheduler — the chip + scheduling never
 * cross. Sibling-card burying (T039) and "due cards first" ordering refinements are
 * M7-side: the loop consumes the order `queue.list` gives it and leaves that seam.
 *
 * Pure UI orchestration — no SQL, no scheduling math, no priority math.
 */

import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "../../components/Icon";
import { Prio, SchedulerChip, Stage, TypeIcon } from "../../components/inspector/primitives";
import "../../components/inspector/inspector.css";
import {
  appApi,
  isDesktop,
  type QueueActAction,
  type QueueItemSummary,
  type QueueListResult,
  type SchedulerSignals,
} from "../../lib/appApi";
import { useActiveScope } from "../../shell/activeScope";
import { useSelection } from "../../shell/selection";
import { jitterOrder } from "./jitter";
import "./queue.css";
import "./process-queue.css";
import { useProcessShortcuts } from "./useProcessShortcuts";

/** Presentational "which slice to process" mode (steering only — auto-postpone is M16). */
type SessionMode = "full" | "review" | "read";
const MODES: readonly { id: SessionMode; label: string; icon: IconName }[] = [
  { id: "full", label: "Full", icon: "layers" },
  { id: "review", label: "Review-only", icon: "review" },
  { id: "read", label: "Reading-only", icon: "bookmark" },
];

/** The inline non-open actions a loop item exposes (the T030 set + skip). */
type LoopActionKind = QueueActAction["kind"];

/** A loaded body preview for the current item (attention items render their text). */
interface ItemBody {
  readonly title: string;
  readonly sourceTitle: string | null;
  readonly bodyText: string | null;
}

/** The per-type title prefix (mirrors the queue list). */
function titleFor(item: QueueItemSummary): string {
  if (item.type === "card") {
    const prefix = item.cardType === "cloze" ? "Cloze · " : "Q&A · ";
    return prefix + item.title.replace(/\{\{(.+?)\}\}/, "[…]");
  }
  if (item.type === "extract") return `Extract · ${item.title}`;
  if (item.type === "topic") return `Topic · ${item.title}`;
  return item.title;
}

/** The chip shape the SchedulerChip expects, from the queue's trimmed signals. */
function chipSignals(item: QueueItemSummary): SchedulerSignals {
  return {
    kind: item.schedulerSignals.kind,
    retrievability: item.schedulerSignals.retrievability,
    stability: item.schedulerSignals.stability,
    difficulty: null,
    reps: null,
    lapses: null,
    fsrsState: null,
    stage: item.schedulerSignals.stage,
    postponed: item.schedulerSignals.postponed,
    lastProcessedAt: null,
  };
}

/** Whether the current mode keeps this item in the loop (presentational steering). */
function modeIncludes(mode: SessionMode, item: QueueItemSummary): boolean {
  if (mode === "full") return true;
  if (mode === "review") return item.type === "card";
  // "read" → reading/processing items (sources/topics/extracts/tasks), not cards.
  return item.type !== "card";
}

export function ProcessQueue() {
  const desktop = isDesktop();
  const navigate = useNavigate();
  const { select } = useSelection();
  // The route declares no `validateSearch`, so search is loosely typed — an
  // optional `asOf` date-scopes the due reads (the E2E drives a fixed clock) and an
  // optional `mode` seeds the session slice.
  const search = useSearch({ strict: false }) as { asOf?: string; mode?: string };
  const asOf = typeof search.asOf === "string" ? search.asOf : undefined;

  const [data, setData] = useState<QueueListResult | null>(null);
  const [mode, setMode] = useState<SessionMode>(
    search.mode === "review" || search.mode === "read" ? search.mode : "full",
  );
  /** Index into the ordered, mode-filtered session list. */
  const [cursor, setCursor] = useState(0);
  /** How many items the user has acted on this session (for the progress readout). */
  const [processed, setProcessed] = useState(0);
  const [body, setBody] = useState<ItemBody | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The ordered session list: the read's deterministic priority-then-due sort, the
  // stable seeded jitter (so the user isn't trapped in one topic), then the mode
  // slice. Frozen for the session's lifetime via the initial fetch — the cursor
  // walks THIS order; acting on an item just advances the cursor (we never re-read
  // and reshuffle mid-session, which would yank the ground out from under the user).
  const [order, setOrder] = useState<QueueItemSummary[]>([]);

  const total = order.length;
  const current = cursor < total ? order[cursor] : null;
  const done = total === 0 || cursor >= total;
  const estMin = Math.max(8, total * 2);

  // Read the latest mode without making `load` depend on it: switching mode
  // re-slices the already-loaded items via `onModeChange` (no re-fetch), so a load
  // triggered by the clock alone should use whatever mode is current.
  const modeRef = useRef(mode);
  modeRef.current = mode;

  // Load the queue once on mount (and when the clock changes). The loop freezes the
  // order at load so the cursor is stable; subsequent actions advance the cursor.
  const load = useCallback(async () => {
    if (!isDesktop()) return;
    try {
      const next = await appApi.listQueue(asOf ? { asOf } : undefined);
      setData(next);
      setError(null);
      const jittered = jitterOrder(next.items);
      setOrder(jittered.filter((i) => modeIncludes(modeRef.current, i)));
      setCursor(0);
      setProcessed(0);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [asOf]);

  useEffect(() => {
    void load();
  }, [load]);

  // Load the current item's body preview (attention items show their text; cards
  // show their prompt from the summary). Read-only, through the typed bridge.
  useEffect(() => {
    let cancelled = false;
    if (!current || current.type === "card") {
      setBody(null);
      return;
    }
    void (async () => {
      try {
        const [doc, insp] = await Promise.all([
          appApi.getDocument({ elementId: current.id }),
          appApi.getInspectorData({ id: current.id }),
        ]);
        if (cancelled) return;
        setBody({
          title: insp.data?.element.title ?? current.title,
          sourceTitle: insp.data?.source?.title ?? current.sourceTitle,
          bodyText: doc.document?.plainText ?? null,
        });
      } catch {
        if (cancelled) return;
        setBody({ title: current.title, sourceTitle: current.sourceTitle, bodyText: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [current]);

  // Selecting the current item drives the shell inspector to its context.
  useEffect(() => {
    if (current) select(current.id);
  }, [current, select]);

  const advance = useCallback(() => {
    setCursor((c) => c + 1);
  }, []);

  /** Re-slice the frozen items when the mode changes (no re-fetch, no reshuffle). */
  const onModeChange = useCallback(
    (next: SessionMode) => {
      setMode(next);
      if (!data) return;
      const jittered = jitterOrder(data.items);
      setOrder(jittered.filter((i) => modeIncludes(next, i)));
      setCursor(0);
      setProcessed(0);
    },
    [data],
  );

  /**
   * Apply one in-place action through the SAME typed mutation path as the list
   * (T030), then ADVANCE to the next item. postpone/raise/lower/done/dismiss/delete
   * all route through `queue.act`; the loop never returns to the list — it just
   * moves the cursor. No undo snackbar here (the list owns that affordance); the
   * loop optimizes for uninterrupted forward motion.
   */
  const act = useCallback(
    async (kind: LoopActionKind) => {
      if (!current || busy || !isDesktop()) return;
      setBusy(true);
      try {
        await appApi.actOnQueueItem({ id: current.id, action: { kind } });
        setProcessed((p) => p + 1);
        advance();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [current, busy, advance],
  );

  /** Skip the current item without mutating it (just advance the cursor). */
  const skip = useCallback(() => {
    if (!current) return;
    advance();
  }, [current, advance]);

  /** Open the current item in its full surface — the ONLY navigation in the loop. */
  const open = useCallback(() => {
    if (!current) return;
    select(current.id);
    if (current.type === "source") {
      void navigate({ to: "/source/$id", params: { id: current.id } });
    } else if (current.type === "extract") {
      void navigate({ to: "/extract/$id", params: { id: current.id } });
    } else {
      // Cards open the review surface (full grading lands with M7/T037).
      void navigate({ to: "/review" });
    }
  }, [current, navigate, select]);

  // Keyboard-first controls — the loop's core keys, registered in the single
  // shortcut registry (T048) and bound here through the SAME `appApi` path as the
  // buttons. While the loop is live it owns the keys it shares with the global
  // shell handler (`o`/`+`/`-`), so the shell DEFERS them (see `activeScope`).
  const loopActive = desktop && !done;
  useActiveScope("queue", loopActive);
  useProcessShortcuts(
    {
      next: skip,
      postpone: () => void act("postpone"),
      markDone: () => void act("markDone"),
      dismiss: () => void act("dismiss"),
      delete: () => void act("delete"),
      raise: () => void act("raise"),
      lower: () => void act("lower"),
      open,
    },
    loopActive,
  );

  if (!desktop) {
    return (
      <div className="pq-shell" data-testid="route-process">
        <div className="pq-center">
          <div className="q-empty">
            <div className="q-empty__icon">
              <Icon name="play" size={26} />
            </div>
            <h1 className="q-empty__title">Process queue</h1>
            <p className="q-empty__body">
              The session loop reads due items through the desktop bridge — open the Electron app to
              process your day one item at a time.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="pq-shell" data-testid="route-process">
      {/* session header — progress + presentational budget/mode steering */}
      <div className="pq-head">
        <button
          type="button"
          className="pq-end"
          data-testid="process-end"
          onClick={() => navigate({ to: "/queue", search: asOf ? { asOf } : {} })}
        >
          <Icon name="x" size={14} />
          End session
        </button>
        <div className="pq-progress" data-testid="process-progress">
          <div className="pq-progress__nums">
            <span>
              {Math.min(cursor + (done ? 0 : 1), total)} / {total}
            </span>
            <span className="pq-progress__est">est. {estMin} min</span>
          </div>
          <div className="pq-progress__bar">
            <span
              className="pq-progress__fill"
              style={{ width: `${total === 0 ? 0 : (processed / total) * 100}%` }}
            />
          </div>
        </div>
        <div className="pq-modes" data-testid="process-modes">
          <span className="pq-modes__label">Mode</span>
          {MODES.map((m) => (
            <button
              type="button"
              key={m.id}
              data-testid={`process-mode-${m.id}`}
              aria-pressed={mode === m.id}
              className={`pq-seg${mode === m.id ? " pq-seg--on" : ""}`}
              onClick={() => onModeChange(m.id)}
            >
              <Icon name={m.icon} size={12} />
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <p className="pq-error" data-testid="process-error">
          {error}
        </p>
      ) : null}

      <div className="pq-center">
        {done ? (
          <div className="q-panel pq-donepanel" data-testid="process-done">
            <div className="q-empty">
              <div className="q-empty__icon">
                <Icon name="checkCircle" size={26} />
              </div>
              <h2 className="q-empty__title">Queue clear</h2>
              <p className="q-empty__body">
                You processed {processed} item{processed === 1 ? "" : "s"} one at a time — no list,
                no detours. Your high-priority items are protected; the rest return when they're
                due.
              </p>
              <div className="pq-done__actions">
                <button
                  type="button"
                  className="pq-btn"
                  data-testid="process-restart"
                  onClick={() => void load()}
                >
                  <Icon name="review" size={14} />
                  Reload queue
                </button>
                <button
                  type="button"
                  className="sessionbar__start"
                  data-testid="process-back"
                  onClick={() => navigate({ to: "/queue", search: asOf ? { asOf } : {} })}
                >
                  <Icon name="return" size={14} />
                  Back to queue
                </button>
              </div>
            </div>
          </div>
        ) : current ? (
          <ProcessCard
            item={current}
            body={body}
            busy={busy}
            onAction={act}
            onSkip={skip}
            onOpen={open}
          />
        ) : null}
      </div>
    </div>
  );
}

/** The one-at-a-time process surface for the current item. */
function ProcessCard({
  item,
  body,
  busy,
  onAction,
  onSkip,
  onOpen,
}: {
  item: QueueItemSummary;
  body: ItemBody | null;
  busy: boolean;
  onAction: (kind: LoopActionKind) => void;
  onSkip: () => void;
  onOpen: () => void;
}) {
  const isCard = item.type === "card";
  const [revealed, setRevealed] = useState(false);
  // Reset the card reveal whenever the item changes.
  const lastId = useRef(item.id);
  if (lastId.current !== item.id) {
    lastId.current = item.id;
    if (revealed) setRevealed(false);
  }

  return (
    <div
      className="pq-card fade-up"
      data-testid="process-item"
      data-element-id={item.id}
      data-element-type={item.type}
      key={item.id}
    >
      {/* metadata row */}
      <div className="pq-card__meta">
        <div className="pq-card__chips">
          <TypeIcon type={item.type} lg />
          <Prio priority={item.priority} />
          {item.type === "extract" ? <Stage stage={item.stage} /> : null}
        </div>
        <SchedulerChip scheduler={chipSignals(item)} />
      </div>

      <h1 className="pq-card__title">{titleFor(item)}</h1>

      {isCard ? (
        <div className="pq-cardface" data-testid="process-card-face">
          <p className="pq-card__prompt">{item.title.replace(/\{\{(.+?)\}\}/, "[ … ]")}</p>
          {revealed ? (
            <div className="pq-card__answer" data-testid="process-card-answer">
              <p className="pq-card__note">
                Full reveal &amp; FSRS grading land with the review session (M7). For now this card
                appears in the loop alongside attention items — process it or grade it in review.
              </p>
              <button
                type="button"
                className="pq-btn"
                data-testid="process-card-review"
                onClick={onOpen}
              >
                <Icon name="brain" size={14} />
                Open in review
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="sessionbar__start pq-reveal"
              data-testid="process-card-reveal"
              onClick={() => setRevealed(true)}
            >
              <Icon name="eye" size={14} />
              Reveal
            </button>
          )}
        </div>
      ) : (
        <div className="pq-body" data-testid="process-body">
          {body?.sourceTitle ? (
            <div className="pq-body__src">
              <Icon name="source" size={13} /> {body.sourceTitle}
            </div>
          ) : null}
          {body?.bodyText ? (
            <p className="pq-body__text">{body.bodyText.slice(0, 900)}</p>
          ) : (
            <p className="pq-body__text pq-body__text--empty">No body to preview for this item.</p>
          )}
        </div>
      )}

      {/* action bar — the same T030 actions, every one advances the cursor */}
      <div className="pq-actions" data-testid="process-actions">
        <button
          type="button"
          className="pq-btn pq-btn--primary"
          disabled={busy}
          data-testid="process-action-open"
          onClick={onOpen}
        >
          <Icon name="external" size={14} />
          Open in full
        </button>
        <span className="pq-actions__spacer" />
        <button
          type="button"
          className="pq-btn"
          disabled={busy}
          data-testid="process-action-raise"
          onClick={() => onAction("raise")}
        >
          <Icon name="arrowUp" size={14} />
          Raise
        </button>
        <button
          type="button"
          className="pq-btn"
          disabled={busy}
          data-testid="process-action-lower"
          onClick={() => onAction("lower")}
        >
          <Icon name="arrowDown" size={14} />
          Lower
        </button>
        <button
          type="button"
          className="pq-btn"
          disabled={busy}
          data-testid="process-action-postpone"
          onClick={() => onAction("postpone")}
        >
          <Icon name="postpone" size={14} />
          Postpone
        </button>
        <button
          type="button"
          className="pq-btn"
          disabled={busy}
          data-testid="process-action-dismiss"
          onClick={() => onAction("dismiss")}
        >
          <Icon name="x" size={14} />
          Dismiss
        </button>
        <button
          type="button"
          className="pq-btn pq-btn--danger"
          disabled={busy}
          data-testid="process-action-delete"
          onClick={() => onAction("delete")}
        >
          <Icon name="trash" size={14} />
          Delete
        </button>
        <button
          type="button"
          className="pq-btn"
          disabled={busy}
          data-testid="process-action-skip"
          onClick={onSkip}
        >
          <Icon name="return" size={14} />
          Skip
        </button>
        <button
          type="button"
          className="pq-btn pq-btn--done"
          disabled={busy}
          data-testid="process-action-markDone"
          onClick={() => onAction("markDone")}
        >
          <Icon name="check" size={14} />
          Done
        </button>
      </div>

      <p className="pq-keys">
        <kbd>d</kbd> done · <kbd>p</kbd> postpone · <kbd>x</kbd> dismiss · <kbd>+</kbd>/<kbd>-</kbd>{" "}
        priority · <kbd>o</kbd> open · <kbd>n</kbd> next
      </p>
    </div>
  );
}
