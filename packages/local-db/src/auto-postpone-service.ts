/**
 * AutoPostponeService (T077) — the APPLY seam for the overload auto-postpone valve.
 *
 * The pure {@link planAutoPostpone} (in `@interleave/scheduler`) decides WHICH due items
 * recede when the load exceeds the daily budget — low-priority topics/sources/extracts
 * first, then low-priority *mature* cards, NEVER a high-priority *fragile* card (or a
 * leech, or a `protected` item). This service is the only thing that PERSISTS that plan.
 * It composes:
 *
 *  - {@link QueueQuery.list} — the merged due set (the same rows the renderer sees, already
 *    decorated with priority/retrievability/stability/`fsrsState`/lapses) + the `budget`
 *    gauge (target = `getAppSettings().dailyReviewBudget`; the overflow is `used - target`);
 *  - the pure {@link planAutoPostpone} — deterministic victim selection;
 *  - the TWO apply seams, one per scheduler (the load-bearing split):
 *      · attention item → {@link SchedulerService.rescheduleForAction}(id,"postpone",now,batchId)
 *        (`reschedule_element`, status → `scheduled`);
 *      · card → the shared {@link QueueActionService.cardDeferBy}(id,now,days,batchId) — an
 *        FSRS-aware defer that moves ONLY `review_states.due_at` (+ `elements.due_at`),
 *        leaving the memory state (`stability`/`difficulty`/`reps`/`lapses`/`fsrsState`)
 *        UNTOUCHED and writing NO review log.
 *
 * `preview()` is READ-ONLY (no mutation, no op). `apply()` mints ONE `batchId` so the whole
 * sweep undoes as a single batch via the existing command-level undo (T044). No new op types
 * (the closed 15-op set is unchanged), no schema migration. The renderer reaches this only
 * through the typed `window.appApi.queue.autoPostpone` / `…Apply` commands.
 */

import type { ElementId, IsoTimestamp } from "@interleave/core";
import type { InterleaveDatabase } from "@interleave/db";
import {
  type AutoPostponeInput,
  type AutoPostponePlan,
  type PostponeReason,
  planAutoPostpone,
} from "@interleave/scheduler";
import { newRowId, nowIso } from "./ids";
import type { Repositories } from "./index";
import { QueueActionService } from "./queue-action-service";
import { type QueueItemSummary, QueueQuery } from "./queue-query";
import { SchedulerService } from "./scheduler-service";

/** How many days a mature card is deferred per auto-postpone cycle (the single-shot valve). */
export const AUTO_POSTPONE_CARD_DEFER_DAYS = 7;

/** One row of the auto-postpone preview — what moves, from→to, and why. */
export interface PostponePreviewRow {
  readonly id: string;
  readonly title: string;
  readonly type: string;
  /** Numeric priority `0.0`–`1.0` (the UI derives the band). */
  readonly priority: number;
  readonly scheduler: "fsrs" | "attention";
  /** The current due time (ISO-8601), or `null`. */
  readonly fromDueAt: string | null;
  /** The projected due time after the postpone (ISO-8601). */
  readonly toDueAt: string;
  /** Why this item was sacrificed. */
  readonly reason: PostponeReason;
}

/** The JSON-serializable preview the renderer shows BEFORE committing. */
export interface AutoPostponePreview {
  /** How many items are over today's budget (`used - target`, clamped at 0). */
  readonly overBudget: number;
  /** The daily review budget target. */
  readonly target: number;
  /** The current due count (the budget gauge's `used`). */
  readonly used: number;
  /** The ordered postpone victims (cheapest value first). */
  readonly willPostpone: readonly PostponePreviewRow[];
  /** The due count that remains after applying the plan. */
  readonly remainingAfter: number;
}

/** The result of applying the auto-postpone sweep. */
export interface AutoPostponeApplyResult {
  /** How many items were postponed. */
  readonly postponed: number;
  /** The shared batch id, so the whole sweep undoes as one (T044). */
  readonly batchId: string;
}

const DAY_MS = 86_400_000;

export class AutoPostponeService {
  private readonly queue: QueueQuery;
  private readonly scheduler: SchedulerService;
  private readonly queueActions: QueueActionService;

  constructor(db: InterleaveDatabase, repos: Repositories) {
    this.queue = new QueueQuery(repos);
    this.scheduler = new SchedulerService(db);
    this.queueActions = new QueueActionService(db);
  }

  /**
   * The merged due set as the planner's input. `QueueItemSummary` is structurally a superset
   * of {@link AutoPostponeInput} (it carries priority/scheduler/`schedulerSignals`/`protected`
   * + the de-clumping keys), so the cast is a widening — no DB access in the planner.
   */
  private dueInputs(asOf: IsoTimestamp): {
    items: readonly QueueItemSummary[];
    budget: { used: number; target: number };
  } {
    const data = this.queue.list({ asOf });
    return { items: data.items, budget: data.budget };
  }

  /** Run the pure planner over the current due set + budget. */
  private plan(
    items: readonly QueueItemSummary[],
    budget: number,
    asOf: IsoTimestamp,
  ): AutoPostponePlan {
    return planAutoPostpone(items as readonly AutoPostponeInput[], { budget, asOf });
  }

  /**
   * Preview the auto-postpone sweep WITHOUT mutating: read the due set + budget, run the pure
   * planner, and project each victim's new due (the attention scheduler / card defer math),
   * returning a flat, JSON-serializable preview the renderer shows before committing.
   */
  preview({ asOf }: { asOf?: IsoTimestamp } = {}): AutoPostponePreview {
    const now = asOf ?? nowIso();
    const { items, budget } = this.dueInputs(now);
    const plan = this.plan(items, budget.target, now);
    const byId = new Map(items.map((row) => [row.id, row]));
    const willPostpone: PostponePreviewRow[] = plan.items.map((victim) => {
      const row = byId.get(victim.id);
      const fromDueAt = row?.dueAt ?? null;
      return {
        id: victim.id,
        title: row?.title ?? victim.id,
        type: victim.type,
        priority: row?.priority ?? 0,
        scheduler: victim.scheduler,
        fromDueAt,
        toDueAt: this.projectDueAt(victim, fromDueAt, now),
        reason: victim.reason,
      };
    });
    return {
      overBudget: Math.max(0, budget.used - budget.target),
      target: budget.target,
      used: budget.used,
      willPostpone,
      remainingAfter: plan.remainingAfter,
    };
  }

  /**
   * Project (read-only) where a victim would land — exactly what {@link apply} will compute:
   *  - a card defers by {@link AUTO_POSTPONE_CARD_DEFER_DAYS} from `max(fromDueAt, now)`;
   *  - an attention item recedes by the heuristic interval (mirrors `rescheduleForAction`
   *    `postpone`, which grows with the postpone count) — projected here via the same
   *    `nextDueAt` the scheduler uses, so the preview matches the apply.
   */
  private projectDueAt(
    victim: AutoPostponePlan["items"][number],
    fromDueAt: string | null,
    now: IsoTimestamp,
  ): string {
    if (victim.postponeKind === "cardDefer") {
      const base = fromDueAt ? Date.parse(fromDueAt) : Date.parse(now);
      const from = Number.isNaN(base) ? Date.parse(now) : Math.max(base, Date.parse(now));
      return new Date(from + AUTO_POSTPONE_CARD_DEFER_DAYS * DAY_MS).toISOString();
    }
    // Attention: project via the same scheduler decision (no mutation) the apply uses.
    return this.scheduler.previewPostpone(victim.id as ElementId, now);
  }

  /**
   * Apply the auto-postpone sweep TRANSACTIONALLY: mint ONE `batchId`, run the planner over
   * the live due set, and dispatch each victim to its correct scheduler — attention items
   * reschedule via {@link SchedulerService.rescheduleForAction} (`reschedule_element`); cards
   * defer via the shared {@link QueueActionService.cardDeferBy} (FSRS due only, memory state
   * untouched, no review log). Each item runs in its own transaction under the shared
   * `batchId`, so the whole sweep undoes as one (T044). Returns the count + the `batchId`.
   */
  apply({ asOf }: { asOf?: IsoTimestamp } = {}): AutoPostponeApplyResult {
    const now = asOf ?? nowIso();
    const { items, budget } = this.dueInputs(now);
    const plan = this.plan(items, budget.target, now);
    const batchId = newRowId();
    let postponed = 0;
    for (const victim of plan.items) {
      const id = victim.id as ElementId;
      if (victim.postponeKind === "cardDefer") {
        this.queueActions.cardDeferBy(id, now, AUTO_POSTPONE_CARD_DEFER_DAYS, batchId);
      } else {
        this.scheduler.rescheduleForAction(id, "postpone", now, batchId);
      }
      postponed += 1;
    }
    return { postponed, batchId };
  }
}
