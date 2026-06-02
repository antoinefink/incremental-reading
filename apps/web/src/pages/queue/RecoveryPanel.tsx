/**
 * RecoveryPanel (T078) — the catch-up & vacation overload tools' UI.
 *
 * Two human-facing modes, BOTH showing the COST of postponement BEFORE committing (the
 * Done-when requirement). Each opens a preview that makes the cost EXPLICIT — the before/after
 * per-day LOAD CURVE + a `slips` summary ("N items now due up to D days later") — then applies
 * the plan and raises an undo snackbar:
 *
 *  - **Catch-up** — when the user is behind (overdue ≫ budget): spread the backlog forward over
 *    N days so each day stays within budget, high-value/fragile items to the earliest days. The
 *    preview shows the per-day curve flattening from a wall to ≤ budget.
 *  - **Vacation** — a date-range picker: pre-adjust the away-window load (suspend fragile cards,
 *    shift the rest past return), so the user returns to a survivable queue. The preview shows
 *    the suspended vs shifted counts + the after-return curve.
 *
 * Pure UI orchestration: no SQL, no scheduling/selection/spread math (all of that is the pure
 * `planCatchUp`/`planVacation` in `@interleave/scheduler` + the `RecoveryModeService` behind
 * IPC — the renderer only shows the preview the main process computed and sends the intent).
 */

import { useCallback, useMemo, useState } from "react";
import { Icon } from "../../components/Icon";
import {
  appApi,
  type CatchUpPreview,
  isDesktop,
  type RecoveryCostPreview,
  type VacationPreview,
} from "../../lib/appApi";

export interface RecoveryPanelProps {
  /** The clock the reads + plans compare against (ISO-8601), or undefined for "now". */
  readonly asOf?: string;
  /**
   * Called after a successful apply with the moved+suspended count — the parent re-reads the
   * queue and shows the "… · Undo" snackbar (undo via the batch `undo.last`).
   */
  readonly onApplied: (label: string, count: number) => void;
}

/** Today's date as a `YYYY-MM-DD` value for the date inputs. */
function todayInput(asOf?: string): string {
  const d = asOf ? new Date(asOf) : new Date();
  return Number.isNaN(d.getTime())
    ? new Date().toISOString().slice(0, 10)
    : d.toISOString().slice(0, 10);
}

/** A `YYYY-MM-DD` date input value → an ISO instant at the given UTC time-of-day. */
function dayToIso(day: string, endOfDay: boolean): string | null {
  if (!day) return null;
  const iso = `${day}T${endOfDay ? "23:59:59.000Z" : "00:00:00.000Z"}`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

/**
 * The before/after per-day LOAD CURVE — the headline "cost of postponement". Two rows of bars
 * (before: the overloaded wall; after: spread ≤ budget), each bar a day, height ∝ count, with a
 * dashed budget line so "each day ≤ budget" is legible at a glance.
 */
function LoadCurve({ cost, budget }: { cost: RecoveryCostPreview; budget?: number }) {
  const maxCount = useMemo(() => {
    const all = [...cost.loadBefore, ...cost.loadAfter].map((p) => p.count);
    return Math.max(1, ...all);
  }, [cost]);
  const Row = ({ points, label }: { points: RecoveryCostPreview["loadBefore"]; label: string }) => (
    <div className="q-loadcurve__row">
      <span className="q-loadcurve__label">{label}</span>
      <div className="q-loadcurve__bars">
        {points.map((p) => (
          <span
            key={p.date}
            className={`q-loadcurve__bar${budget != null && p.count > budget ? " q-loadcurve__bar--over" : ""}`}
            style={{ height: `${Math.round((p.count / maxCount) * 100)}%` }}
            title={`${p.date}: ${p.count}`}
            data-count={p.count}
          />
        ))}
      </div>
    </div>
  );
  return (
    <div className="q-loadcurve" data-testid="recovery-loadcurve">
      <Row points={cost.loadBefore} label="Before" />
      <Row points={cost.loadAfter} label="After" />
      {budget != null ? <div className="q-loadcurve__legend">Daily budget: {budget}</div> : null}
    </div>
  );
}

/** A short "what slips" summary line ("12 items now due up to 9 days later"). */
function slipsSummary(cost: RecoveryCostPreview): string {
  if (cost.slips.length === 0) return "Nothing slips — everything still fits.";
  const maxSlip = cost.slips.reduce((m, s) => Math.max(m, s.slipDays), 0);
  const n = cost.slips.length;
  return `${n} item${n === 1 ? "" : "s"} now due up to ${maxSlip} day${maxSlip === 1 ? "" : "s"} later`;
}

export function RecoveryPanel({ asOf, onApplied }: RecoveryPanelProps) {
  const [mode, setMode] = useState<"none" | "catchup" | "vacation">("none");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [catchUp, setCatchUp] = useState<CatchUpPreview | null>(null);
  const [vacation, setVacation] = useState<VacationPreview | null>(null);
  const [awayStart, setAwayStart] = useState<string>(() => todayInput(asOf));
  const [awayEnd, setAwayEnd] = useState<string>(() => todayInput(asOf));

  const reset = useCallback(() => {
    setMode("none");
    setCatchUp(null);
    setVacation(null);
    setError(null);
  }, []);

  const openCatchUp = useCallback(async () => {
    if (!isDesktop() || busy) return;
    setBusy(true);
    setError(null);
    setMode("catchup");
    try {
      const preview = await appApi.previewCatchUp(asOf ? { asOf } : undefined);
      setCatchUp(preview);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [asOf, busy]);

  const previewVacation = useCallback(async () => {
    if (!isDesktop() || busy) return;
    const start = dayToIso(awayStart, false);
    const end = dayToIso(awayEnd, true);
    if (!start || !end) {
      setError("Pick a valid away date range.");
      return;
    }
    if (Date.parse(end) < Date.parse(start)) {
      setError("The return date must be on or after the away date.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const preview = await appApi.previewVacation({
        awayStart: start,
        awayEnd: end,
        ...(asOf ? { asOf } : {}),
      });
      setVacation(preview);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [asOf, awayStart, awayEnd, busy]);

  const applyCatchUp = useCallback(async () => {
    if (!isDesktop() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await appApi.applyCatchUp(asOf ? { asOf } : undefined);
      reset();
      onApplied("Spread", result.moved);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [asOf, busy, onApplied, reset]);

  const applyVacation = useCallback(async () => {
    if (!isDesktop() || busy) return;
    const start = dayToIso(awayStart, false);
    const end = dayToIso(awayEnd, true);
    if (!start || !end) return;
    setBusy(true);
    setError(null);
    try {
      const result = await appApi.applyVacation({
        awayStart: start,
        awayEnd: end,
        ...(asOf ? { asOf } : {}),
      });
      reset();
      onApplied("Adjusted", result.moved + result.suspended);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [asOf, awayStart, awayEnd, busy, onApplied, reset]);

  return (
    <div className="q-recovery" data-testid="recovery-panel">
      <div className="q-recovery__actions">
        <button
          type="button"
          className="q-overload-banner__btn"
          data-testid="recovery-catchup-open"
          disabled={busy}
          aria-pressed={mode === "catchup"}
          onClick={() => (mode === "catchup" ? reset() : void openCatchUp())}
        >
          <Icon name="gauge" size={14} />
          Catch up
        </button>
        <button
          type="button"
          className="q-overload-banner__btn"
          data-testid="recovery-vacation-open"
          disabled={busy}
          aria-pressed={mode === "vacation"}
          onClick={() => (mode === "vacation" ? reset() : setMode("vacation"))}
        >
          <Icon name="sun" size={14} />
          Vacation
        </button>
      </div>

      {error ? (
        <div
          className="q-overload-banner__body"
          data-testid="recovery-error"
          style={{ color: "var(--danger)" }}
        >
          {error}
        </div>
      ) : null}

      {/* CATCH-UP preview — the cost is explicit before Apply. */}
      {mode === "catchup" && catchUp ? (
        <div className="q-recovery__preview" data-testid="recovery-catchup-preview">
          <div className="q-overload-banner__title">
            Spread {catchUp.cost.moved} item{catchUp.cost.moved === 1 ? "" : "s"} over{" "}
            {catchUp.spreadDays} days
          </div>
          <div className="q-overload-banner__body" data-testid="recovery-catchup-slips">
            {slipsSummary(catchUp.cost)}
          </div>
          <LoadCurve cost={catchUp.cost} budget={catchUp.budget} />
          <div className="q-postpone-preview__confirm">
            <button
              type="button"
              className="q-overload-banner__btn"
              data-testid="recovery-catchup-apply"
              disabled={busy || catchUp.cost.moved === 0}
              onClick={() => void applyCatchUp()}
            >
              <Icon name="check" size={14} />
              Apply
            </button>
            <button
              type="button"
              className="q-overload-banner__btn"
              data-testid="recovery-cancel"
              disabled={busy}
              onClick={reset}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {/* VACATION — a date-range picker, then the cost preview before Apply. */}
      {mode === "vacation" ? (
        <div className="q-recovery__preview" data-testid="recovery-vacation-preview">
          <div className="q-recovery__range">
            <label className="q-recovery__field">
              <span>Away from</span>
              <input
                type="date"
                data-testid="recovery-away-start"
                value={awayStart}
                onChange={(e) => {
                  setAwayStart(e.target.value);
                  setVacation(null);
                }}
              />
            </label>
            <label className="q-recovery__field">
              <span>Back on</span>
              <input
                type="date"
                data-testid="recovery-away-end"
                value={awayEnd}
                onChange={(e) => {
                  setAwayEnd(e.target.value);
                  setVacation(null);
                }}
              />
            </label>
            <button
              type="button"
              className="q-overload-banner__btn"
              data-testid="recovery-vacation-preview-btn"
              disabled={busy}
              onClick={() => void previewVacation()}
            >
              Preview cost
            </button>
          </div>

          {vacation ? (
            <>
              <div className="q-overload-banner__title">
                {vacation.suspendedCount} suspended · {vacation.shiftedCount} shifted past return
              </div>
              <div className="q-overload-banner__body" data-testid="recovery-vacation-slips">
                {slipsSummary(vacation.cost)}
              </div>
              <LoadCurve cost={vacation.cost} />
              <div className="q-postpone-preview__confirm">
                <button
                  type="button"
                  className="q-overload-banner__btn"
                  data-testid="recovery-vacation-apply"
                  disabled={busy || vacation.suspendedCount + vacation.shiftedCount === 0}
                  onClick={() => void applyVacation()}
                >
                  <Icon name="check" size={14} />
                  Apply
                </button>
                <button
                  type="button"
                  className="q-overload-banner__btn"
                  data-testid="recovery-cancel"
                  disabled={busy}
                  onClick={reset}
                >
                  Cancel
                </button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
