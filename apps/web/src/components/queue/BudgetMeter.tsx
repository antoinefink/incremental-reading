/**
 * BudgetMeter (T029) — the daily-budget gauge for the Daily Queue.
 *
 * Ported from the design kit's `components.jsx` `BudgetMeter` for React 19, driven
 * entirely by the `.budget` tokens in `queue.css`. It shows estimated minutes vs the
 * configured daily budget (from `SettingsRepository`), splitting the bar
 * into a within-budget segment (accent) and, when over, an over-budget segment
 * (danger) + an "N min over budget" badge. The over-budget AUTO-POSTPONE action is M16
 * (T077/T078) — this only VISUALIZES the over-budget minutes; it never postpones.
 *
 * UI only — no domain logic, no data fetching. The values come from the typed
 * `window.appApi.queue.list` budget payload.
 */

export function BudgetMeter({
  used,
  target,
  confidence = "learned",
}: {
  used: number;
  target: number;
  confidence?: "learned" | "default";
}) {
  const over = Math.max(0, used - target);
  const within = Math.min(used, target);
  const denom = Math.max(target, used, 1);
  const approximate = confidence === "default" ? "~" : "";
  const usedLabel = Math.round(used);
  const targetLabel = Math.round(target);
  const overLabel = Math.max(0, usedLabel - targetLabel);
  return (
    <div className="budget" data-testid="budget-meter">
      <div className="budget__head">
        <span className="budget__num">
          {approximate}
          {usedLabel} <span>/ {targetLabel} min today</span>
        </span>
        {over > 0 && (
          <span className="badge badge--overdue" data-testid="budget-over">
            {overLabel} min over budget
          </span>
        )}
      </div>
      <div className="budget__bar">
        <span className="budget__used" style={{ width: `${(within / denom) * 100}%` }} />
        {over > 0 && (
          <span className="budget__over" style={{ width: `${(over / denom) * 100}%` }} />
        )}
      </div>
      <div className="budget__legend">
        <span>
          <i style={{ background: "var(--accent)" }} />
          Within budget
        </span>
        {over > 0 && (
          <span>
            <i style={{ background: "var(--danger)" }} />
            Over budget
          </span>
        )}
      </div>
    </div>
  );
}
