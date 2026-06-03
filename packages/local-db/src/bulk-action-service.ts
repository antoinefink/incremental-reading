/**
 * BulkActionService (T099) — the thin batch wrappers behind the Maintenance view's
 * cleanup actions.
 *
 * Every cleanup action over a report (dedup, broken-source / sourceless-card trash,
 * bulk low-priority archive) is a BULK mutation: N rows, ONE shared `batchId`, so the
 * general command-level `UndoService.undoLast` reverses the WHOLE sweep in one call
 * (T044). This service mints the `batchId` and routes each id through the EXISTING
 * per-item write paths — it invents NO new op type, NO new status, NO new delete path:
 *
 *  - `bulkSoftDelete(ids)` → `ElementRepository.softDelete(id, { batchId })` per id
 *    (`soft_delete_element` carrying the `batchId` + the status pre-image). Reused by
 *    dedup cleanup, broken-source trash, and `bulkArchive` `trash` mode. Recoverable
 *    via Trash + undo; NEVER a hard delete.
 *  - `bulkArchive(ids, mode)` → one of three EXISTING reversible verbs per id:
 *    `trash` → soft-delete; `dismiss` → `update_element` status `dismissed`; `retire`
 *    → `CardRetirementService.retire` (cards only — a non-card is skipped, the
 *    two-scheduler split: retirement is an FSRS-card attribute). NO `archived` status
 *    is minted.
 *  - `bulkPostpone(ids)` is provided by {@link QueueActionService} (the EXISTING
 *    overload valve); this service delegates to it so the Maintenance surface has one
 *    seam. Cards defer on FSRS (`cardDeferBy`); attention items reschedule on the
 *    attention scheduler — the split is already correct there.
 *
 * Each per-id mutation runs in its own transaction with the correct existing op; a
 * missing / already-deleted id is skipped. Read-only validation (which ids are real,
 * non-keeper duplicates) belongs to the caller (the main `MaintenanceService`
 * re-validates dedup ids against a fresh report before calling `bulkSoftDelete`).
 *
 * Never SQL in the renderer — this is a `packages/local-db` service the main process
 * exposes over the typed `window.appApi.maintenance.*` surface.
 */

import type { Element, ElementId, IsoTimestamp } from "@interleave/core";
import type { InterleaveDatabase } from "@interleave/db";
import { CardRetirementService } from "./card-retirement-service";
import { ElementRepository } from "./element-repository";
import { newRowId, nowIso } from "./ids";
import { QueueActionService } from "./queue-action-service";

/** How a bulk-archive recedes each item — three EXISTING reversible verbs. */
export type BulkArchiveMode = "trash" | "dismiss" | "retire";

/** The result of a bulk soft-delete / archive: the affected count + the shared batch. */
export interface BulkActionResult {
  /** How many ids were mutated (skipping missing / already-deleted / inapplicable). */
  readonly affected: number;
  /** The shared `batchId` (so the renderer can drive a single "Undo"). */
  readonly batchId: string;
  /** The ids that were skipped (missing / deleted / non-card for `retire`). */
  readonly skipped: readonly ElementId[];
}

export class BulkActionService {
  private readonly elements: ElementRepository;
  private readonly queueAction: QueueActionService;
  private readonly retirement: CardRetirementService;

  constructor(db: InterleaveDatabase) {
    this.elements = new ElementRepository(db);
    this.queueAction = new QueueActionService(db);
    this.retirement = new CardRetirementService(db);
  }

  /**
   * Soft-delete MANY live elements as ONE undoable batch. Each appends
   * `soft_delete_element` carrying the shared `batchId` + the status pre-image, so
   * `UndoService.undoLast` restores every row to its prior status in one call. A
   * missing / already-deleted id is skipped (never an error — the report may be
   * slightly stale). Returns the affected count + the shared `batchId`.
   */
  bulkSoftDelete(ids: readonly ElementId[]): BulkActionResult {
    const batchId = newRowId();
    const skipped: ElementId[] = [];
    let affected = 0;
    for (const id of ids) {
      const element = this.elements.findById(id);
      if (!element || element.deletedAt) {
        skipped.push(id);
        continue;
      }
      this.elements.softDelete(id, { batchId });
      affected += 1;
    }
    return { affected, batchId, skipped };
  }

  /**
   * Archive MANY items as ONE undoable batch, routing per id by `mode`:
   *  - `trash`   → soft-delete (`soft_delete_element`, recoverable);
   *  - `dismiss` → `update_element` status `dismissed`;
   *  - `retire`  → `CardRetirementService.retire` (CARDS ONLY — a non-card is skipped).
   *
   * Every per-id op carries the shared `batchId`. `trash`/`dismiss` are reversed as one
   * batch by `undoLast` (each restores its prior status); `retire` is reversed by the
   * explicit un-retire (it is a card-flag attribute, reversible + non-destructive).
   * Skips missing / already-deleted ids (and non-cards for `retire`). No `archived`
   * status is minted — archive is one of these three existing, reversible verbs.
   */
  bulkArchive(ids: readonly ElementId[], mode: BulkArchiveMode): BulkActionResult {
    const batchId = newRowId();
    const skipped: ElementId[] = [];
    let affected = 0;
    for (const id of ids) {
      const element = this.elements.findById(id);
      if (!element || element.deletedAt) {
        skipped.push(id);
        continue;
      }
      if (mode === "trash") {
        this.elements.softDelete(id, { batchId });
        affected += 1;
      } else if (mode === "dismiss") {
        this.elements.update(id, { status: "dismissed" }, { batchId });
        affected += 1;
      } else {
        // retire — cards only (the two-scheduler split: an attention item is never
        // "retired"; that is an FSRS-card attribute). A non-card is skipped clearly.
        if (element.type !== "card") {
          skipped.push(id);
          continue;
        }
        this.retirement.retire(id, { batchId });
        affected += 1;
      }
    }
    return { affected, batchId, skipped };
  }

  /**
   * Postpone MANY items as ONE undoable batch via the EXISTING
   * {@link QueueActionService.bulkPostpone} (the attention scheduler for attention
   * items, the FSRS defer for cards — the split is already correct there). Returns the
   * affected count + the shared `batchId`. Exposed here so the Maintenance surface
   * drives postpone through the same seam as the other bulk actions.
   */
  bulkPostpone(
    ids: readonly ElementId[],
    now: IsoTimestamp = nowIso(),
  ): { readonly elements: Element[]; readonly batchId: string } {
    return this.queueAction.bulkPostpone(ids, now);
  }
}
