/**
 * FallowService (T107) — deliberate, undoable topic rest.
 *
 * Fallow is an ATTENTION-scheduler state. It shifts a topic and its live
 * non-card attention descendants out to a chosen return date, while descendant
 * cards keep their FSRS `review_states` untouched.
 */

import type { ElementId, ElementStatus, IsoTimestamp } from "@interleave/core";
import { elements, type InterleaveDatabase, operationLog } from "@interleave/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { liveDescendantsWithin } from "./descendant-query";
import { ElementRepository } from "./element-repository";
import { newRowId } from "./ids";
import { OperationLogRepository } from "./operation-log-repository";
import { isQueueActionableStatus } from "./queue-repository";
import type { DbClient, TransactionClient } from "./types";

export const FALLOW_REASON_MAX = 240;

export type FallowSkipReason =
  | "missing"
  | "deleted"
  | "not-topic"
  | "not-actionable"
  | "invalid-return"
  | "not-fallowed"
  | "missing-fallow-batch"
  | "schedule-changed";

export interface FallowSkippedRow {
  readonly id: ElementId;
  readonly reason: FallowSkipReason;
}

export interface FallowTopicOptions {
  readonly topicId: ElementId;
  readonly fallowUntil: IsoTimestamp;
  readonly fallowReason?: string | null;
  readonly now?: IsoTimestamp;
}

export interface FallowTopicWithinOptions extends FallowTopicOptions {
  readonly batchId: string;
  readonly action?: string;
  readonly resetChronicPostpones?: boolean;
  readonly prevEffectivePostponeCount?: number;
}

export interface UnfallowTopicOptions {
  readonly topicId: ElementId;
}

export interface FallowApplyResult {
  readonly applied: number;
  readonly skipped: readonly FallowSkippedRow[];
  readonly batchId: string | null;
}

type ElementRow = typeof elements.$inferSelect;

interface ParsedOp {
  readonly opType: string;
  readonly elementId: ElementId | null;
  readonly payload: Record<string, unknown>;
}

interface FallowPreimage {
  readonly prevDueAt: IsoTimestamp | null;
  readonly prevStatus: ElementStatus | undefined;
}

export class FallowService {
  private readonly elements: ElementRepository;

  constructor(private readonly db: InterleaveDatabase) {
    this.elements = new ElementRepository(db);
  }

  fallowTopic(options: FallowTopicOptions): FallowApplyResult {
    const batchId = newRowId();
    return this.db.transaction((tx) => this.fallowTopicWithin(tx, { ...options, batchId }));
  }

  fallowTopicWithin(tx: TransactionClient, options: FallowTopicWithinOptions): FallowApplyResult {
    const normalized = this.normalizeFallowOptions(options);
    if (!normalized.valid) {
      return {
        applied: 0,
        skipped: [{ id: options.topicId, reason: normalized.reason }],
        batchId: null,
      };
    }

    const topic = this.readRowWithin(tx, options.topicId);
    const validation = this.validateTopic(topic);
    if (validation) {
      return { applied: 0, skipped: [{ id: options.topicId, reason: validation }], batchId: null };
    }

    const activePreimages = topic?.fallowBatchId
      ? this.fallowPreimagesForBatchWithin(tx, topic.fallowBatchId, options.topicId)
      : null;
    const rowsToSchedule = this.attentionRowsToFallowWithin(tx, {
      topicId: options.topicId,
      fallowUntil: normalized.fallowUntil,
      activeFallowUntil: topic?.fallowUntil ?? null,
      activePreimages,
    });
    let applied = 0;

    this.elements.updateWithin(
      tx,
      options.topicId,
      {
        fallowUntil: normalized.fallowUntil,
        fallowReason: normalized.fallowReason,
        fallowBatchId: options.batchId,
      },
      {
        batchId: options.batchId,
        extras: {
          action: options.action ?? "fallow:topic",
          fallow: true,
          fallowUntil: normalized.fallowUntil,
          fallowReason: normalized.fallowReason,
        },
      },
    );
    applied += 1;

    this.elements.rescheduleWithin(tx, options.topicId, normalized.fallowUntil, undefined, {
      batchId: options.batchId,
      action: options.action ?? "fallow:reschedule",
      fallow: true,
      topicId: options.topicId,
      fallowUntil: normalized.fallowUntil,
      ...fallowOriginalScheduleExtras(activePreimages?.get(options.topicId) ?? null),
    });
    applied += 1;

    for (const row of rowsToSchedule) {
      this.elements.rescheduleWithin(tx, row.id as ElementId, normalized.fallowUntil, undefined, {
        batchId: options.batchId,
        action: options.action ?? "fallow:reschedule",
        fallow: true,
        topicId: options.topicId,
        fallowUntil: normalized.fallowUntil,
        ...fallowOriginalScheduleExtras(activePreimages?.get(row.id as ElementId) ?? null),
      });
      applied += 1;
    }

    if (options.resetChronicPostpones) {
      this.appendChronicResetWithin(tx, {
        topicId: options.topicId,
        batchId: options.batchId,
        prevEffectivePostponeCount: options.prevEffectivePostponeCount ?? 0,
      });
      applied += 1;
    }

    return { applied, skipped: [], batchId: applied > 0 ? options.batchId : null };
  }

  unfallowTopic(options: UnfallowTopicOptions): FallowApplyResult {
    const batchId = newRowId();
    return this.db.transaction((tx) => {
      const topic = this.readRowWithin(tx, options.topicId);
      const validation = this.validateTopic(topic);
      if (validation) {
        return {
          applied: 0,
          skipped: [{ id: options.topicId, reason: validation }],
          batchId: null,
        };
      }
      if (!topic?.fallowUntil) {
        return {
          applied: 0,
          skipped: [{ id: options.topicId, reason: "not-fallowed" }],
          batchId: null,
        };
      }
      if (!topic.fallowBatchId) {
        return {
          applied: 0,
          skipped: [{ id: options.topicId, reason: "missing-fallow-batch" }],
          batchId: null,
        };
      }

      const skipped: FallowSkippedRow[] = [];
      let applied = 0;
      for (const op of this.fallowReschedulesForBatchWithin(
        tx,
        topic.fallowBatchId,
        options.topicId,
      )) {
        const id = op.elementId;
        if (!id) continue;
        const row = this.readRowWithin(tx, id);
        if (!row || row.deletedAt) {
          skipped.push({ id, reason: row ? "deleted" : "missing" });
          continue;
        }
        const fallowDueAt = stringPayload(op.payload, "dueAt");
        const prevDueAt = restoreDueAtPayload(op.payload);
        const prevStatus = restoreStatusPayload(op.payload);
        if (row.dueAt !== fallowDueAt) {
          skipped.push({ id, reason: "schedule-changed" });
          continue;
        }
        this.elements.rescheduleWithin(tx, id, prevDueAt, prevStatus, {
          batchId,
          action: "fallow:restoreSchedule",
          fallowRestore: true,
          fallowBatchId: topic.fallowBatchId,
        });
        applied += 1;
      }

      this.elements.updateWithin(
        tx,
        options.topicId,
        { fallowUntil: null, fallowReason: null, fallowBatchId: null },
        {
          batchId,
          extras: { action: "fallow:clear", fallowClear: true },
        },
      );
      applied += 1;

      return { applied, skipped, batchId: applied > 0 ? batchId : null };
    });
  }

  private normalizeFallowOptions(options: FallowTopicOptions):
    | {
        readonly valid: true;
        readonly fallowUntil: IsoTimestamp;
        readonly fallowReason: string | null;
      }
    | { readonly valid: false; readonly reason: "invalid-return" } {
    const returnMs = Date.parse(options.fallowUntil);
    const nowMs = Date.parse(options.now ?? new Date().toISOString());
    if (
      !isCanonicalUtcIsoTimestamp(options.fallowUntil) ||
      !Number.isFinite(returnMs) ||
      !Number.isFinite(nowMs) ||
      returnMs <= nowMs
    ) {
      return { valid: false, reason: "invalid-return" };
    }
    const trimmed = options.fallowReason?.trim() ?? "";
    return {
      valid: true,
      fallowUntil: options.fallowUntil,
      fallowReason: trimmed ? trimmed.slice(0, FALLOW_REASON_MAX) : null,
    };
  }

  private validateTopic(row: ElementRow | null): FallowSkipReason | null {
    if (!row) return "missing";
    if (row.deletedAt) return "deleted";
    if (row.type !== "topic") return "not-topic";
    if (!isQueueActionableStatus(row.status as ElementStatus)) return "not-actionable";
    return null;
  }

  private attentionRowsToFallowWithin(
    tx: DbClient,
    input: {
      readonly topicId: ElementId;
      readonly fallowUntil: IsoTimestamp;
      readonly activeFallowUntil: string | null;
      readonly activePreimages: ReadonlyMap<ElementId, FallowPreimage> | null;
    },
  ): ElementRow[] {
    const fallowMs = Date.parse(input.fallowUntil);
    // Shared with the T135 descendant inventory so fallow and the lineage-delete
    // blast-radius walk agree on the live-descendant set (one DFS, not two).
    return liveDescendantsWithin(tx, input.topicId).filter((row) => {
      if (row.deletedAt) return false;
      if (row.type === "card" || row.type === "concept") return false;
      if (!isQueueActionableStatus(row.status as ElementStatus)) return false;
      if (!row.dueAt) return false;
      if (input.activePreimages) {
        return (
          input.activePreimages.has(row.id as ElementId) &&
          input.activeFallowUntil != null &&
          row.dueAt === input.activeFallowUntil
        );
      }
      const dueMs = Date.parse(row.dueAt);
      return Number.isFinite(dueMs) && dueMs < fallowMs;
    });
  }

  private fallowReschedulesForBatchWithin(
    tx: DbClient,
    batchId: string,
    topicId: ElementId,
  ): ParsedOp[] {
    const rows = tx
      .select()
      .from(operationLog)
      .where(
        and(
          eq(operationLog.opType, "reschedule_element"),
          sql`json_extract(${operationLog.payload}, '$.batchId') = ${batchId}`,
          sql`json_extract(${operationLog.payload}, '$.topicId') = ${topicId}`,
        ),
      )
      .orderBy(desc(operationLog.createdAt), desc(sql`rowid`))
      .all();
    return rows
      .map((row) => parseOp(row))
      .filter((op) => op.payload.batchId === batchId && op.payload.fallow === true);
  }

  private fallowPreimagesForBatchWithin(
    tx: DbClient,
    batchId: string,
    topicId: ElementId,
  ): Map<ElementId, FallowPreimage> {
    const out = new Map<ElementId, FallowPreimage>();
    for (const op of this.fallowReschedulesForBatchWithin(tx, batchId, topicId)) {
      if (!op.elementId) continue;
      out.set(op.elementId, {
        prevDueAt: restoreDueAtPayload(op.payload),
        prevStatus: restoreStatusPayload(op.payload),
      });
    }
    return out;
  }

  private readRowWithin(tx: DbClient, id: ElementId): ElementRow | null {
    return tx.select().from(elements).where(eq(elements.id, id)).get() ?? null;
  }

  private appendChronicResetWithin(
    tx: DbClient,
    input: {
      readonly topicId: ElementId;
      readonly batchId: string;
      readonly prevEffectivePostponeCount: number;
    },
  ): void {
    new OperationLogRepository(tx).append(tx, {
      opType: "update_element",
      elementId: input.topicId,
      payload: {
        id: input.topicId,
        action: "chronicPostpone:fallow",
        decision: "fallow",
        chronicPostponeReset: true,
        prevEffectivePostponeCount: input.prevEffectivePostponeCount,
        batchId: input.batchId,
      },
    });
  }
}

function parseOp(row: typeof operationLog.$inferSelect): ParsedOp {
  let payload: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.payload) as unknown;
    if (parsed && typeof parsed === "object") payload = parsed as Record<string, unknown>;
  } catch {
    payload = {};
  }
  return {
    opType: row.opType,
    elementId: (row.elementId as ElementId | null) ?? null,
    payload,
  };
}

function stringPayload(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" ? value : null;
}

function restoreDueAtPayload(payload: Record<string, unknown>): IsoTimestamp | null {
  if (Object.hasOwn(payload, "fallowOriginalDueAt")) {
    return stringOrNull(payload.fallowOriginalDueAt);
  }
  return stringOrNull(payload.prevDueAt);
}

function restoreStatusPayload(payload: Record<string, unknown>): ElementStatus | undefined {
  const value = Object.hasOwn(payload, "fallowOriginalStatus")
    ? payload.fallowOriginalStatus
    : payload.prevStatus;
  return typeof value === "string" ? (value as ElementStatus) : undefined;
}

function fallowOriginalScheduleExtras(
  preimage: FallowPreimage | null,
): Readonly<Record<string, unknown>> {
  if (!preimage) return {};
  return {
    fallowOriginalDueAt: preimage.prevDueAt,
    ...(preimage.prevStatus !== undefined ? { fallowOriginalStatus: preimage.prevStatus } : {}),
  };
}

function stringOrNull(value: unknown): IsoTimestamp | null {
  return typeof value === "string" ? (value as IsoTimestamp) : null;
}

function isCanonicalUtcIsoTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}
