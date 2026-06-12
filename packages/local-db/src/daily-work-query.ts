import type { Element, ElementId, IsoTimestamp, Priority, PriorityLabel } from "@interleave/core";
import { priorityToLabel } from "@interleave/core";
import type { BlockProcessingService } from "./block-processing-service";
import { nowIso } from "./ids";
import type { Repositories } from "./index";
import {
  STANDING_AUTO_POSTPONE_STATE_KEY,
  type StandingAutoPostponeReceipt,
} from "./standing-auto-postpone-service";
import type {
  KnowledgeGraduationEvent,
  TopicKnowledgeGraduationStatus,
  TopicKnowledgeStateSubjectType,
} from "./topic-knowledge-state-query";

const OBSERVED_GRADUATION_STATE_KEY = "dailyWork.observedGraduationState.v1";
const DAILY_GRADUATION_SUBJECT_LIMIT = 200;

export type DailyWorkRecommendedAction =
  | "process_due_queue"
  | "triage_inbox"
  | "resume_unscheduled_source"
  | "clear";

export interface DailyWorkResumeSource {
  readonly id: ElementId;
  readonly title: string;
  readonly priority: Priority;
  readonly priorityLabel: PriorityLabel;
  readonly status: string;
  readonly stage: string;
  readonly updatedAt: IsoTimestamp;
  readonly unresolvedBlocks: number | null;
}

export interface DailyWorkSummary {
  readonly asOf: IsoTimestamp;
  readonly dueQueueItems: number;
  readonly inboxSources: number;
  readonly activeUnscheduledSources: number;
  readonly resumeSource: DailyWorkResumeSource | null;
  readonly recommendedAction: DailyWorkRecommendedAction;
  readonly graduationEvents: readonly KnowledgeGraduationEvent[];
  readonly autoPostponeReceipt: StandingAutoPostponeReceipt | null;
}

export interface DailyWorkGraduationAckRequest {
  readonly asOf?: IsoTimestamp;
  readonly eventIds?: readonly string[];
}

export interface DailyWorkGraduationAckResult {
  readonly asOf: IsoTimestamp;
  readonly acknowledgedEventIds: readonly string[];
  readonly observedSubjectCount: number;
}

interface ObservedGraduationSubject {
  readonly subjectType: TopicKnowledgeStateSubjectType;
  readonly subjectId: string;
  readonly status: TopicKnowledgeGraduationStatus;
  readonly thresholdVersion: "v1";
  readonly observedAt: IsoTimestamp;
}

interface ObservedGraduationState {
  readonly subjects: Record<string, ObservedGraduationSubject>;
}

export class DailyWorkQuery {
  constructor(
    private readonly repos: Repositories,
    private readonly blockProcessing: BlockProcessingService,
  ) {}

  summary(asOf: IsoTimestamp = nowIso()): DailyWorkSummary {
    const dueQueueItems =
      this.repos.queue.dueCardCount(asOf) + this.repos.queue.dueAttentionCount(asOf);
    const inboxSources = this.repos.queue.inboxCount("source");
    const resumeSources = this.activeUnscheduledSources();
    const resumeSource = resumeSources[0] ?? null;
    const graduationEvents = this.unacknowledgedGraduationEvents(asOf);
    const autoPostponeReceipt = this.autoPostponeReceipt(asOf);
    return {
      asOf,
      dueQueueItems,
      inboxSources,
      activeUnscheduledSources: resumeSources.length,
      resumeSource,
      recommendedAction: recommendedAction({
        dueQueueItems,
        inboxSources,
        activeUnscheduledSources: resumeSources.length,
      }),
      graduationEvents,
      autoPostponeReceipt,
    };
  }

  acknowledgeGraduationEvents(
    request: DailyWorkGraduationAckRequest = {},
  ): DailyWorkGraduationAckResult {
    const asOf = request.asOf ?? nowIso();
    const summary = this.repos.topicKnowledgeState.getTopicKnowledgeState(asOf, {
      limit: DAILY_GRADUATION_SUBJECT_LIMIT,
    });
    const currentEventIds = new Set(summary.graduationEvents.map((event) => event.eventId));
    const requested = request.eventIds ?? [];
    const acknowledgedEventIds =
      requested.length === 0 ? [] : requested.filter((eventId) => currentEventIds.has(eventId));
    const subjects: Record<string, ObservedGraduationSubject> = {
      ...this.observedGraduationState().subjects,
    };
    const acknowledged = new Set(acknowledgedEventIds);
    for (const subject of summary.subjects) {
      const eventId = `${subject.subjectType}:${subject.subjectId}:graduated:${subject.graduationState.thresholdVersion}`;
      if (requested.length > 0 && !acknowledged.has(eventId)) continue;
      subjects[graduationSubjectKey(subject.subjectType, subject.subjectId)] = {
        subjectType: subject.subjectType,
        subjectId: subject.subjectId,
        status: subject.graduationState.status,
        thresholdVersion: subject.graduationState.thresholdVersion,
        observedAt: asOf,
      };
    }
    this.repos.settings.set<ObservedGraduationState>(OBSERVED_GRADUATION_STATE_KEY, { subjects });

    return {
      asOf,
      acknowledgedEventIds,
      observedSubjectCount: summary.subjects.length,
    };
  }

  private activeUnscheduledSources(): DailyWorkResumeSource[] {
    return this.repos.elements
      .listByStatus("active")
      .filter((element): element is Element & { readonly type: "source" } => {
        return element.type === "source" && element.dueAt === null;
      })
      .map((element) => this.toResumeSource(element))
      .sort((a, b) => {
        const unresolvedA = a.unresolvedBlocks ?? 0;
        const unresolvedB = b.unresolvedBlocks ?? 0;
        if (unresolvedA !== unresolvedB) return unresolvedB - unresolvedA;
        const updated = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
        if (updated !== 0) return updated;
        return a.title.localeCompare(b.title);
      });
  }

  private toResumeSource(element: Element): DailyWorkResumeSource {
    return {
      id: element.id,
      title: element.title,
      priority: element.priority,
      priorityLabel: priorityToLabel(element.priority),
      status: element.status,
      stage: element.stage,
      updatedAt: element.updatedAt,
      unresolvedBlocks: this.unresolvedBlocks(element.id),
    };
  }

  private unresolvedBlocks(sourceElementId: ElementId): number | null {
    try {
      return this.blockProcessing.getSourceProcessingSummary(sourceElementId).unresolvedBlocks;
    } catch {
      return null;
    }
  }

  private unacknowledgedGraduationEvents(asOf: IsoTimestamp): KnowledgeGraduationEvent[] {
    const observed = this.observedGraduationState();
    const summary = this.repos.topicKnowledgeState.getTopicKnowledgeState(asOf, {
      limit: DAILY_GRADUATION_SUBJECT_LIMIT,
    });
    return summary.graduationEvents.filter((event) => {
      const prior = observed.subjects[graduationSubjectKey(event.subjectType, event.subjectId)];
      return prior?.status !== "graduated" || prior.thresholdVersion !== event.thresholdVersion;
    });
  }

  private observedGraduationState(): ObservedGraduationState {
    const value = this.repos.settings.get<ObservedGraduationState>(OBSERVED_GRADUATION_STATE_KEY);
    if (
      !value ||
      typeof value !== "object" ||
      !value.subjects ||
      typeof value.subjects !== "object"
    ) {
      return { subjects: {} };
    }
    return value;
  }

  private autoPostponeReceipt(asOf: IsoTimestamp): StandingAutoPostponeReceipt | null {
    const state = this.repos.settings.get<{
      readonly version?: unknown;
      readonly days?: Record<string, { readonly receipt?: StandingAutoPostponeReceipt }>;
    }>(STANDING_AUTO_POSTPONE_STATE_KEY);
    if (state?.version !== 1 || !state.days || typeof state.days !== "object") {
      return null;
    }
    return state.days[localDayOf(asOf)]?.receipt ?? null;
  }
}

function recommendedAction(input: {
  readonly dueQueueItems: number;
  readonly inboxSources: number;
  readonly activeUnscheduledSources: number;
}): DailyWorkRecommendedAction {
  if (input.dueQueueItems > 0) return "process_due_queue";
  if (input.inboxSources > 0) return "triage_inbox";
  if (input.activeUnscheduledSources > 0) return "resume_unscheduled_source";
  return "clear";
}

function graduationSubjectKey(
  subjectType: TopicKnowledgeStateSubjectType,
  subjectId: string,
): string {
  return `${subjectType}:${subjectId}`;
}

function localDayOf(iso: IsoTimestamp): string {
  const date = new Date(iso);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
