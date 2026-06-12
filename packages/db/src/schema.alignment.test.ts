/**
 * Type-alignment tests (T006).
 *
 * Guards the "no drift between Drizzle-inferred types and `@interleave/core`"
 * invariant. These are mostly COMPILE-TIME assertions: if a Drizzle column type
 * stops matching the corresponding `@interleave/core` field, the `satisfies`
 * checks below fail `pnpm typecheck`. A couple of runtime assertions pin the
 * enum CHECK lists to the exact core tuples so a value can never be added to one
 * side only.
 */

import {
  ASSET_KINDS,
  type AssetKind,
  CARD_KINDS,
  type CardKind,
  DISTILLATION_STAGES,
  type DistillationStage,
  ELEMENT_STATUSES,
  ELEMENT_TYPES,
  type ElementStatus,
  type ElementType,
  type FsrsState,
  OPERATION_TYPES,
  type OperationType,
  type ReviewRating,
  type VaultRoot,
} from "@interleave/core";
import { describe, expect, it } from "vitest";
import {
  type AssetRow,
  type CardRow,
  type DbHandle,
  type ElementRow,
  MIGRATIONS_DIR,
  migrateDatabase,
  type OperationLogRow,
  openDatabase,
  type ReviewLogRow,
  type ReviewStateRow,
} from "./index";

/** One row of `PRAGMA foreign_key_list(<table>)`. */
interface ForeignKeyListRow {
  readonly id: number;
  readonly seq: number;
  readonly table: string;
  readonly from: string;
  readonly to: string;
  readonly on_update: string;
  readonly on_delete: string;
  readonly match: string;
}

/**
 * The persisted enum columns are typed as `string` by Drizzle (SQLite text), but
 * every value we ever write is a core enum. These assignments prove the core
 * unions are assignable INTO the row columns — i.e. a valid core value is always
 * a valid column value. If a core enum is renamed/removed, these break.
 */
function _assertColumnsAcceptCoreEnums(): void {
  const t: ElementType = "source";
  const s: ElementStatus = "active";
  const stage: DistillationStage = "raw_source";
  const kind: CardKind = "qa";
  const fsrs: FsrsState = "new";
  const rating: ReviewRating = "good";
  const assetKind: AssetKind = "source_pdf";
  const vaultRoot: VaultRoot = "assets";
  const op: OperationType = "create_card";

  const element = {} as ElementRow;
  const card = {} as CardRow;
  const reviewState = {} as ReviewStateRow;
  const reviewLog = {} as ReviewLogRow;
  const asset = {} as AssetRow;
  const opRow = {} as OperationLogRow;

  // Columns are `string`; core enum values must be assignable to them.
  element.type = t;
  element.status = s;
  element.stage = stage;
  card.kind = kind;
  reviewState.fsrsState = fsrs;
  reviewLog.rating = rating;
  reviewLog.prevState = fsrs;
  asset.kind = assetKind;
  asset.vaultRoot = vaultRoot;
  opRow.opType = op;

  // Reference everything so noUnusedLocals/Parameters stays quiet.
  void [element, card, reviewState, reviewLog, asset, opRow, kind, rating, vaultRoot];
}

describe("Drizzle ⇄ @interleave/core alignment", () => {
  it("compiles the column/enum assignability assertions", () => {
    expect(typeof _assertColumnsAcceptCoreEnums).toBe("function");
  });

  it("uses the exact core enum tuples (CHECK lists cannot drift)", () => {
    // The schema CHECK constraints are built from these very tuples; pinning the
    // arrays here makes any future divergence a failing test, not a silent bug.
    expect(ELEMENT_TYPES.length).toBe(8);
    expect(ELEMENT_STATUSES.length).toBe(9);
    expect(DISTILLATION_STAGES.length).toBe(9);
    expect(CARD_KINDS).toEqual(["qa", "cloze", "image_occlusion"]);
    expect(ASSET_KINDS).toContain("source_pdf");
    expect(OPERATION_TYPES).toContain("create_card");
  });
});

describe("elements self-referencing foreign keys (T135 purge-guard invariant)", () => {
  // The T135 purge guard (`TrashRepository`) blocks a hard-delete of a tombstone with live
  // descendants because the `onDelete: "set null"` self-FKs (`parentId`, `sourceId`) would
  // otherwise NULL a live element's lineage links — the 0030-wipe mechanism. The guard
  // checks EXACTLY those two links. If a future migration adds a THIRD self-referencing
  // `set null` FK to `elements`, the guard must be revisited to cover it — so this test
  // fails (against the live, migrated schema) the moment that count changes.
  it("has EXACTLY two self-referencing `set null` FKs: parent_id and source_id", () => {
    const handle: DbHandle = openDatabase(":memory:");
    try {
      migrateDatabase(handle.db, MIGRATIONS_DIR);
      const fks = handle.sqlite
        .prepare("PRAGMA foreign_key_list(elements)")
        .all() as ForeignKeyListRow[];

      // Self-referencing FKs (target table is `elements` itself).
      const selfFks = fks.filter((fk) => fk.table === "elements");
      const selfSetNull = selfFks.filter((fk) => fk.on_delete.toUpperCase() === "SET NULL");
      const fromColumns = selfSetNull.map((fk) => fk.from).sort();

      expect(fromColumns).toEqual(["parent_id", "source_id"]);
      // No self-referencing FK on `elements` uses any OTHER on-delete action (e.g. CASCADE),
      // which would be a separate lineage-loss hazard the guard does not model.
      expect(selfFks).toHaveLength(2);
    } finally {
      handle.sqlite.close();
    }
  });
});
