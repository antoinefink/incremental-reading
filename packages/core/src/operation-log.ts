/**
 * Operation log (T005, desktop pivot).
 *
 * Every meaningful mutation is **command-shaped** and appended to the
 * `operation_log` table from day one, inside the same transaction as the
 * mutation it records. This is a load-bearing invariant: the append-only,
 * deterministic log is what later makes backup, audit, undo, and cloud sync
 * tractable (sync ships these ops to the server; undo replays/inverts them).
 * We do NOT overbuild sync now — we only keep mutations log-shaped.
 *
 * `packages/local-db` (T008) constructs and appends these entries; this package
 * just defines the vocabulary so the op union is shared by every layer.
 * Framework-agnostic — no Drizzle/better-sqlite3 here.
 */

import type { ElementId, IsoTimestamp, OperationId } from "./ids";

/**
 * The canonical set of command/op types. These strings MUST match
 * `CLAUDE.md` / `domain-model.md` exactly — they are persisted and synced, so a
 * rename is a migration. One op type per meaningful mutation the MVP supports.
 */
export const OPERATION_TYPES = [
  "create_element",
  "update_element",
  "soft_delete_element",
  "restore_element",
  "create_source",
  "update_document",
  "set_read_point",
  "create_extract",
  "create_card",
  "add_review_log",
  "reschedule_element",
  "add_relation",
  "remove_relation",
  "add_tag",
  "remove_tag",
] as const;
export type OperationType = (typeof OPERATION_TYPES)[number];

/**
 * One logged mutation (`operation_log` row). The `payload` carries the
 * command-specific data needed to replay/audit the mutation; it is stored as
 * JSON in SQLite, so it is typed as `unknown` at the boundary and validated by
 * the local-db layer (T008) against the concrete payload for its `opType`.
 *
 *  - `elementId` is the primary element the op concerns (the natural undo/audit
 *    anchor); `null` for the rare op that does not target a single element.
 *  - Entries are append-only and ordered by `createdAt` / insertion id.
 */
export interface OperationLogEntry<TPayload = unknown> {
  readonly id: OperationId;
  readonly opType: OperationType;
  /** Command-specific JSON data; validated per `opType` by `packages/local-db`. */
  readonly payload: TPayload;
  /** The element this op concerns; `null` if it targets no single element. */
  readonly elementId: ElementId | null;
  readonly createdAt: IsoTimestamp;
}

/** Type guard: is `value` one of the canonical operation-type strings? */
export function isOperationType(value: unknown): value is OperationType {
  return typeof value === "string" && (OPERATION_TYPES as readonly string[]).includes(value);
}
