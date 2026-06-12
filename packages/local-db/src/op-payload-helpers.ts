/**
 * Shared `operation_log` payload readers (T135 / A5) — the ONE place the
 * `soft_delete_element` payload's preimage-presence invariant lives.
 *
 * The lineage-delete path records a node's prior status and (when it cleared a
 * schedule) the cleared `elements.due_at` / `review_states.due_at` PRE-IMAGES in the
 * `soft_delete_element` op payload, so every restore path (`UndoService.invert`,
 * `TrashRepository.restoreOne`/`restoreBatch`/`restoreAncestorChain`) can
 * re-establish the EXACT pre-delete schedule. That presence logic is subtle — a
 * `null` value IS a real preimage (the field was un-due at delete time), so presence
 * is keyed on `Object.hasOwn`, not truthiness — so it must not be duplicated. Both
 * the trash repository and the undo service import from here.
 */

import type { ElementStatus, IsoTimestamp } from "@interleave/core";
import type { RestoreSchedule } from "./element-repository";

/** Safely parse an op payload JSON string into a record (empty on malformed). */
export function parsePayload(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
  } catch {
    // Malformed payload — fall through to the empty record.
  }
  return {};
}

/** The prior status from a `soft_delete_element` payload's `prev.status`, or `active`. */
export function originStatusFromPayload(payload: Record<string, unknown>): ElementStatus {
  const prev = payload.prev as { status?: unknown } | undefined;
  const prior = prev?.status;
  if (typeof prior === "string" && prior !== "deleted") return prior as ElementStatus;
  return "active";
}

/**
 * The schedule PRE-IMAGE from a `soft_delete_element` payload, or `null` when this op
 * cleared no schedule (a plain legacy soft-delete). A null value IS a real preimage
 * (the field was un-due at delete time), so presence is keyed on `Object.hasOwn`.
 */
export function restoreScheduleFromPayload(
  payload: Record<string, unknown>,
): RestoreSchedule | null {
  if (!Object.hasOwn(payload, "prevDueAt")) return null;
  const dueAt = (payload.prevDueAt ?? null) as IsoTimestamp | null;
  if (Object.hasOwn(payload, "prevReviewDueAt")) {
    return { dueAt, reviewDueAt: (payload.prevReviewDueAt ?? null) as IsoTimestamp | null };
  }
  return { dueAt };
}
