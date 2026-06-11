/**
 * PriorityIntegrityQuery (T105) — the receipt for priority fidelity.
 *
 * Read-only analytics over durable facts:
 * - attention service: `reschedule_element` ops with action extract/rewrite/activate/done;
 * - FSRS service: `review_logs`;
 * - deferral: `reschedule_element` ops with `postpone === true`.
 *
 * It never mutates and never appends `operation_log`. Metrics are attributed to current priority
 * bands, with a guard that suppresses strong A-band deferred warnings when a row had an in-window
 * priority edit.
 */

import { type ElementStatus, type PriorityLabel, priorityToLabel } from "@interleave/core";
import { cards, elements, type InterleaveDatabase, operationLog, reviewLogs } from "@interleave/db";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { isQueueActionableStatus } from "./queue-repository";

export const DEFAULT_PRIORITY_INTEGRITY_WINDOW_DAYS = 30;
export const DEFAULT_PRIORITY_INTEGRITY_SACRIFICED_LIMIT = 8;
export const DEFAULT_PRIORITY_INTEGRITY_TOPIC_LIMIT = 8;
export const A_BAND_SHARE_WARN_THRESHOLD = 0.4;
export const POSTPONE_DEBT_HIGH_DAYS = 14;

const PRIORITY_LABEL_ORDER: readonly PriorityLabel[] = ["A", "B", "C", "D"];
const ATTENTION_SERVICE_ACTIONS = new Set(["extract", "rewrite", "activate", "done"]);
const DAY_MS = 86_400_000;

export interface PriorityIntegrityOptions {
  readonly windowDays?: number;
  readonly sacrificedLimit?: number;
  readonly topicLimit?: number;
}

export interface PriorityIntegrityBandSummary {
  readonly band: PriorityLabel;
  readonly attentionServiced: number;
  readonly fsrsServiced: number;
  readonly deferred: number;
  readonly totalEvents: number;
  readonly serviceRate: number | null;
  readonly deferRate: number | null;
  readonly postponeDebtDays: number;
  readonly liveCount: number;
  readonly liveShare: number;
}

export interface PriorityIntegrityTopicSummary {
  readonly anchorId: string;
  readonly title: string;
  readonly type: string;
  readonly band: PriorityLabel;
  readonly attentionServiced: number;
  readonly fsrsServiced: number;
  readonly deferred: number;
  readonly postponeDebtDays: number;
}

export interface PriorityIntegritySacrificedRow {
  readonly id: string;
  readonly title: string;
  readonly type: string;
  readonly band: PriorityLabel;
  readonly scheduler: "attention" | "fsrs";
  readonly postponeCount: number;
  readonly postponeDebtDays: number;
  readonly latestDeferredAt: string;
  readonly topicAnchorId: string | null;
  readonly topicTitle: string | null;
}

export interface PriorityIntegrityRestingTopic {
  readonly topicId: string;
  readonly title: string;
  readonly band: PriorityLabel;
  readonly fallowUntil: string;
  readonly fallowReason: string | null;
}

export interface PriorityIntegrityThresholdFlags {
  readonly aBandInflation: boolean;
  readonly aBandDeferredRecently: boolean;
  readonly postponeDebtHigh: boolean;
}

export interface PriorityIntegritySummary {
  readonly asOf: string;
  readonly windowDays: number;
  readonly priorityAttribution: "current";
  readonly bands: readonly PriorityIntegrityBandSummary[];
  readonly topics: readonly PriorityIntegrityTopicSummary[];
  readonly sacrificed: readonly PriorityIntegritySacrificedRow[];
  readonly resting: readonly PriorityIntegrityRestingTopic[];
  readonly thresholdFlags: PriorityIntegrityThresholdFlags;
}

interface ElementInfo {
  readonly id: string;
  readonly title: string;
  readonly type: string;
  readonly priority: number;
  readonly band: PriorityLabel;
  readonly sourceId: string | null;
  readonly parentId: string | null;
  readonly fallowUntil: string | null;
  readonly fallowReason: string | null;
  readonly accountable: boolean;
  readonly eventEligible: boolean;
  readonly scheduler: "attention" | "fsrs";
}

interface MutableBand {
  band: PriorityLabel;
  attentionServiced: number;
  fsrsServiced: number;
  deferred: number;
  postponeDebtDays: number;
  liveCount: number;
}

interface MutableTopic {
  anchorId: string;
  title: string;
  type: string;
  band: PriorityLabel;
  attentionServiced: number;
  fsrsServiced: number;
  deferred: number;
  postponeDebtDays: number;
}

interface MutableSacrifice {
  id: string;
  title: string;
  type: string;
  band: PriorityLabel;
  scheduler: "attention" | "fsrs";
  postponeCount: number;
  postponeDebtDays: number;
  latestDeferredAt: string;
  topicAnchorId: string | null;
  topicTitle: string | null;
}

function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

function safePayload(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function stringField(payload: Record<string, unknown> | null, key: string): string | null {
  const value = payload?.[key];
  return typeof value === "string" ? value : null;
}

function validMs(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function debtDays(prev: string | null, due: string | null, opCreatedAt: string): number {
  const prevMs = validMs(prev);
  const dueMs = validMs(due);
  const opMs = validMs(opCreatedAt);
  if (prevMs === null || dueMs === null || opMs === null) return 0;
  return Math.max(0, (dueMs - Math.max(prevMs, opMs)) / DAY_MS);
}

function wasDueOrUnknown(prev: string | null, opCreatedAt: string): boolean {
  const prevMs = validMs(prev);
  const opMs = validMs(opCreatedAt);
  if (prevMs === null || opMs === null) return true;
  return prevMs <= opMs;
}

function wasDue(prev: string | null, opCreatedAt: string): boolean {
  const prevMs = validMs(prev);
  const opMs = validMs(opCreatedAt);
  if (prevMs === null || opMs === null) return false;
  return prevMs <= opMs;
}

function zeroBand(label: PriorityLabel): MutableBand {
  return {
    band: label,
    attentionServiced: 0,
    fsrsServiced: 0,
    deferred: 0,
    postponeDebtDays: 0,
    liveCount: 0,
  };
}

function finalizeBand(b: MutableBand, liveTotal: number): PriorityIntegrityBandSummary {
  const serviced = b.attentionServiced + b.fsrsServiced;
  const totalEvents = serviced + b.deferred;
  return {
    band: b.band,
    attentionServiced: b.attentionServiced,
    fsrsServiced: b.fsrsServiced,
    deferred: b.deferred,
    totalEvents,
    serviceRate: totalEvents > 0 ? serviced / totalEvents : null,
    deferRate: totalEvents > 0 ? b.deferred / totalEvents : null,
    postponeDebtDays: Math.round(b.postponeDebtDays * 10) / 10,
    liveCount: b.liveCount,
    liveShare: liveTotal > 0 ? b.liveCount / liveTotal : 0,
  };
}

export class PriorityIntegrityQuery {
  constructor(private readonly db: InterleaveDatabase) {}

  compute(asOf: string, options: PriorityIntegrityOptions = {}): PriorityIntegritySummary {
    const windowDays = options.windowDays ?? DEFAULT_PRIORITY_INTEGRITY_WINDOW_DAYS;
    const sacrificedLimit = options.sacrificedLimit ?? DEFAULT_PRIORITY_INTEGRITY_SACRIFICED_LIMIT;
    const topicLimit = options.topicLimit ?? DEFAULT_PRIORITY_INTEGRITY_TOPIC_LIMIT;
    const asOfDate = new Date(asOf);
    const windowStart = startOfLocalDay(asOfDate);
    windowStart.setDate(windowStart.getDate() - (windowDays - 1));
    const windowStartIso = windowStart.toISOString();

    const info = this.elementInfo();
    const bands = new Map<PriorityLabel, MutableBand>(
      PRIORITY_LABEL_ORDER.map((label) => [label, zeroBand(label)]),
    );
    const topics = new Map<string, MutableTopic>();
    const sacrificed = new Map<string, MutableSacrifice>();
    const priorityEdited = this.priorityEditedIds(windowStartIso, asOf);

    let liveTotal = 0;
    for (const element of info.values()) {
      if (!element.accountable) continue;
      liveTotal += 1;
      const band = bands.get(element.band);
      if (band) band.liveCount += 1;
    }

    const addTopic = (
      element: ElementInfo,
      kind: "attentionServiced" | "fsrsServiced" | "deferred",
      debt = 0,
    ) => {
      const anchor = this.topicAnchor(element, info);
      if (!anchor) return;
      let row = topics.get(anchor.id);
      if (!row) {
        row = {
          anchorId: anchor.id,
          title: anchor.title,
          type: anchor.type,
          band: anchor.band,
          attentionServiced: 0,
          fsrsServiced: 0,
          deferred: 0,
          postponeDebtDays: 0,
        };
        topics.set(anchor.id, row);
      }
      row[kind] += 1;
      row.postponeDebtDays += debt;
    };

    const serviceOps = this.db
      .select()
      .from(operationLog)
      .where(
        and(
          eq(operationLog.opType, "reschedule_element"),
          gte(operationLog.createdAt, windowStartIso),
          lte(operationLog.createdAt, asOf),
        ),
      )
      .orderBy(desc(operationLog.createdAt), desc(sql`rowid`))
      .all();

    let reliableADeferred = 0;
    for (const op of serviceOps) {
      if (!op.elementId) continue;
      const element = info.get(op.elementId);
      if (!element?.eventEligible) continue;
      const payload = safePayload(op.payload);
      if (payload?.fallow === true) continue;
      const band = bands.get(element.band);
      if (!band) continue;

      if (payload?.postpone === true) {
        const prevDue =
          payload.cardDefer === true
            ? stringField(payload, "prevReviewDueAt")
            : stringField(payload, "prevDueAt");
        if (!wasDueOrUnknown(prevDue, op.createdAt)) continue;
        const due = stringField(payload, "dueAt");
        const addedDebt = debtDays(prevDue, due, op.createdAt);
        band.deferred += 1;
        band.postponeDebtDays += addedDebt;
        addTopic(element, "deferred", addedDebt);
        if (element.band === "A" && !priorityEdited.has(element.id)) reliableADeferred += 1;
        const anchor = this.topicAnchor(element, info);
        const current = sacrificed.get(element.id);
        sacrificed.set(element.id, {
          id: element.id,
          title: element.title,
          type: element.type,
          band: element.band,
          scheduler: payload.cardDefer === true ? "fsrs" : element.scheduler,
          postponeCount: (current?.postponeCount ?? 0) + 1,
          postponeDebtDays: (current?.postponeDebtDays ?? 0) + addedDebt,
          latestDeferredAt: current?.latestDeferredAt ?? op.createdAt,
          topicAnchorId: anchor?.id ?? null,
          topicTitle: anchor?.title ?? null,
        });
        continue;
      }

      const action = stringField(payload, "action");
      const unmarkedDueAttentionService =
        !action &&
        element.scheduler === "attention" &&
        wasDue(stringField(payload, "prevDueAt"), op.createdAt);
      if ((action && ATTENTION_SERVICE_ACTIONS.has(action)) || unmarkedDueAttentionService) {
        band.attentionServiced += 1;
        addTopic(element, "attentionServiced");
      }
    }

    const logs = this.db
      .select({
        elementId: reviewLogs.elementId,
        reviewedAt: reviewLogs.reviewedAt,
      })
      .from(reviewLogs)
      .where(and(gte(reviewLogs.reviewedAt, windowStartIso), lte(reviewLogs.reviewedAt, asOf)))
      .all();
    for (const log of logs) {
      const element = info.get(log.elementId);
      if (!element?.eventEligible) continue;
      const band = bands.get(element.band);
      if (!band) continue;
      band.fsrsServiced += 1;
      addTopic(element, "fsrsServiced");
    }

    const finalizedBands = PRIORITY_LABEL_ORDER.map((label) =>
      finalizeBand(bands.get(label) ?? zeroBand(label), liveTotal),
    );
    const aBand = finalizedBands.find((b) => b.band === "A") ?? finalizedBands[0];
    const thresholdFlags = {
      aBandInflation: (aBand?.liveShare ?? 0) > A_BAND_SHARE_WARN_THRESHOLD,
      aBandDeferredRecently: reliableADeferred > 0,
      postponeDebtHigh: finalizedBands.some((b) => b.postponeDebtDays >= POSTPONE_DEBT_HIGH_DAYS),
    };

    return {
      asOf,
      windowDays,
      priorityAttribution: "current",
      bands: finalizedBands,
      topics: [...topics.values()]
        .sort((a, b) => b.deferred - a.deferred || b.postponeDebtDays - a.postponeDebtDays)
        .slice(0, topicLimit)
        .map((row) => ({ ...row, postponeDebtDays: Math.round(row.postponeDebtDays * 10) / 10 })),
      sacrificed: [...sacrificed.values()]
        .sort(
          (a, b) => b.postponeCount - a.postponeCount || b.postponeDebtDays - a.postponeDebtDays,
        )
        .slice(0, sacrificedLimit)
        .map((row) => ({
          ...row,
          postponeDebtDays: Math.round(row.postponeDebtDays * 10) / 10,
        })),
      resting: this.restingTopics(info, asOf).slice(0, topicLimit),
      thresholdFlags,
    };
  }

  private elementInfo(): Map<string, ElementInfo> {
    const cardRows = this.db
      .select({ elementId: cards.elementId, isRetired: cards.isRetired })
      .from(cards)
      .all();
    const retiredCards = new Set(
      cardRows.filter((row) => row.isRetired).map((row) => row.elementId),
    );
    const rows = this.db
      .select({
        id: elements.id,
        title: elements.title,
        type: elements.type,
        status: elements.status,
        priority: elements.priority,
        sourceId: elements.sourceId,
        parentId: elements.parentId,
        fallowUntil: elements.fallowUntil,
        fallowReason: elements.fallowReason,
        deletedAt: elements.deletedAt,
      })
      .from(elements)
      .all();
    const out = new Map<string, ElementInfo>();
    for (const row of rows) {
      const band = priorityToLabel(row.priority);
      const scheduler = row.type === "card" ? "fsrs" : "attention";
      const notDeleted = row.deletedAt === null;
      const notRetired = !retiredCards.has(row.id);
      const status = row.status as ElementStatus;
      const queueActionable = isQueueActionableStatus(status);
      out.set(row.id, {
        id: row.id,
        title: row.title,
        type: row.type,
        priority: row.priority,
        band,
        sourceId: row.sourceId,
        parentId: row.parentId,
        fallowUntil: row.fallowUntil,
        fallowReason: row.fallowReason,
        scheduler,
        accountable: notDeleted && queueActionable && notRetired,
        eventEligible: notDeleted && notRetired && (queueActionable || status === "done"),
      });
    }
    return out;
  }

  private priorityEditedIds(start: string, end: string): Set<string> {
    const rows = this.db
      .select({ elementId: operationLog.elementId, payload: operationLog.payload })
      .from(operationLog)
      .where(
        and(
          eq(operationLog.opType, "update_element"),
          gte(operationLog.createdAt, start),
          lte(operationLog.createdAt, end),
        ),
      )
      .all();
    const ids = new Set<string>();
    for (const row of rows) {
      if (!row.elementId) continue;
      const payload = safePayload(row.payload);
      const patch = payload?.patch;
      if (typeof patch === "object" && patch !== null && "priority" in patch)
        ids.add(row.elementId);
    }
    return ids;
  }

  private topicAnchor(element: ElementInfo, info: Map<string, ElementInfo>): ElementInfo | null {
    if (element.type === "topic" || element.type === "source") return element;
    if (element.sourceId && info.has(element.sourceId)) return info.get(element.sourceId) ?? null;
    if (element.parentId && info.has(element.parentId)) return info.get(element.parentId) ?? null;
    return null;
  }

  private restingTopics(
    info: Map<string, ElementInfo>,
    asOf: string,
  ): PriorityIntegrityRestingTopic[] {
    const asOfMs = Date.parse(asOf);
    return [...info.values()]
      .filter((element) => {
        if (element.type !== "topic" || !element.accountable || !element.fallowUntil) return false;
        const untilMs = Date.parse(element.fallowUntil);
        return Number.isFinite(untilMs) && Number.isFinite(asOfMs) && untilMs > asOfMs;
      })
      .sort((a, b) => String(a.fallowUntil).localeCompare(String(b.fallowUntil)))
      .map((element) => ({
        topicId: element.id,
        title: element.title,
        band: element.band,
        fallowUntil: element.fallowUntil as string,
        fallowReason: element.fallowReason,
      }));
  }
}
