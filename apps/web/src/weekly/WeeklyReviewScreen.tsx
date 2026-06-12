import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "../components/Icon";
import {
  appApi,
  type ChronicPostponeDecisionInput,
  type ChronicPostponeDecisionKind,
  type ChronicPostponeRowSummary,
  type ParkedResurfacingDecisionKind,
  type ParkedResurfacingRowSummary,
  type WeeklyReviewSectionId,
  type WeeklyReviewSummaryResult,
} from "../lib/appApi";
import "./weekly-review.css";

const SECTIONS: readonly { id: WeeklyReviewSectionId; label: string }[] = [
  { id: "ledger", label: "Ledger" },
  { id: "integrity", label: "Integrity" },
  { id: "parked", label: "Parked" },
  { id: "chronic", label: "Chronic" },
  { id: "fallow", label: "Fallow" },
];

const CHRONIC_FALLOW_REASON = "Rested from weekly integrity session";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: WeeklyReviewSummaryResult };

export function WeeklyReviewScreen() {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      setState({ status: "ready", data: await appApi.getWeeklyReviewSummary() });
    } catch (error) {
      setState({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.status === "loading") {
    return <div className="weekly-shell weekly-shell--loading">Loading weekly review...</div>;
  }
  if (state.status === "error") {
    return (
      <div className="weekly-shell weekly-shell--error" data-testid="weekly-error">
        {state.message}
      </div>
    );
  }

  return <WeeklyReviewBody summary={state.data} onReload={load} />;
}

function WeeklyReviewBody({
  summary,
  onReload,
}: {
  readonly summary: WeeklyReviewSummaryResult;
  readonly onReload: () => Promise<void>;
}) {
  const progress = summary.progress;
  const [busySection, setBusySection] = useState<WeeklyReviewSectionId | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const completion = useMemo(() => {
    if (!progress) return { done: 0, total: SECTIONS.length };
    return {
      done: Object.values(progress.sections).filter(
        (state) => state === "done" || state === "skipped",
      ).length,
      total: SECTIONS.length,
    };
  }, [progress]);

  const setSection = async (id: WeeklyReviewSectionId, state: "done" | "skipped") => {
    if (!summary.session) return;
    setActionError(null);
    setBusySection(id);
    try {
      await appApi.updateWeeklyReviewProgress({
        taskId: summary.session.id,
        sections: { [id]: state },
      });
      await onReload();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusySection(null);
    }
  };

  const runParkedDecisions = async (
    decisions: readonly { readonly id: string; readonly kind: ParkedResurfacingDecisionKind }[],
  ) => {
    setActionError(null);
    setBusySection("parked");
    try {
      const result = await appApi.maintenance.parkedResurfacingApply({ decisions });
      setMessage(
        result.applied > 0
          ? `Applied ${result.applied} parked decisions`
          : "No parked decisions applied",
      );
      await setSection("parked", "done");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusySection(null);
    }
  };

  const runChronicDecisions = async (decisions: readonly ChronicPostponeDecisionInput[]) => {
    setActionError(null);
    setBusySection("chronic");
    try {
      const result = await appApi.maintenance.chronicPostponesApply({ decisions });
      setMessage(
        result.applied > 0
          ? `Applied ${result.applied} chronic decisions`
          : "No chronic decisions applied",
      );
      await setSection("chronic", "done");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusySection(null);
    }
  };

  const complete = async () => {
    if (!summary.session) return;
    setActionError(null);
    setBusySection("ledger");
    try {
      await appApi.completeWeeklyReview({ taskId: summary.session.id });
      await onReload();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusySection(null);
    }
  };

  const dismiss = async () => {
    if (!summary.session) return;
    setActionError(null);
    setBusySection("ledger");
    try {
      await appApi.dismissWeeklyReview({ taskId: summary.session.id, snoozeDays: 1 });
      await onReload();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusySection(null);
    }
  };

  return (
    <div className="weekly-shell" data-testid="weekly-review">
      <header className="weekly-header">
        <div>
          <p className="weekly-kicker">Weekly session</p>
          <h1>Ledger and integrity</h1>
          <p className="weekly-window">
            {formatDate(summary.window.start)} - {formatDate(summary.window.end)}
          </p>
        </div>
        <div className="weekly-actions">
          <span className="weekly-progress">
            {completion.done}/{completion.total}
          </span>
          <button
            type="button"
            className="weekly-button"
            disabled={busySection !== null}
            onClick={() => void dismiss()}
          >
            <Icon name="clock" size={16} />
            Snooze
          </button>
          <button
            type="button"
            className="weekly-button weekly-button--primary"
            disabled={busySection !== null}
            onClick={() => void complete()}
          >
            <Icon name="check" size={16} />
            Complete
          </button>
        </div>
      </header>

      {message ? <div className="weekly-message">{message}</div> : null}
      {actionError ? (
        <div className="weekly-message weekly-message--error" data-testid="weekly-action-error">
          {actionError}
        </div>
      ) : null}

      <section className="weekly-ledger" aria-label="Weekly ledger">
        <Metric label="Sources" value={summary.ledger.sources} />
        <Metric label="Extracts" value={summary.ledger.extracts} />
        <Metric label="Cards" value={summary.ledger.cards} />
        <Metric label="Matured" value={summary.ledger.maturedCards} />
      </section>

      <SectionFrame id="ledger" summary={summary} onSetSection={setSection}>
        <div className="weekly-misses">
          {summary.ledger.priorityMisses.length === 0 ? (
            <p>No priority misses in this window.</p>
          ) : (
            summary.ledger.priorityMisses.map((miss) => (
              <div className="weekly-row" key={miss.band}>
                <span>Band {miss.band}</span>
                <strong>{miss.deferred} deferred</strong>
                <span>{miss.postponeDebtDays.toFixed(1)}d debt</span>
              </div>
            ))
          )}
        </div>
      </SectionFrame>

      <SectionFrame id="integrity" summary={summary} onSetSection={setSection}>
        <div className="weekly-grid">
          <Metric
            label="A deferred"
            value={summary.integrity.thresholdFlags.aBandDeferredRecently ? 1 : 0}
          />
          <Metric
            label="Debt high"
            value={summary.integrity.thresholdFlags.postponeDebtHigh ? 1 : 0}
          />
          <Metric label="Resting topics" value={summary.integrity.resting.length} />
        </div>
      </SectionFrame>

      <SectionFrame id="parked" summary={summary} onSetSection={setSection}>
        <ParkedDecisions
          busy={busySection === "parked"}
          rows={summary.decisions.parked.rows}
          onApply={runParkedDecisions}
        />
      </SectionFrame>

      <SectionFrame id="chronic" summary={summary} onSetSection={setSection}>
        <ChronicDecisions
          busy={busySection === "chronic"}
          rows={summary.decisions.chronic.rows}
          onApply={runChronicDecisions}
        />
      </SectionFrame>

      <SectionFrame id="fallow" summary={summary} onSetSection={setSection}>
        <DecisionList
          empty="No fallow suggestions."
          rows={summary.decisions.fallowSuggestions.map((row) => ({
            id: row.topicId,
            title: row.title,
            meta: `${row.band} priority - ${row.deferred} deferred`,
          }))}
        />
      </SectionFrame>
    </div>
  );
}

function SectionFrame({
  id,
  summary,
  onSetSection,
  children,
}: {
  readonly id: WeeklyReviewSectionId;
  readonly summary: WeeklyReviewSummaryResult;
  readonly onSetSection: (id: WeeklyReviewSectionId, state: "done" | "skipped") => Promise<void>;
  readonly children: ReactNode;
}) {
  const state = summary.progress?.sections[id] ?? "pending";
  const label = SECTIONS.find((section) => section.id === id)?.label ?? id;
  const disabled = !summary.session;
  return (
    <section className="weekly-section" data-state={state}>
      <div className="weekly-section__head">
        <div>
          <h2>{label}</h2>
          <span>{state}</span>
        </div>
        <div className="weekly-section__actions">
          <button
            type="button"
            disabled={disabled}
            onClick={() => void onSetSection(id, "skipped")}
          >
            Skip
          </button>
          <button type="button" disabled={disabled} onClick={() => void onSetSection(id, "done")}>
            Done
          </button>
        </div>
      </div>
      {children}
    </section>
  );
}

function ParkedDecisions({
  rows,
  busy,
  onApply,
}: {
  readonly rows: readonly ParkedResurfacingRowSummary[];
  readonly busy: boolean;
  readonly onApply: (
    decisions: readonly { readonly id: string; readonly kind: ParkedResurfacingDecisionKind }[],
  ) => Promise<void>;
}) {
  const [decisions, setDecisions] = useState<Record<string, ParkedResurfacingDecisionKind>>({});

  useEffect(() => {
    setDecisions((previous) => {
      const next: Record<string, ParkedResurfacingDecisionKind> = {};
      for (const row of rows) next[row.element.id] = previous[row.element.id] ?? "keepParked";
      return next;
    });
  }, [rows]);

  if (rows.length === 0) return <p className="weekly-empty">No parked sources are due.</p>;

  return (
    <div className="weekly-decisions">
      {rows.map((row) => {
        const current = decisions[row.element.id] ?? "keepParked";
        return (
          <div className="weekly-decision" key={row.element.id}>
            <div>
              <strong>{row.element.title}</strong>
              <span>
                {row.element.priorityLabel} priority - parked {row.ageDays}d
              </span>
            </div>
            <SegmentedDecision<ParkedResurfacingDecisionKind>
              ariaLabel={`Decision for ${row.element.title}`}
              disabled={busy}
              value={current}
              options={[
                ["keepParked", "Keep"],
                ["queueNow", "Queue"],
                ["letGo", "Let go"],
              ]}
              onChange={(kind) =>
                setDecisions((previous) => ({ ...previous, [row.element.id]: kind }))
              }
            />
          </div>
        );
      })}
      <button
        type="button"
        className="weekly-button weekly-button--inline"
        disabled={busy}
        onClick={() =>
          void onApply(
            rows.map((row) => ({
              id: row.element.id,
              kind: decisions[row.element.id] ?? "keepParked",
            })),
          )
        }
      >
        <Icon name="check" size={14} />
        Apply parked decisions
      </button>
    </div>
  );
}

function ChronicDecisions({
  rows,
  busy,
  onApply,
}: {
  readonly rows: readonly ChronicPostponeRowSummary[];
  readonly busy: boolean;
  readonly onApply: (decisions: readonly ChronicPostponeDecisionInput[]) => Promise<void>;
}) {
  const [decisions, setDecisions] = useState<Record<string, ChronicPostponeDecisionKind>>({});
  const [fallowDates, setFallowDates] = useState<Record<string, string>>({});

  useEffect(() => {
    const activeIds = new Set(rows.map((row) => row.element.id));
    setDecisions((previous) => pruneRecord(previous, activeIds));
    setFallowDates((previous) => pruneRecord(previous, activeIds));
  }, [rows]);

  if (rows.length === 0) return <p className="weekly-empty">No chronic postpones are due.</p>;

  const selected: ChronicPostponeDecisionInput[] = [];
  let hasInvalidFallowDate = false;
  for (const row of rows) {
    const kind = decisions[row.element.id];
    if (!kind) continue;
    if (kind === "fallow") {
      const fallowUntil = fallowDateToIso(fallowDates[row.element.id] ?? "");
      if (!fallowUntil) {
        hasInvalidFallowDate = true;
        continue;
      }
      selected.push({
        id: row.element.id,
        kind,
        fallowUntil,
        fallowReason: CHRONIC_FALLOW_REASON,
      });
    } else {
      selected.push({ id: row.element.id, kind });
    }
  }

  const setDecision = (id: string, kind: ChronicPostponeDecisionKind) => {
    setDecisions((previous) => ({ ...previous, [id]: kind }));
    if (kind === "fallow") {
      setFallowDates((previous) =>
        previous[id] ? previous : { ...previous, [id]: defaultFallowDate() },
      );
    }
  };

  return (
    <div className="weekly-decisions">
      {rows.map((row) => {
        const current = decisions[row.element.id] ?? null;
        return (
          <div className="weekly-decision" key={row.element.id}>
            <div>
              <strong>{row.element.title}</strong>
              <span>
                {row.element.priorityLabel} priority - postponed {row.postponeCount}x
              </span>
            </div>
            <SegmentedDecision<ChronicPostponeDecisionKind>
              ariaLabel={`Decision for ${row.element.title}`}
              disabled={busy}
              value={current}
              options={[
                ["keep", "Keep"],
                ["demote", "Demote"],
                ["done", "Done"],
                ["delete", "Delete"],
                ...(row.element.type === "topic" ? ([["fallow", "Rest"]] as const) : []),
              ]}
              onChange={(kind) => setDecision(row.element.id, kind)}
            />
            {current === "fallow" ? (
              <label className="weekly-date">
                <span>Return</span>
                <input
                  type="date"
                  value={fallowDates[row.element.id] ?? defaultFallowDate()}
                  disabled={busy}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setFallowDates((previous) => ({ ...previous, [row.element.id]: value }));
                  }}
                />
              </label>
            ) : null}
          </div>
        );
      })}
      <button
        type="button"
        className="weekly-button weekly-button--inline"
        disabled={busy || selected.length === 0 || hasInvalidFallowDate}
        onClick={() => void onApply(selected)}
      >
        <Icon name="check" size={14} />
        Apply chronic decisions
      </button>
    </div>
  );
}

function SegmentedDecision<T extends string>({
  ariaLabel,
  disabled,
  value,
  options,
  onChange,
}: {
  readonly ariaLabel: string;
  readonly disabled: boolean;
  readonly value: T | null;
  readonly options: readonly (readonly [T, string])[];
  readonly onChange: (value: T) => void;
}) {
  return (
    <fieldset className="weekly-segment" aria-label={ariaLabel}>
      {options.map(([option, label]) => (
        <button
          type="button"
          key={option}
          data-active={value === option}
          aria-pressed={value === option}
          disabled={disabled}
          onClick={() => onChange(option)}
        >
          {label}
        </button>
      ))}
    </fieldset>
  );
}

function Metric({ label, value }: { readonly label: string; readonly value: number }) {
  return (
    <div className="weekly-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function DecisionList({
  rows,
  empty,
}: {
  readonly rows: readonly { readonly id: string; readonly title: string; readonly meta: string }[];
  readonly empty: string;
}) {
  if (rows.length === 0) return <p className="weekly-empty">{empty}</p>;
  return (
    <div className="weekly-decisions">
      {rows.map((row) => (
        <div className="weekly-decision" key={row.id}>
          <strong>{row.title}</strong>
          <span>{row.meta}</span>
        </div>
      ))}
    </div>
  );
}

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(iso));
}

function defaultFallowDate(): string {
  const date = new Date();
  date.setDate(date.getDate() + 14);
  return date.toISOString().slice(0, 10);
}

function fallowDateToIso(dateValue: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) return null;
  const date = new Date(`${dateValue}T12:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) return null;
  return date.toISOString();
}

function pruneRecord<T>(
  record: Record<string, T>,
  activeIds: ReadonlySet<string>,
): Record<string, T> {
  const next: Record<string, T> = {};
  for (const [id, value] of Object.entries(record)) {
    if (activeIds.has(id)) next[id] = value;
  }
  return next;
}
