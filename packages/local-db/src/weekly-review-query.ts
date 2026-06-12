import type { ElementId, IsoTimestamp, PriorityLabel } from "@interleave/core";
import { elements, type InterleaveDatabase, reviewLogs } from "@interleave/db";
import { and, count, eq, gte, lte, sql } from "drizzle-orm";
import { nowIso } from "./ids";
import type { Repositories } from "./index";
import type {
  PriorityIntegrityBandSummary,
  PriorityIntegritySummary,
} from "./priority-integrity-query";
import type { TaskSummary } from "./task-service";
import type { WeeklyReviewProgress } from "./weekly-review-service";

export interface WeeklyReviewWindow {
  readonly start: IsoTimestamp;
  readonly end: IsoTimestamp;
  readonly days: number;
}

export interface WeeklyReviewLedger {
  readonly sources: number;
  readonly extracts: number;
  readonly cards: number;
  readonly maturedCards: number;
  readonly priorityMisses: readonly WeeklyReviewPriorityMiss[];
}

export interface WeeklyReviewPriorityMiss {
  readonly band: PriorityLabel;
  readonly deferred: number;
  readonly postponeDebtDays: number;
}

export interface WeeklyReviewFallowSuggestion {
  readonly topicId: ElementId;
  readonly title: string;
  readonly band: PriorityLabel;
  readonly deferred: number;
  readonly postponeDebtDays: number;
}

export interface WeeklyReviewDecisions {
  readonly parked: ReturnType<Repositories["parkedResurfacingQuery"]["listDue"]>;
  readonly chronic: ReturnType<Repositories["chronicPostpone"]["listDue"]>;
  readonly fallowSuggestions: readonly WeeklyReviewFallowSuggestion[];
}

export interface WeeklyReviewSummary {
  readonly asOf: IsoTimestamp;
  readonly enabled: boolean;
  readonly cadenceDays: number;
  readonly session: TaskSummary | null;
  readonly due: boolean;
  readonly window: WeeklyReviewWindow;
  readonly progress: WeeklyReviewProgress | null;
  readonly ledger: WeeklyReviewLedger;
  readonly integrity: PriorityIntegritySummary;
  readonly decisions: WeeklyReviewDecisions;
}

const WEEKLY_WINDOW_DAYS = 7;
const DECISION_LIMIT = 8;

export class WeeklyReviewQuery {
  constructor(
    private readonly db: InterleaveDatabase,
    private readonly repos: Repositories,
  ) {}

  summary(asOf: IsoTimestamp = nowIso()): WeeklyReviewSummary {
    const settings = this.repos.settings.getAppSettings();
    const window = weeklyWindow(asOf);
    const session = this.repos.weeklyReviewService.ensureSession(asOf);
    const progress = this.repos.weeklyReviewService.progressFor(session, {
      start: window.start,
      end: window.end,
    });
    const integrity = this.repos.priorityIntegrity.compute(asOf, {
      windowDays: WEEKLY_WINDOW_DAYS,
      sacrificedLimit: DECISION_LIMIT,
      topicLimit: DECISION_LIMIT,
    });

    return {
      asOf,
      enabled: settings.weeklyReviewEnabled,
      cadenceDays: settings.weeklyReviewCadenceDays,
      session,
      due: isDue(session, asOf),
      window,
      progress,
      ledger: this.ledger(window, integrity.bands),
      integrity,
      decisions: {
        parked: this.repos.parkedResurfacingQuery.listDue({
          asOf,
          resurfaceAfterDays: settings.parkedResurfaceAfterDays,
          limit: DECISION_LIMIT,
        }),
        chronic: this.repos.chronicPostpone.listDue({
          threshold: settings.chronicPostponeThreshold,
          limit: DECISION_LIMIT,
        }),
        fallowSuggestions: fallowSuggestions(integrity),
      },
    };
  }

  private ledger(
    window: WeeklyReviewWindow,
    bands: readonly PriorityIntegrityBandSummary[],
  ): WeeklyReviewLedger {
    return {
      sources: this.countElements("source", window),
      extracts: this.countElements("extract", window),
      cards: this.countElements("card", window),
      maturedCards: this.countMaturedCards(window),
      priorityMisses: bands
        .filter((band) => band.deferred > 0)
        .map((band) => ({
          band: band.band,
          deferred: band.deferred,
          postponeDebtDays: band.postponeDebtDays,
        })),
    };
  }

  private countElements(type: string, window: WeeklyReviewWindow): number {
    return (
      this.db
        .select({ value: count() })
        .from(elements)
        .where(
          and(
            eq(elements.type, type),
            gte(elements.createdAt, window.start),
            lte(elements.createdAt, window.end),
          ),
        )
        .get()?.value ?? 0
    );
  }

  private countMaturedCards(window: WeeklyReviewWindow): number {
    const row = this.db
      .select({ value: sql<number>`count(distinct ${reviewLogs.elementId})` })
      .from(reviewLogs)
      .where(
        and(
          eq(reviewLogs.nextState, "review"),
          gte(reviewLogs.reviewedAt, window.start),
          lte(reviewLogs.reviewedAt, window.end),
        ),
      )
      .get();
    return Number(row?.value ?? 0);
  }
}

function weeklyWindow(asOf: IsoTimestamp): WeeklyReviewWindow {
  const end = new Date(asOf);
  const start = new Date(end);
  start.setDate(start.getDate() - (WEEKLY_WINDOW_DAYS - 1));
  start.setHours(0, 0, 0, 0);
  return {
    start: start.toISOString() as IsoTimestamp,
    end: asOf,
    days: WEEKLY_WINDOW_DAYS,
  };
}

function isDue(session: TaskSummary | null, asOf: IsoTimestamp): boolean {
  if (!session?.dueAt) return false;
  return Date.parse(session.dueAt) <= Date.parse(asOf);
}

function fallowSuggestions(integrity: PriorityIntegritySummary): WeeklyReviewFallowSuggestion[] {
  const restingIds = new Set(integrity.resting.map((row) => row.topicId));
  return integrity.topics
    .filter((topic) => topic.type === "topic")
    .filter((topic) => !restingIds.has(topic.anchorId))
    .filter((topic) => topic.deferred > 0 || topic.postponeDebtDays > 0)
    .map((topic) => ({
      topicId: topic.anchorId as ElementId,
      title: topic.title,
      band: topic.band,
      deferred: topic.deferred,
      postponeDebtDays: topic.postponeDebtDays,
    }));
}
