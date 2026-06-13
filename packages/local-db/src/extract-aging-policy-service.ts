import type { AppSettings, ElementId, ElementStatus, IsoTimestamp } from "@interleave/core";
import { elementRelations, elements, type InterleaveDatabase } from "@interleave/db";
import type { StagnationReason, StagnationSuggestion } from "@interleave/scheduler";
import { and, eq, isNull } from "drizzle-orm";
import { ElementRepository } from "./element-repository";
import {
  type ExtractAgingProjection,
  type ExtractAgingThresholdSnapshot,
  projectExtractAging,
} from "./extract-aging-projection";
import {
  ExtractStagnationQuery,
  type ExtractStagnationSignalRow,
} from "./extract-stagnation-query";
import { newRowId, nowIso } from "./ids";
import type { Repositories } from "./index";
import { isQueueActionableStatus } from "./queue-repository";
import type { TransactionClient } from "./types";
import { type UndoResult, UndoService } from "./undo-service";

export type {
  ExtractAgeBand,
  ExtractAgingProjection,
  ExtractAgingThresholdSnapshot,
} from "./extract-aging-projection";

export const EXTRACT_AGING_POLICY_STATE_KEY = "dailyWork.extractAgingPolicy.v1";
export const EXTRACT_AGING_SWEEP_LIMIT = 50;
const RETAIN_DAYS = 31;

export type ExtractAgingReceiptStatus = "actionable" | "undone";
export type ExtractAgingApplySkipReason =
  | "not-selected"
  | "not-found"
  | "not-eligible"
  | "not-due"
  | "terminal-fate"
  | "has-children"
  | "synthesis-referenced"
  | "atomic-statement";

export interface ExtractAgingCandidate {
  readonly id: string;
  readonly title: string;
  readonly stage: string;
  readonly status: string;
  readonly priority: number;
  readonly dueAt: string | null;
  readonly age: ExtractAgingProjection;
  readonly reasons: readonly StagnationReason[];
  readonly suggestion: StagnationSuggestion;
}

export interface ExtractAgingPreview {
  readonly asOf: IsoTimestamp;
  readonly policy: AppSettings["extractAgingPolicy"];
  readonly thresholds: ExtractAgingThresholdSnapshot;
  readonly candidates: readonly ExtractAgingCandidate[];
  readonly candidateCount: number;
  readonly remainingCandidateCount: number;
  readonly receipts: readonly ExtractAgingReceipt[];
}

export interface ExtractAgingSkippedCandidate {
  readonly id: string;
  readonly reason: ExtractAgingApplySkipReason;
}

export interface ExtractAgingReceipt {
  readonly batchId: string;
  readonly localDay: string;
  readonly status: ExtractAgingReceiptStatus;
  readonly policy: "suggest" | "automatic";
  readonly demoted: number;
  readonly skipped: number;
  readonly remainingCandidateCount: number;
  readonly thresholds: ExtractAgingThresholdSnapshot;
  readonly createdAt: IsoTimestamp;
  readonly undoneAt?: IsoTimestamp;
}

export interface ExtractAgingApplyResult {
  readonly batchId: string;
  readonly demoted: number;
  readonly skipped: readonly ExtractAgingSkippedCandidate[];
  readonly remainingCandidateCount: number;
  readonly receipt: ExtractAgingReceipt | null;
}

export interface ExtractAgingMaterializeResult {
  readonly localDay: string;
  readonly evaluated: boolean;
  readonly applied: boolean;
  readonly receipt: ExtractAgingReceipt | null;
}

export interface ExtractAgingUndoResult {
  readonly receipt: ExtractAgingReceipt | null;
  readonly undo: UndoResult;
}

interface ExtractAgingDayState {
  readonly localDay: string;
  readonly evaluatedAt: IsoTimestamp;
  readonly policy: "automatic";
  readonly batchId?: string;
}

interface ExtractAgingPolicyState {
  readonly version: 1;
  readonly automaticDays: Record<string, ExtractAgingDayState>;
  readonly receiptsByBatchId: Record<string, ExtractAgingReceipt>;
  readonly batchIdsByLocalDay: Record<string, readonly string[]>;
}

interface ApplyOptions {
  readonly asOf?: IsoTimestamp;
  readonly ids?: readonly string[];
  readonly policy?: "suggest" | "automatic";
}

export class ExtractAgingPolicyService {
  private readonly elements: ElementRepository;
  private readonly query: ExtractStagnationQuery;
  private readonly undo: UndoService;

  constructor(
    private readonly db: InterleaveDatabase,
    private readonly repos: Repositories,
    private readonly clock: () => IsoTimestamp = nowIso,
  ) {
    this.elements = new ElementRepository(db);
    this.query = new ExtractStagnationQuery(db);
    this.undo = new UndoService(db);
  }

  preview(options: { asOf?: IsoTimestamp; limit?: number } = {}): ExtractAgingPreview {
    const settings = this.repos.settings.getAppSettings();
    const asOf = options.asOf ?? this.clock();
    const thresholds = thresholdsFromSettings(settings, options.limit);
    const allCandidates =
      settings.extractAgingPolicy === "off"
        ? []
        : this.eligibleCandidates(asOf, settings, thresholds);
    const candidates = allCandidates.slice(0, thresholds.sweepLimit);
    return {
      asOf,
      policy: settings.extractAgingPolicy,
      thresholds,
      candidates,
      candidateCount: allCandidates.length,
      remainingCandidateCount: Math.max(0, allCandidates.length - candidates.length),
      receipts: this.receiptsForDay(localDayOf(asOf)),
    };
  }

  applyPreview(options: ApplyOptions = {}): ExtractAgingApplyResult {
    const settings = this.repos.settings.getAppSettings();
    if (settings.extractAgingPolicy === "off") {
      return emptyApplyResult(newRowId());
    }
    const asOf = options.asOf ?? this.clock();
    const thresholds = thresholdsFromSettings(settings);
    const allCandidates = this.eligibleCandidates(asOf, settings, thresholds);
    const candidateIds =
      options.ids ?? allCandidates.slice(0, thresholds.sweepLimit).map((candidate) => candidate.id);
    const selectedCandidateIds = new Set(candidateIds);
    return this.applyIds(candidateIds, {
      asOf,
      thresholds,
      policy: options.policy ?? "suggest",
      eligibleCandidates: allCandidates,
      remainingCandidateCount: Math.max(
        0,
        allCandidates.length -
          allCandidates.filter((candidate) => selectedCandidateIds.has(candidate.id)).length,
      ),
    });
  }

  materializeToday(): ExtractAgingMaterializeResult {
    const now = this.clock();
    const localDay = localDayOf(now);
    const existing = this.state().automaticDays[localDay];
    if (existing) {
      const receipt = existing.batchId ? this.state().receiptsByBatchId[existing.batchId] : null;
      return { localDay, evaluated: true, applied: Boolean(receipt), receipt: receipt ?? null };
    }

    const settings = this.repos.settings.getAppSettings();
    if (settings.extractAgingPolicy !== "automatic") {
      return { localDay, evaluated: false, applied: false, receipt: null };
    }

    const thresholds = thresholdsFromSettings(settings);
    const allCandidates = this.eligibleCandidates(now, settings, thresholds);
    const candidates = allCandidates.slice(0, thresholds.sweepLimit);
    const result = this.applyIds(
      candidates.map((c) => c.id),
      {
        asOf: now,
        thresholds,
        policy: "automatic",
        eligibleCandidates: allCandidates,
        remainingCandidateCount: Math.max(0, allCandidates.length - candidates.length),
        automaticLocalDay: localDay,
      },
    );
    return {
      localDay,
      evaluated: true,
      applied: result.demoted > 0,
      receipt: result.receipt,
    };
  }

  receiptsForToday(): readonly ExtractAgingReceipt[] {
    return this.receiptsForDay(localDayOf(this.clock()));
  }

  receiptsFor(asOf: IsoTimestamp): readonly ExtractAgingReceipt[] {
    return this.receiptsForDay(localDayOf(asOf));
  }

  undoReceipt(batchId: string): ExtractAgingUndoResult {
    const state = this.state();
    const receipt = state.receiptsByBatchId[batchId] ?? null;
    if (!receipt) {
      return { receipt: null, undo: undoFailure("Receipt not found") };
    }
    if (receipt.status === "undone") {
      return { receipt, undo: undoFailure("Receipt already undone") };
    }

    const now = this.clock();
    const undoneReceipt: ExtractAgingReceipt = { ...receipt, status: "undone", undoneAt: now };
    const undo = this.undo.undoBatch(batchId, {
      requireUpdateOriginKind: "extractAgingPolicy",
      requireCurrentReferenceFateMatch: true,
      restoredPayloadExtras: {
        receiptRestore: true,
        restoredBatchId: batchId,
        extractAgingOrigin: {
          kind: "extractAgingPolicy",
          restored: true,
          policy: receipt.policy,
          localDay: receipt.localDay,
        },
      },
      afterUndo: (tx) => {
        this.writeStateWithin(tx, {
          ...state,
          receiptsByBatchId: {
            ...state.receiptsByBatchId,
            [batchId]: undoneReceipt,
          },
        });
      },
    });
    return undo.undone ? { receipt: undoneReceipt, undo } : { receipt, undo };
  }

  private applyIds(
    ids: readonly string[],
    options: {
      readonly asOf: IsoTimestamp;
      readonly thresholds: ExtractAgingThresholdSnapshot;
      readonly policy: "suggest" | "automatic";
      readonly eligibleCandidates?: readonly ExtractAgingCandidate[];
      readonly remainingCandidateCount: number;
      readonly automaticLocalDay?: string;
    },
  ): ExtractAgingApplyResult {
    const batchId = newRowId();
    if (ids.length === 0) {
      if (options.automaticLocalDay) {
        this.markAutomaticDay(options.automaticLocalDay, options.asOf);
      }
      return emptyApplyResult(batchId);
    }

    const selected = new Set(ids);
    const settings = this.repos.settings.getAppSettings();
    const eligible = new Map(
      (
        options.eligibleCandidates ??
        this.eligibleCandidates(options.asOf, settings, options.thresholds)
      )
        .filter((candidate) => selected.has(candidate.id))
        .map((candidate) => [candidate.id, candidate]),
    );

    const result = this.db.transaction((tx) => {
      const skipped: ExtractAgingSkippedCandidate[] = [];
      let demoted = 0;
      for (const id of ids) {
        const reason = this.ineligibilityReasonWithin(tx, id as ElementId, options.asOf, eligible);
        if (reason) {
          skipped.push({ id, reason });
          continue;
        }
        this.elements.updateWithin(
          tx,
          id as ElementId,
          {
            status: "done",
            dueAt: null,
            parkedAt: null,
            extractFate: "reference",
          },
          {
            batchId,
            extras: {
              extractAgingOrigin: {
                kind: "extractAgingPolicy",
                policy: options.policy,
                localDay: localDayOf(options.asOf),
                thresholds: options.thresholds,
              },
            },
          },
        );
        demoted += 1;
      }

      const receipt =
        demoted > 0
          ? ({
              batchId,
              localDay: localDayOf(options.asOf),
              status: "actionable",
              policy: options.policy,
              demoted,
              skipped: skipped.length,
              remainingCandidateCount: options.remainingCandidateCount,
              thresholds: options.thresholds,
              createdAt: options.asOf,
            } satisfies ExtractAgingReceipt)
          : null;
      const nextState = this.withReceipt(
        stateWithAutomaticDay(
          this.state(),
          receipt?.batchId ? { ...options, batchId: receipt.batchId } : options,
        ),
        receipt,
      );
      this.writeStateWithin(tx, nextState);
      return { skipped, receipt };
    });

    return {
      batchId,
      demoted: result.receipt?.demoted ?? 0,
      skipped: result.skipped,
      remainingCandidateCount: options.remainingCandidateCount,
      receipt: result.receipt,
    };
  }

  private eligibleCandidates(
    asOf: IsoTimestamp,
    settings: AppSettings,
    thresholds: ExtractAgingThresholdSnapshot,
  ): readonly ExtractAgingCandidate[] {
    const rows = this.query.listSignalRows(asOf, {
      postponeThreshold: settings.extractAgingReturnThreshold,
      staleDays: settings.extractAgingAgeDays,
    });
    return rows
      .filter((row) => row.verdict.stagnant)
      .filter((row) => isEligibleSignalRow(row, asOf))
      .map((row) => candidateFromSignalRow(row, thresholds))
      .sort((a, b) => {
        if (a.age.postponeCount !== b.age.postponeCount) {
          return b.age.postponeCount - a.age.postponeCount;
        }
        if (a.age.daysSinceProgress !== b.age.daysSinceProgress) {
          return b.age.daysSinceProgress - a.age.daysSinceProgress;
        }
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
  }

  private ineligibilityReasonWithin(
    tx: TransactionClient,
    id: ElementId,
    asOf: IsoTimestamp,
    eligible: ReadonlyMap<string, ExtractAgingCandidate>,
  ): ExtractAgingApplySkipReason | null {
    const row = tx
      .select({
        id: elements.id,
        type: elements.type,
        status: elements.status,
        stage: elements.stage,
        dueAt: elements.dueAt,
        extractFate: elements.extractFate,
        deletedAt: elements.deletedAt,
      })
      .from(elements)
      .where(eq(elements.id, id))
      .get();
    if (!row || row.deletedAt !== null || row.type !== "extract") return "not-found";
    if (row.extractFate !== null) return "terminal-fate";
    if (row.stage === "atomic_statement") return "atomic-statement";
    if (!isQueueActionableStatus(row.status as ElementStatus)) return "not-eligible";
    if (!row.dueAt || Date.parse(row.dueAt) > Date.parse(asOf)) return "not-due";
    if (this.hasLiveChildrenWithin(tx, id)) return "has-children";
    if (this.hasLiveSynthesisReferenceWithin(tx, id)) return "synthesis-referenced";
    if (!eligible.has(id)) return "not-eligible";
    return null;
  }

  private hasLiveChildrenWithin(tx: TransactionClient, id: ElementId): boolean {
    const row = tx
      .select({ id: elements.id })
      .from(elements)
      .where(and(eq(elements.parentId, id), isNull(elements.deletedAt)))
      .limit(1)
      .get();
    return Boolean(row);
  }

  private hasLiveSynthesisReferenceWithin(tx: TransactionClient, id: ElementId): boolean {
    const row = tx
      .select({ id: elementRelations.id })
      .from(elementRelations)
      .innerJoin(elements, eq(elementRelations.fromElementId, elements.id))
      .where(
        and(
          eq(elementRelations.toElementId, id),
          eq(elementRelations.relationType, "references"),
          eq(elements.type, "synthesis_note"),
          isNull(elements.deletedAt),
        ),
      )
      .limit(1)
      .get();
    return Boolean(row);
  }

  private receiptsForDay(localDay: string): readonly ExtractAgingReceipt[] {
    const state = this.state();
    return (state.batchIdsByLocalDay[localDay] ?? [])
      .map((batchId) => state.receiptsByBatchId[batchId])
      .filter((receipt): receipt is ExtractAgingReceipt => Boolean(receipt));
  }

  private markAutomaticDay(localDay: string, evaluatedAt: IsoTimestamp): void {
    this.repos.settings.setMany({
      [EXTRACT_AGING_POLICY_STATE_KEY]: stateWithAutomaticDay(this.state(), {
        asOf: evaluatedAt,
        policy: "automatic",
        thresholds: { returnThreshold: 0, ageDays: 0, sweepLimit: EXTRACT_AGING_SWEEP_LIMIT },
        remainingCandidateCount: 0,
        automaticLocalDay: localDay,
      }),
    });
  }

  private withReceipt(
    state: ExtractAgingPolicyState,
    receipt: ExtractAgingReceipt | null,
  ): ExtractAgingPolicyState {
    if (!receipt) return pruneState(state);
    const batchIds = state.batchIdsByLocalDay[receipt.localDay] ?? [];
    return pruneState({
      ...state,
      receiptsByBatchId: { ...state.receiptsByBatchId, [receipt.batchId]: receipt },
      batchIdsByLocalDay: {
        ...state.batchIdsByLocalDay,
        [receipt.localDay]: [...new Set([...batchIds, receipt.batchId])],
      },
    });
  }

  private writeStateWithin(tx: TransactionClient, state: ExtractAgingPolicyState): void {
    this.repos.settings.setManyWithin(tx, { [EXTRACT_AGING_POLICY_STATE_KEY]: pruneState(state) });
  }

  private state(): ExtractAgingPolicyState {
    const raw = this.repos.settings.get<ExtractAgingPolicyState>(EXTRACT_AGING_POLICY_STATE_KEY);
    if (
      !raw ||
      typeof raw !== "object" ||
      raw.version !== 1 ||
      !isRecord(raw.automaticDays) ||
      !isRecord(raw.receiptsByBatchId) ||
      !isRecord(raw.batchIdsByLocalDay)
    ) {
      return { version: 1, automaticDays: {}, receiptsByBatchId: {}, batchIdsByLocalDay: {} };
    }
    return raw;
  }
}

function thresholdsFromSettings(
  settings: AppSettings,
  requestedLimit?: number,
): ExtractAgingThresholdSnapshot {
  const limit =
    requestedLimit === undefined
      ? EXTRACT_AGING_SWEEP_LIMIT
      : Math.min(EXTRACT_AGING_SWEEP_LIMIT, Math.max(1, Math.floor(requestedLimit)));
  return {
    returnThreshold: settings.extractAgingReturnThreshold,
    ageDays: settings.extractAgingAgeDays,
    sweepLimit: limit,
  };
}

function candidateFromSignalRow(
  row: ExtractStagnationSignalRow,
  thresholds: ExtractAgingThresholdSnapshot,
): ExtractAgingCandidate {
  return {
    id: row.extract.id,
    title: row.extract.title,
    stage: row.extract.stage,
    status: row.extract.status,
    priority: row.extract.priority,
    dueAt: row.extract.dueAt,
    age: projectExtractAging(row.verdict.daysSinceProgress, row.signals.postponeCount, thresholds),
    reasons: row.verdict.reasons,
    suggestion: row.verdict.suggestion,
  };
}

function isEligibleSignalRow(row: ExtractStagnationSignalRow, asOf: IsoTimestamp): boolean {
  if (row.extract.extractFate !== null) return false;
  if (row.extract.stage === "atomic_statement") return false;
  if (!isQueueActionableStatus(row.extract.status as ElementStatus)) return false;
  if (!row.extract.dueAt) return false;
  const due = Date.parse(row.extract.dueAt);
  return Number.isFinite(due) && due <= Date.parse(asOf);
}

function stateWithAutomaticDay(
  state: ExtractAgingPolicyState,
  options: {
    readonly asOf: IsoTimestamp;
    readonly policy: "suggest" | "automatic";
    readonly thresholds: ExtractAgingThresholdSnapshot;
    readonly remainingCandidateCount: number;
    readonly automaticLocalDay?: string;
    readonly batchId?: string;
  },
): ExtractAgingPolicyState {
  if (!options.automaticLocalDay) return state;
  return pruneState({
    ...state,
    automaticDays: {
      ...state.automaticDays,
      [options.automaticLocalDay]: {
        localDay: options.automaticLocalDay,
        evaluatedAt: options.asOf,
        policy: "automatic",
        ...(options.batchId ? { batchId: options.batchId } : {}),
      },
    },
  });
}

function pruneState(state: ExtractAgingPolicyState): ExtractAgingPolicyState {
  const days = Object.keys(state.automaticDays).sort();
  const keepDays = new Set(days.slice(Math.max(0, days.length - RETAIN_DAYS)));
  const automaticDays: Record<string, ExtractAgingDayState> = {};
  for (const day of keepDays) {
    const entry = state.automaticDays[day];
    if (entry) automaticDays[day] = entry;
  }
  const batchIdsByLocalDay: Record<string, readonly string[]> = {};
  const receiptsByBatchId: Record<string, ExtractAgingReceipt> = {};
  const receiptDays = Object.keys(state.batchIdsByLocalDay).sort();
  const keepReceiptDays = new Set(receiptDays.slice(Math.max(0, receiptDays.length - RETAIN_DAYS)));
  for (const day of keepReceiptDays) {
    const ids = state.batchIdsByLocalDay[day] ?? [];
    batchIdsByLocalDay[day] = ids;
    for (const id of ids) {
      const receipt = state.receiptsByBatchId[id];
      if (receipt) receiptsByBatchId[id] = receipt;
    }
  }
  return { version: 1, automaticDays, receiptsByBatchId, batchIdsByLocalDay };
}

function emptyApplyResult(batchId: string): ExtractAgingApplyResult {
  return { batchId, demoted: 0, skipped: [], remainingCandidateCount: 0, receipt: null };
}

function undoFailure(reason: string): UndoResult {
  return { undone: false, opType: null, elementId: null, label: "", reason, count: 0 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function localDayOf(iso: IsoTimestamp): string {
  const date = new Date(iso);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
