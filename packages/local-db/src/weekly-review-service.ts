import type { ElementId, IsoTimestamp } from "@interleave/core";
import { PRIORITY_LABEL_VALUE } from "@interleave/core";
import {
  elements as elementsTable,
  type InterleaveDatabase,
  settings as settingsTable,
  tasks as tasksTable,
} from "@interleave/db";
import { addDays } from "@interleave/scheduler";
import { and, count, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { ElementRepository } from "./element-repository";
import { nowIso } from "./ids";
import { OperationLogRepository } from "./operation-log-repository";
import { SettingsRepository } from "./settings-repository";
import { TASK_STAGE, TaskService, type TaskSummary } from "./task-service";
import type { DbClient } from "./types";

const CLOSED_TASK_STATUSES = ["done", "parked", "dismissed", "deleted"] as const;
const WEEKLY_PROGRESS_KEY = "weeklyReview.progress.v1";

export type WeeklyReviewSectionId = "ledger" | "integrity" | "parked" | "chronic" | "fallow";
export type WeeklyReviewSectionState = "pending" | "done" | "skipped";

export interface WeeklyReviewProgress {
  readonly taskId: ElementId;
  readonly windowStart: IsoTimestamp;
  readonly windowEnd: IsoTimestamp;
  readonly sections: Readonly<Record<WeeklyReviewSectionId, WeeklyReviewSectionState>>;
}

export interface WeeklyReviewProgressPatch {
  readonly taskId: ElementId;
  readonly sections: Partial<Record<WeeklyReviewSectionId, WeeklyReviewSectionState | undefined>>;
}

export interface WeeklyReviewLifecycleResult {
  readonly task: TaskSummary | null;
  readonly progress: WeeklyReviewProgress | null;
}

export class WeeklyReviewService {
  private readonly elements: ElementRepository;
  private readonly settings: SettingsRepository;
  private readonly tasks: TaskService;

  constructor(private readonly db: InterleaveDatabase) {
    this.elements = new ElementRepository(db);
    this.settings = new SettingsRepository(db);
    this.tasks = new TaskService(db);
  }

  ensureSession(asOf: IsoTimestamp = nowIso()): TaskSummary | null {
    return this.initializeSession(asOf);
  }

  initializeSession(asOf: IsoTimestamp = nowIso()): TaskSummary | null {
    const appSettings = this.settings.getAppSettings();
    if (!appSettings.weeklyReviewEnabled) {
      this.disable(asOf);
      return null;
    }
    this.repairSoftDeletedOpenSessions();
    const existing = this.findSession();
    if (existing) return existing;
    return this.createSession(asOf, this.initialDueAt(asOf));
  }

  disable(asOf: IsoTimestamp = nowIso()): void {
    this.dismissOpenSessions(asOf, "weeklyReview:disable");
    this.settings.delete(WEEKLY_PROGRESS_KEY);
  }

  findSession(): TaskSummary | null {
    this.repairSoftDeletedOpenSessions();
    const row = this.db
      .select({ elementId: tasksTable.elementId })
      .from(tasksTable)
      .innerJoin(elementsTable, eq(elementsTable.id, tasksTable.elementId))
      .where(
        and(
          eq(tasksTable.taskType, "weekly_review"),
          isNull(elementsTable.deletedAt),
          notInArray(tasksTable.status, CLOSED_TASK_STATUSES as unknown as string[]),
        ),
      )
      .get();
    return row ? this.tasks.findTask(row.elementId as ElementId) : null;
  }

  progressFor(
    task: TaskSummary | null,
    window: { readonly start: IsoTimestamp; readonly end: IsoTimestamp },
  ): WeeklyReviewProgress | null {
    if (!task) return null;
    const current = this.settings.get<WeeklyReviewProgress>(WEEKLY_PROGRESS_KEY);
    if (isProgressForTask(current, task.id)) return current;
    const next = defaultProgress(task.id, window);
    this.db.transaction((tx) =>
      this.setProgressWithin(tx, task.id, next, "weeklyReview:progress:init"),
    );
    return next;
  }

  updateProgress(patch: WeeklyReviewProgressPatch): WeeklyReviewProgress {
    const current = this.settings.get<WeeklyReviewProgress>(WEEKLY_PROGRESS_KEY);
    if (!isProgressForTask(current, patch.taskId)) {
      throw new Error(`WeeklyReviewService.updateProgress: progress for ${patch.taskId} not found`);
    }
    const sections = { ...current.sections };
    for (const [section, state] of Object.entries(patch.sections)) {
      if (isSectionId(section) && isSectionState(state)) sections[section] = state;
    }
    const next: WeeklyReviewProgress = { ...current, sections };
    this.db.transaction((tx) =>
      this.setProgressWithin(tx, patch.taskId, next, "weeklyReview:progress:update"),
    );
    return next;
  }

  completeSession(taskId: ElementId, asOf: IsoTimestamp = nowIso()): WeeklyReviewLifecycleResult {
    const cadenceDays = this.settings.getAppSettings().weeklyReviewCadenceDays;
    const dueAt = addDays(asOf, cadenceDays);
    const nextTask = this.db.transaction((tx) => {
      const task = this.tasks.findTask(taskId);
      if (task?.taskType !== "weekly_review") {
        throw new Error(`WeeklyReviewService: weekly review task ${taskId} not found`);
      }
      this.elements.rescheduleWithin(tx, taskId, null, "done", { action: "weeklyReview:complete" });
      tx.update(tasksTable)
        .set({ status: "done", dueAt: null })
        .where(eq(tasksTable.elementId, taskId))
        .run();
      tx.delete(settingsTable).where(eq(settingsTable.key, WEEKLY_PROGRESS_KEY)).run();
      return this.createSessionWithin(tx, dueAt, dueAt);
    });
    return { task: nextTask, progress: null };
  }

  dismissSession(
    taskId: ElementId,
    options: { readonly asOf?: IsoTimestamp; readonly snoozeDays?: number } = {},
  ): WeeklyReviewLifecycleResult {
    const asOf = options.asOf ?? nowIso();
    const dueAt = addDays(asOf, Math.max(1, Math.round(options.snoozeDays ?? 1)));
    return this.rescheduleSession(taskId, dueAt, "weeklyReview:dismiss", false);
  }

  private createSession(asOf: IsoTimestamp, dueAt: IsoTimestamp): TaskSummary {
    return this.db.transaction((tx) => {
      return this.createSessionWithin(tx, asOf, dueAt);
    });
  }

  private createSessionWithin(tx: DbClient, asOf: IsoTimestamp, dueAt: IsoTimestamp): TaskSummary {
    const element = this.elements.createWithin(tx, {
      type: "task",
      status: "scheduled",
      stage: TASK_STAGE,
      priority: PRIORITY_LABEL_VALUE.D,
      title: "Weekly review",
      dueAt,
    });
    tx.insert(tasksTable)
      .values({
        elementId: element.id,
        taskType: "weekly_review",
        dueAt,
        status: "scheduled",
        linkedElementId: null,
        note: "Weekly ledger and integrity session",
      })
      .run();
    new OperationLogRepository(tx).append(tx, {
      opType: "update_element",
      elementId: element.id,
      payload: { weeklyReviewSession: true, action: "weeklyReview:create", asOf, dueAt },
    });
    return this.tasks.findTask(element.id) ?? missingTask(element.id);
  }

  private rescheduleSession(
    taskId: ElementId,
    dueAt: IsoTimestamp,
    action: string,
    resetProgress: boolean,
  ): WeeklyReviewLifecycleResult {
    const task = this.tasks.findTask(taskId);
    if (task?.taskType !== "weekly_review") {
      throw new Error(`WeeklyReviewService: weekly review task ${taskId} not found`);
    }
    const nextTask = this.db.transaction((tx) => {
      this.elements.rescheduleWithin(tx, taskId, dueAt, "scheduled", { action });
      tx.update(tasksTable)
        .set({ status: "scheduled", dueAt })
        .where(eq(tasksTable.elementId, taskId))
        .run();
      return this.tasks.findTask(taskId) ?? missingTask(taskId);
    });
    if (resetProgress) this.settings.delete(WEEKLY_PROGRESS_KEY);
    return {
      task: nextTask,
      progress: resetProgress ? null : this.settings.get<WeeklyReviewProgress>(WEEKLY_PROGRESS_KEY),
    };
  }

  private dismissOpenSessions(asOf: IsoTimestamp, action: string): void {
    const rows = this.db
      .select({ elementId: tasksTable.elementId })
      .from(tasksTable)
      .innerJoin(elementsTable, eq(elementsTable.id, tasksTable.elementId))
      .where(
        and(
          eq(tasksTable.taskType, "weekly_review"),
          isNull(elementsTable.deletedAt),
          notInArray(tasksTable.status, CLOSED_TASK_STATUSES as unknown as string[]),
        ),
      )
      .all();
    this.db.transaction((tx) => {
      for (const row of rows) {
        const id = row.elementId as ElementId;
        this.elements.rescheduleWithin(tx, id, null, "dismissed", { action, asOf });
        tx.update(tasksTable)
          .set({ status: "dismissed", dueAt: null })
          .where(eq(tasksTable.elementId, id))
          .run();
      }
    });
  }

  private initialDueAt(asOf: IsoTimestamp): IsoTimestamp {
    if (this.hasWeeklyReviewMaterial()) return asOf;
    const cadenceDays = this.settings.getAppSettings().weeklyReviewCadenceDays;
    return addDays(asOf, cadenceDays);
  }

  private hasWeeklyReviewMaterial(): boolean {
    const row = this.db
      .select({ value: count() })
      .from(elementsTable)
      .where(
        and(
          isNull(elementsTable.deletedAt),
          inArray(elementsTable.type, ["source", "extract", "card", "topic", "synthesis_note"]),
        ),
      )
      .get();
    return Number(row?.value ?? 0) > 0;
  }

  private repairSoftDeletedOpenSessions(): void {
    this.db
      .update(tasksTable)
      .set({ status: "deleted", dueAt: null })
      .where(
        and(
          eq(tasksTable.taskType, "weekly_review"),
          notInArray(tasksTable.status, CLOSED_TASK_STATUSES as unknown as string[]),
          sql`exists (
            select 1
            from ${elementsTable}
            where ${elementsTable.id} = ${tasksTable.elementId}
              and ${elementsTable.deletedAt} is not null
          )`,
        ),
      )
      .run();
  }

  private setProgressWithin(
    tx: DbClient,
    taskId: ElementId,
    progress: WeeklyReviewProgress,
    action: string,
  ): void {
    const json = JSON.stringify(progress);
    tx.insert(settingsTable)
      .values({ key: WEEKLY_PROGRESS_KEY, value: json })
      .onConflictDoUpdate({ target: settingsTable.key, set: { value: json } })
      .run();
    new OperationLogRepository(tx).append(tx, {
      opType: "update_element",
      elementId: taskId,
      payload: { weeklyReviewProgress: true, action, progress },
    });
  }
}

function defaultProgress(
  taskId: ElementId,
  window: { readonly start: IsoTimestamp; readonly end: IsoTimestamp },
): WeeklyReviewProgress {
  return {
    taskId,
    windowStart: window.start,
    windowEnd: window.end,
    sections: {
      ledger: "pending",
      integrity: "pending",
      parked: "pending",
      chronic: "pending",
      fallow: "pending",
    },
  };
}

function isProgressForTask(value: unknown, taskId: ElementId): value is WeeklyReviewProgress {
  return (
    typeof value === "object" && value !== null && (value as { taskId?: unknown }).taskId === taskId
  );
}

function isSectionId(value: string): value is WeeklyReviewSectionId {
  return ["ledger", "integrity", "parked", "chronic", "fallow"].includes(value);
}

function isSectionState(value: unknown): value is WeeklyReviewSectionState {
  return value === "pending" || value === "done" || value === "skipped";
}

function missingTask(id: ElementId): never {
  throw new Error(`WeeklyReviewService: task ${id} missing after mutation`);
}
