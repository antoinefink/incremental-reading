import type { Element, ElementId, IsoTimestamp, Priority, PriorityLabel } from "@interleave/core";
import { priorityToLabel } from "@interleave/core";
import type { BlockProcessingService } from "./block-processing-service";
import { nowIso } from "./ids";
import type { Repositories } from "./index";

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
