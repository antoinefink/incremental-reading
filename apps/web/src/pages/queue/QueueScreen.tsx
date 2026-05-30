/**
 * Daily Queue screen (T029) — the real `/queue`, replacing the placeholder.
 *
 * Rebuilt from the kit's `screen-queue.jsx` for React 19 + Tailwind v4: a page head
 * ("Daily Queue", N items due, est. minutes), an overload strip with the
 * `BudgetMeter` (items due vs the daily review budget) + at-risk metrics, a filter
 * `chip` row (All / Cards / Sources / Extracts / Tasks / High-priority, each with a
 * count), and the `qitem` list — each row showing the `TypeIcon`, title, a per-type
 * meta line, the load-bearing `SchedulerChip` (FSRS for cards, attention for the
 * rest), the `Prio` band, a due `Status` badge, a `next-action` pill, and the
 * `--protected` accent bar for A-priority items. A "Start session" button routes to
 * the T031 process loop (the `/review` placeholder until then).
 *
 * Data flows STRICTLY through the typed `window.appApi` bridge (the renderer never
 * touches SQLite): `queue.list({ types, concept, statuses })` returns the
 * already-sorted (priority-then-due-date), flat rows + counts + budget. The 10–20%
 * jitter is applied here as a STABLE, seeded shuffle (`jitterOrder`) so the order is
 * steady within a render but varies day to day. Clicking a row selects it in the
 * shell inspector; clicking its body / `next-action` opens it (source → reader,
 * extract → extract review, card → review when M7 lands).
 *
 * This component is pure UI orchestration — no SQL, no scheduling math, no priority
 * math (all of that is `packages/local-db` + `packages/scheduler` behind IPC).
 */

import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon, type IconName } from "../../components/Icon";
import { Prio, SchedulerChip, Stage, TypeIcon } from "../../components/inspector/primitives";
import { BudgetMeter } from "../../components/queue/BudgetMeter";
import "../../components/inspector/inspector.css";
import {
  appApi,
  isDesktop,
  type QueueItemSummary,
  type QueueListResult,
  type SchedulerSignals,
} from "../../lib/appApi";
import { useSelection } from "../../shell/selection";
import "./queue.css";
import { jitterOrder } from "./jitter";

/** The filter chips, in kit order. `type` narrows by element type; `high` by band A. */
type FilterId = "all" | "card" | "source" | "extract" | "task" | "high";
const FILTERS: readonly { id: FilterId; label: string }[] = [
  { id: "all", label: "All" },
  { id: "card", label: "Cards" },
  { id: "source", label: "Sources" },
  { id: "extract", label: "Extracts" },
  { id: "task", label: "Tasks" },
  { id: "high", label: "High priority" },
];

/** A due-state badge (overdue / today / soon) — distinct from the lifecycle `Status`. */
function DueBadge({ item }: { item: QueueItemSummary }) {
  const cls =
    item.due === "overdue" ? "badge--overdue" : item.due === "today" ? "badge--due" : "badge--soft";
  return (
    <span className={`badge ${cls}`} data-testid="queue-due-badge">
      {item.dueLabel}
    </span>
  );
}

/** The per-row title with the kit's type prefix ("Extract · …", "Q&A · …"). */
function titleFor(item: QueueItemSummary): string {
  if (item.type === "card") {
    const prefix = item.cardType === "cloze" ? "Cloze · " : "Q&A · ";
    return prefix + item.title.replace(/\{\{(.+?)\}\}/, "[…]");
  }
  if (item.type === "extract") return `Extract · ${item.title}`;
  if (item.type === "topic") return `Topic · ${item.title}`;
  return item.title;
}

/** The open-action icon + label per type (the `next-action` affordance). */
function actionFor(item: QueueItemSummary): { icon: IconName; label: string } {
  if (item.type === "card") return { icon: "brain", label: "Review" };
  if (item.type === "source") return { icon: "eye", label: "Read" };
  if (item.type === "extract") return { icon: "extract", label: "Process" };
  return { icon: "return", label: "Open" };
}

/** One queue row (the kit's `qitem`). */
function QueueItem({
  item,
  active,
  onSelect,
  onOpen,
}: {
  item: QueueItemSummary;
  active: boolean;
  onSelect: (item: QueueItemSummary) => void;
  onOpen: (item: QueueItemSummary) => void;
}) {
  const action = actionFor(item);
  // The chip reads the queue's trimmed signals as the inspector's wider shape.
  const chip: SchedulerSignals = {
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
  // The whole row is ONE real button (the kit's `qitem`): clicking it selects the
  // element in the shell inspector AND opens it (source → reader, extract → review,
  // card → review). The `next-action` pill is a non-interactive visual affordance —
  // its click bubbles to the row button, so there is no nested interactive element.
  return (
    <button
      type="button"
      data-testid="queue-item"
      data-element-id={item.id}
      data-element-type={item.type}
      data-scheduler={item.scheduler}
      aria-current={active ? "true" : undefined}
      onClick={() => {
        onSelect(item);
        onOpen(item);
      }}
      className={`qitem${item.protected ? " qitem--protected" : ""}${active ? " qitem--active" : ""}`}
    >
      <TypeIcon type={item.type} />
      <span className="qitem__main">
        <span className="qitem__title truncate">{titleFor(item)}</span>
        <span className="qitem__meta">
          {item.type === "source" && item.author ? (
            <span className="qitem__sub">
              <Icon name="globe" size={13} /> {item.author}
            </span>
          ) : null}
          {item.type === "card" && item.sourceTitle ? (
            <span className="qitem__sub">
              from <i>{item.sourceTitle}</i>
            </span>
          ) : null}
          {item.type === "extract" ? <Stage stage={item.stage} /> : null}
          {item.concept ? (
            <>
              <span className="dot-sep" />
              <span className="concept-tag">{item.concept}</span>
            </>
          ) : null}
          <span className="dot-sep" />
          <SchedulerChip scheduler={chip} />
        </span>
      </span>
      <span className="qitem__action">
        <Prio priority={item.priority} />
        <DueBadge item={item} />
        <span className="next-action" data-testid="queue-open">
          <Icon name={action.icon} size={12} />
          {action.label}
        </span>
      </span>
    </button>
  );
}

export function QueueScreen() {
  const desktop = isDesktop();
  const navigate = useNavigate();
  const { select } = useSelection();
  // The queue route declares no `validateSearch`, so search is loosely typed. An
  // optional `asOf` date-scopes the due reads (used by the E2E to drive a fixed
  // clock; in normal use the read defaults to the server's "now").
  const search = useSearch({ strict: false }) as { asOf?: string };
  const asOf = typeof search.asOf === "string" ? search.asOf : undefined;
  const [data, setData] = useState<QueueListResult | null>(null);
  const [filter, setFilter] = useState<FilterId>("all");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!isDesktop()) return;
    try {
      const next = await appApi.listQueue(asOf ? { asOf } : undefined);
      setData(next);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [asOf]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The sorted rows from the read, then the stable seeded jitter, then the active
  // filter. The read already sorted priority-then-due-date; jitter + filter are the
  // only presentation transforms.
  const visible = useMemo(() => {
    if (!data) return [] as QueueItemSummary[];
    const jittered = jitterOrder(data.items);
    if (filter === "all") return jittered;
    if (filter === "high") return jittered.filter((i) => i.protected);
    return jittered.filter((i) => i.type === filter);
  }, [data, filter]);

  const counts = data?.counts;
  const dueCount = counts?.all ?? 0;
  const estMin = Math.max(8, dueCount * 2);
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const onSelect = useCallback(
    (item: QueueItemSummary) => {
      select(item.id);
    },
    [select],
  );

  const onOpen = useCallback(
    (item: QueueItemSummary) => {
      select(item.id);
      if (item.type === "source") {
        void navigate({ to: "/source/$id", params: { id: item.id } });
      } else if (item.type === "extract") {
        void navigate({ to: "/extract/$id", params: { id: item.id } });
      } else {
        // Cards route to the review surface (full grading lands with M7/T037).
        void navigate({ to: "/review" });
      }
    },
    [navigate, select],
  );

  const startSession = useCallback(() => {
    // The T031 "Process queue" loop lands at /review (or a dedicated /process route);
    // until then "Start session" routes to the review placeholder.
    void navigate({ to: "/review" });
  }, [navigate]);

  if (!desktop) {
    return (
      <div
        className="flex h-full min-h-full flex-col items-center justify-center gap-3 px-7 py-8 text-center"
        data-testid="route-queue"
      >
        <div className="grid size-12 place-items-center rounded-lg bg-accent-soft text-accent-text">
          <Icon name="queue" size={26} />
        </div>
        <h1 className="font-semibold text-2xl text-text tracking-tight">Daily Queue</h1>
        <p className="max-w-sm text-base text-text-2">
          The queue reads due items through the desktop bridge — open the Electron app to process
          your day.
        </p>
      </div>
    );
  }

  return (
    <div className="q-page" data-testid="route-queue">
      <div className="q-pad">
        <div className="q-head">
          <div>
            <h1 className="q-title">Daily Queue</h1>
            <p className="q-sub" data-testid="queue-subtitle">
              {today} · {dueCount} item{dueCount === 1 ? "" : "s"} due · est. {estMin} min
            </p>
          </div>
        </div>

        {error ? (
          <p className="q-sub" data-testid="queue-error" style={{ color: "var(--danger)" }}>
            {error}
          </p>
        ) : null}

        {/* overload-management strip: budget meter + at-risk metrics */}
        <div className="q-panel q-panel-pad q-overload" style={{ marginBottom: 14 }}>
          <BudgetMeter used={data?.budget.used ?? 0} target={data?.budget.target ?? 0} />
          <div className="q-overload__div" />
          <div className="q-metrics">
            <div className="q-metric">
              <span className="q-metric__v">{counts?.all ?? 0}</span>
              <span className="q-metric__l">due today</span>
            </div>
            <div className="q-metric">
              <span
                className={`q-metric__v${counts?.overdue ? " q-metric__v--danger" : ""}`}
                data-testid="queue-overdue-count"
              >
                {counts?.overdue ?? 0}
              </span>
              <span className="q-metric__l">overdue</span>
            </div>
            <div className="q-metric">
              <span className="q-metric__v" data-testid="queue-protected-count">
                {counts?.protected ?? 0}
              </span>
              <span className="q-metric__l">protected</span>
            </div>
          </div>
        </div>

        {/* session controls (the overload Banner + Segmented modes are M16/T031) */}
        <div className="sessionbar">
          <button
            type="button"
            className="sessionbar__start"
            data-testid="queue-start-session"
            onClick={startSession}
          >
            <Icon name="play" size={14} />
            Start session
          </button>
          <span className="sessionbar__note">
            Process one item at a time — sorted by priority, then due date.
          </span>
        </div>

        {/* filters */}
        <div className="q-filters" data-testid="queue-filters">
          {FILTERS.map((f) => {
            const count =
              f.id === "all"
                ? (counts?.all ?? 0)
                : f.id === "high"
                  ? (counts?.highPriority ?? 0)
                  : (counts?.[f.id] ?? 0);
            return (
              <button
                type="button"
                key={f.id}
                data-testid={`queue-filter-${f.id}`}
                aria-pressed={filter === f.id}
                onClick={() => setFilter(f.id)}
                className={`chip${filter === f.id ? " chip--active" : ""}`}
              >
                {f.label}
                <span className="chip__count">{count}</span>
              </button>
            );
          })}
        </div>

        {/* list */}
        {visible.length > 0 ? (
          <div className="q-list" data-testid="queue-list">
            {visible.map((item) => (
              <QueueItem
                key={item.id}
                item={item}
                active={false}
                onSelect={onSelect}
                onOpen={onOpen}
              />
            ))}
          </div>
        ) : dueCount === 0 ? (
          <div className="q-panel">
            <div className="q-empty" data-testid="queue-empty">
              <div className="q-empty__icon">
                <Icon name="checkCircle" size={26} />
              </div>
              <h2 className="q-empty__title">Queue clear for today</h2>
              <p className="q-empty__body">
                You've processed everything due. The next items unlock as they come due — your
                high-priority sources are protected and won't pile up.
              </p>
            </div>
          </div>
        ) : (
          <div className="q-panel">
            <div className="q-empty" data-testid="queue-empty-filtered">
              <div className="q-empty__icon q-empty__icon--filter">
                <Icon name="filter" size={24} />
              </div>
              <h2 className="q-empty__title">
                No {filter === "high" ? "high-priority" : filter} items
              </h2>
              <p className="q-empty__body">
                Nothing matches this filter right now. Try another filter or clear it.
              </p>
              <button
                type="button"
                onClick={() => setFilter("all")}
                className="sessionbar__start"
                data-testid="queue-show-all"
              >
                Show all
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
