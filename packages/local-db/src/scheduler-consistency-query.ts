/**
 * SchedulerConsistencyQuery — read-only maintenance scan for queue/scheduler drift.
 *
 * Queue membership intentionally excludes terminal statuses and retired cards. This
 * query surfaces leftover scheduling state that should not silently look actionable
 * in inventory views: terminal elements with `elements.due_at`, terminal/retired
 * cards with `review_states.due_at`, and scheduled attention rows missing a due.
 */

import { type ElementStatus, type IsoTimestamp, priorityToLabel } from "@interleave/core";
import { cards, elements, type InterleaveDatabase, reviewStates } from "@interleave/db";
import { and, eq, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import { QUEUE_EXCLUDED_STATUSES } from "./queue-repository";

export type SchedulerConsistencyReason =
  | "terminal-element-due"
  | "terminal-card-review-due"
  | "retired-card-review-due"
  | "scheduled-attention-missing-due";

export interface SchedulerConsistencyRow {
  readonly element: {
    readonly id: string;
    readonly type: string;
    readonly title: string;
    readonly priority: number;
    readonly priorityLabel: string;
    readonly status: string;
    readonly createdAt: string;
  };
  readonly reason: SchedulerConsistencyReason;
  readonly elementDueAt: IsoTimestamp | null;
  readonly reviewDueAt: IsoTimestamp | null;
}

export class SchedulerConsistencyQuery {
  constructor(private readonly db: InterleaveDatabase) {}

  list(limit = 100): SchedulerConsistencyRow[] {
    const rows = new Map<string, SchedulerConsistencyRow>();
    const push = (row: SchedulerConsistencyRow) => {
      if (rows.size >= limit || rows.has(`${row.element.id}:${row.reason}`)) return;
      rows.set(`${row.element.id}:${row.reason}`, row);
    };

    for (const row of this.terminalElementDue()) push(row);
    for (const row of this.terminalCardReviewDue()) push(row);
    for (const row of this.retiredCardReviewDue()) push(row);
    for (const row of this.scheduledAttentionMissingDue()) push(row);
    return [...rows.values()];
  }

  count(): number {
    return this.list(Number.MAX_SAFE_INTEGER).length;
  }

  private terminalElementDue(): SchedulerConsistencyRow[] {
    return this.db
      .select({
        id: elements.id,
        type: elements.type,
        title: elements.title,
        priority: elements.priority,
        status: elements.status,
        createdAt: elements.createdAt,
        dueAt: elements.dueAt,
      })
      .from(elements)
      .where(
        and(
          isNull(elements.deletedAt),
          inArray(elements.status, QUEUE_EXCLUDED_STATUSES as ElementStatus[]),
          isNotNull(elements.dueAt),
        ),
      )
      .all()
      .map((r) => ({
        element: ref(r),
        reason: "terminal-element-due" as const,
        elementDueAt: r.dueAt as IsoTimestamp | null,
        reviewDueAt: null,
      }));
  }

  private terminalCardReviewDue(): SchedulerConsistencyRow[] {
    return this.db
      .select({
        id: elements.id,
        type: elements.type,
        title: elements.title,
        priority: elements.priority,
        status: elements.status,
        createdAt: elements.createdAt,
        elementDueAt: elements.dueAt,
        reviewDueAt: reviewStates.dueAt,
      })
      .from(elements)
      .innerJoin(reviewStates, eq(reviewStates.elementId, elements.id))
      .where(
        and(
          isNull(elements.deletedAt),
          eq(elements.type, "card"),
          inArray(elements.status, QUEUE_EXCLUDED_STATUSES as ElementStatus[]),
          isNotNull(reviewStates.dueAt),
        ),
      )
      .all()
      .map((r) => ({
        element: ref(r),
        reason: "terminal-card-review-due" as const,
        elementDueAt: r.elementDueAt as IsoTimestamp | null,
        reviewDueAt: r.reviewDueAt as IsoTimestamp | null,
      }));
  }

  private retiredCardReviewDue(): SchedulerConsistencyRow[] {
    return this.db
      .select({
        id: elements.id,
        type: elements.type,
        title: elements.title,
        priority: elements.priority,
        status: elements.status,
        createdAt: elements.createdAt,
        elementDueAt: elements.dueAt,
        reviewDueAt: reviewStates.dueAt,
      })
      .from(elements)
      .innerJoin(cards, eq(cards.elementId, elements.id))
      .innerJoin(reviewStates, eq(reviewStates.elementId, elements.id))
      .where(
        and(isNull(elements.deletedAt), eq(cards.isRetired, true), isNotNull(reviewStates.dueAt)),
      )
      .all()
      .map((r) => ({
        element: ref(r),
        reason: "retired-card-review-due" as const,
        elementDueAt: r.elementDueAt as IsoTimestamp | null,
        reviewDueAt: r.reviewDueAt as IsoTimestamp | null,
      }));
  }

  private scheduledAttentionMissingDue(): SchedulerConsistencyRow[] {
    return this.db
      .select({
        id: elements.id,
        type: elements.type,
        title: elements.title,
        priority: elements.priority,
        status: elements.status,
        createdAt: elements.createdAt,
        dueAt: elements.dueAt,
      })
      .from(elements)
      .where(
        and(
          isNull(elements.deletedAt),
          eq(elements.status, "scheduled"),
          ne(elements.type, "card"),
          isNull(elements.dueAt),
        ),
      )
      .all()
      .map((r) => ({
        element: ref(r),
        reason: "scheduled-attention-missing-due" as const,
        elementDueAt: r.dueAt as IsoTimestamp | null,
        reviewDueAt: null,
      }));
  }
}

function ref(row: {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly priority: number;
  readonly status: string;
  readonly createdAt: string;
}) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    priority: row.priority,
    priorityLabel: priorityToLabel(row.priority),
    status: row.status,
    createdAt: row.createdAt,
  };
}
