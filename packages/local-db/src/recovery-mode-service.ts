/**
 * RecoveryModeService (T078) — the APPLY seam for catch-up & vacation modes.
 *
 * The pure {@link planCatchUp} / {@link planVacation} (in `@interleave/scheduler`) decide the
 * DATES — how to spread an overdue backlog forward (catch-up) or pre-adjust the away-window
 * load (vacation) — and quantify the COST of postponement (the per-day load curve before vs
 * after + what slips, by how much). This service is the only thing that PERSISTS those plans.
 * It composes:
 *
 *  - {@link QueueQuery.list} — the merged due set (the same rows the renderer sees, already
 *    decorated with priority/retrievability/stability/`fsrsState`/lapses) + the `budget` gauge
 *    (target = `getAppSettings().dailyReviewBudget` — the per-day cap the plans spread under);
 *  - the pure planners — deterministic date assignment + the cost preview;
 *  - the THREE apply seams, one per kind (the load-bearing two-scheduler split + the vacation
 *    status change):
 *      · attention item → {@link SchedulerService.scheduleAt}(id, { manual: targetDueAt }, now,
 *        batchId) — an ABSOLUTE reschedule on the attention scheduler (`reschedule_element`);
 *      · card → {@link QueueActionService.cardDeferTo}(id, now, targetDueAt, batchId) — an
 *        FSRS-aware ABSOLUTE defer that sets `review_states.due_at` (+ `elements.due_at`) to the
 *        EXACT planned day, leaving the memory state (`stability`/`difficulty`/`reps`/`lapses`/
 *        `fsrsState`) UNTOUCHED and writing NO review log (so the applied per-day load curve
 *        matches the previewed plan day-for-day, even for a card whose `prevDue` was overdue);
 *      · vacation suspend → {@link ElementRepository.update}(id, { status: "suspended" }) —
 *        `update_element`, with the prior status captured in the op PRE-IMAGE so resume restores
 *        it exactly.
 *
 * Previews are READ-ONLY (no mutation, no op). Applies mint ONE `batchId` so the whole plan
 * undoes as a single batch via the existing command-level undo (T044) — `resumeVacation` /
 * the batch undo restores suspended items to their prior status and un-shifts the moved ones.
 * No new op types (the closed 15-op set is unchanged), no schema migration. The renderer reaches
 * this only through the typed `window.appApi.queue.catchUp`/`…Apply` + `…vacation`/`…Apply`.
 */

import type { ElementId, IsoTimestamp } from "@interleave/core";
import type { InterleaveDatabase } from "@interleave/db";
import {
  type CatchUpPlan,
  type PostponeCostPreview,
  planCatchUp,
  planVacation,
  type RecoveryInput,
  type VacationPlan,
} from "@interleave/scheduler";
import { ElementRepository } from "./element-repository";
import { newRowId, nowIso } from "./ids";
import type { Repositories } from "./index";
import { QueueActionService } from "./queue-action-service";
import { type QueueItemSummary, QueueQuery } from "./queue-query";
import { SchedulerService } from "./scheduler-service";

/** The default number of days a catch-up spreads the backlog over (a survivable runway). */
export const DEFAULT_CATCHUP_SPREAD_DAYS = 7;

/** Bounds on `spreadDays` so a malformed request can never blow up the spread (1–60 days). */
export const MIN_CATCHUP_SPREAD_DAYS = 1;
export const MAX_CATCHUP_SPREAD_DAYS = 60;

/** The read-only catch-up preview the renderer shows BEFORE committing. */
export interface CatchUpPreview {
  /** The per-day cap the backlog is spread under (the daily review budget). */
  readonly budget: number;
  /** How many days the backlog is spread over. */
  readonly spreadDays: number;
  /** The quantified cost of postponement (per-day load curve before vs after + slips). */
  readonly cost: PostponeCostPreview;
}

/** The read-only vacation preview the renderer shows BEFORE committing. */
export interface VacationPreview {
  /** The away window start (ISO-8601, echoed back). */
  readonly awayStart: string;
  /** The away window end (ISO-8601, echoed back). */
  readonly awayEnd: string;
  /** How many items are suspended for the away window. */
  readonly suspendedCount: number;
  /** How many items are shifted past return. */
  readonly shiftedCount: number;
  /** The quantified cost of postponement (the after-return load curve + slips). */
  readonly cost: PostponeCostPreview;
}

/** The result of applying a recovery plan (catch-up or vacation). */
export interface RecoveryApplyResult {
  /** How many items were moved (rescheduled/deferred). */
  readonly moved: number;
  /** How many items were suspended (vacation only; `0` for catch-up). */
  readonly suspended: number;
  /** The shared batch id, so the whole plan undoes as one (T044). */
  readonly batchId: string;
}

export class RecoveryModeService {
  private readonly queue: QueueQuery;
  private readonly scheduler: SchedulerService;
  private readonly queueActions: QueueActionService;
  private readonly elements: ElementRepository;

  constructor(db: InterleaveDatabase, repos: Repositories) {
    this.queue = new QueueQuery(repos);
    this.scheduler = new SchedulerService(db);
    this.queueActions = new QueueActionService(db);
    this.elements = new ElementRepository(db);
  }

  /** Clamp `spreadDays` to the supported range (a malformed value can't break the spread). */
  private clampSpreadDays(spreadDays: number | undefined): number {
    const n = Math.trunc(spreadDays ?? DEFAULT_CATCHUP_SPREAD_DAYS);
    if (!Number.isFinite(n)) return DEFAULT_CATCHUP_SPREAD_DAYS;
    return Math.min(MAX_CATCHUP_SPREAD_DAYS, Math.max(MIN_CATCHUP_SPREAD_DAYS, n));
  }

  /**
   * The CURRENT backlog (everything due at/before `asOf`) as the catch-up planner's input +
   * the budget. `QueueItemSummary` is structurally a superset of {@link RecoveryInput} (it
   * carries priority/scheduler/`schedulerSignals`/`protected`/title/dueAt), so the cast is a
   * widening — no DB access in the planner.
   */
  private backlog(asOf: IsoTimestamp): {
    items: readonly QueueItemSummary[];
    budget: number;
  } {
    const data = this.queue.list({ asOf });
    return { items: data.items, budget: data.budget.target };
  }

  /**
   * The items that would come due IN the away window `[awayStart, awayEnd]`. Read the queue
   * AS OF `awayEnd` (everything due at/before the window's end), then keep only those due
   * AT/AFTER `awayStart` — the window slice. The budget is the same daily cap.
   */
  private awayWindowItems(
    awayStart: IsoTimestamp,
    awayEnd: IsoTimestamp,
  ): { items: readonly QueueItemSummary[]; budget: number } {
    const data = this.queue.list({ asOf: awayEnd });
    const startMs = Date.parse(awayStart);
    const inWindow = data.items.filter((row) => {
      if (!row.dueAt) return false;
      const due = Date.parse(row.dueAt);
      return !Number.isNaN(due) && due >= startMs;
    });
    return { items: inWindow, budget: data.budget.target };
  }

  /** Build the catch-up plan over the current backlog + budget. */
  private catchUpPlan(
    asOf: IsoTimestamp,
    spreadDays: number,
  ): {
    plan: CatchUpPlan;
    budget: number;
  } {
    const { items, budget } = this.backlog(asOf);
    const plan = planCatchUp({
      items: items as readonly RecoveryInput[],
      budget,
      asOf,
      spreadDays,
    });
    return { plan, budget };
  }

  /** Build the vacation plan over the away-window items + budget. */
  private vacationPlan(
    awayStart: IsoTimestamp,
    awayEnd: IsoTimestamp,
    asOf: IsoTimestamp,
  ): VacationPlan {
    const { items, budget } = this.awayWindowItems(awayStart, awayEnd);
    return planVacation({
      items: items as readonly RecoveryInput[],
      awayStart,
      awayEnd,
      asOf,
      budget,
    });
  }

  /**
   * Preview the CATCH-UP plan WITHOUT mutating: read the backlog + budget, run the pure
   * planner, and return the quantified cost (per-day load curve before vs after + slips) so
   * the renderer shows the cost before committing.
   */
  previewCatchUp({
    asOf,
    spreadDays,
  }: {
    asOf?: IsoTimestamp;
    spreadDays?: number;
  } = {}): CatchUpPreview {
    const now = asOf ?? nowIso();
    const days = this.clampSpreadDays(spreadDays);
    const { plan, budget } = this.catchUpPlan(now, days);
    return { budget, spreadDays: days, cost: plan.cost };
  }

  /**
   * Apply the CATCH-UP plan TRANSACTIONALLY: mint ONE `batchId`, run the planner over the live
   * backlog, and dispatch each move to its correct scheduler — attention items reschedule to
   * the EXACT planned day via {@link SchedulerService.scheduleAt}({ manual }); cards defer to
   * the EXACT planned day via {@link QueueActionService.cardDeferTo} (FSRS due only, memory
   * state untouched, no review log). Each item in its own transaction under the shared
   * `batchId`, so the whole plan undoes as one (T044). Returns the count + the `batchId`.
   */
  applyCatchUp({
    asOf,
    spreadDays,
  }: {
    asOf?: IsoTimestamp;
    spreadDays?: number;
  } = {}): RecoveryApplyResult {
    const now = asOf ?? nowIso();
    const days = this.clampSpreadDays(spreadDays);
    const { plan } = this.catchUpPlan(now, days);
    const batchId = newRowId();
    let moved = 0;
    for (const item of plan.items) {
      this.applyMove(
        item.id as ElementId,
        item.scheduler,
        item.targetDueAt as IsoTimestamp,
        now,
        batchId,
      );
      moved += 1;
    }
    return { moved, suspended: 0, batchId };
  }

  /**
   * Preview the VACATION plan WITHOUT mutating: read the away-window items + budget, run the
   * pure planner, and return the suspend/shift counts + the quantified cost (the after-return
   * load curve + slips) so the renderer shows the cost before committing.
   */
  previewVacation({
    awayStart,
    awayEnd,
    asOf,
  }: {
    awayStart: IsoTimestamp;
    awayEnd: IsoTimestamp;
    asOf?: IsoTimestamp;
  }): VacationPreview {
    const now = asOf ?? nowIso();
    const plan = this.vacationPlan(awayStart, awayEnd, now);
    return {
      awayStart: plan.awayStart,
      awayEnd: plan.awayEnd,
      suspendedCount: plan.suspendedCount,
      shiftedCount: plan.shiftedCount,
      cost: plan.cost,
    };
  }

  /**
   * Apply the VACATION plan TRANSACTIONALLY: mint ONE `batchId`, run the planner over the live
   * away-window items, SUSPEND the fragile cards (status → `suspended` via `update_element`,
   * the prior status captured in the op pre-image for resume) and SHIFT everything else to the
   * EXACT planned post-return day (attention reschedule / FSRS card defer — same seams as
   * catch-up). Each item in its own transaction under the shared `batchId`. Returns the
   * shifted + suspended counts + the `batchId`.
   */
  applyVacation({
    awayStart,
    awayEnd,
    asOf,
  }: {
    awayStart: IsoTimestamp;
    awayEnd: IsoTimestamp;
    asOf?: IsoTimestamp;
  }): RecoveryApplyResult {
    const now = asOf ?? nowIso();
    const plan = this.vacationPlan(awayStart, awayEnd, now);
    const batchId = newRowId();
    // Suspend the fragile cards (status change; prior status captured for resume).
    let suspended = 0;
    for (const s of plan.suspend) {
      this.elements.update(s.id as ElementId, { status: "suspended" }, { batchId });
      suspended += 1;
    }
    // Shift everything else to its exact planned post-return day.
    let moved = 0;
    for (const item of plan.shift) {
      this.applyMove(
        item.id as ElementId,
        item.scheduler,
        item.targetDueAt as IsoTimestamp,
        now,
        batchId,
      );
      moved += 1;
    }
    return { moved, suspended, batchId };
  }

  /**
   * Dispatch ONE planned move to its correct scheduler (the two-scheduler split): a card defers
   * to the ABSOLUTE target day on FSRS (memory state untouched); any other (attention) item
   * reschedules to the ABSOLUTE target day on the attention scheduler. Both append exactly one
   * `reschedule_element` op under the shared `batchId`.
   */
  private applyMove(
    id: ElementId,
    scheduler: "fsrs" | "attention",
    targetDueAt: IsoTimestamp,
    now: IsoTimestamp,
    batchId: string,
  ): void {
    if (scheduler === "fsrs") {
      this.queueActions.cardDeferTo(id, now, targetDueAt, batchId);
    } else {
      this.scheduler.scheduleAt(id, { manual: targetDueAt }, now, batchId);
    }
  }
}
