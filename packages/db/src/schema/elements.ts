/**
 * The `elements` table — the universal primitive (T006).
 *
 * Every source, topic, extract, card, task, concept, media fragment, and
 * synthesis note IS a row here. This mirrors {@link Element} from
 * `@interleave/core`: `type`/`status`/`stage` are the canonical enum strings,
 * `priority` is the normalized numeric store, and `deletedAt` is the soft-delete
 * marker (user data is never destroyed). Lineage is carried by `parentId`
 * (origin element) and `sourceId` (denormalized lineage root) — both
 * self-referencing foreign keys so a card can trace back to its source.
 *
 * IDs are stable UUID/ULID-style strings generated in the domain/service layer,
 * NEVER by SQLite autoincrement (lineage + operation-log replay depend on this).
 * Enum membership is enforced with CHECK constraints derived from the
 * `@interleave/core` tuples so the DB and the domain vocabulary cannot drift.
 */

import {
  DISTILLATION_STAGES,
  ELEMENT_STATUSES,
  ELEMENT_TYPES,
  EXTRACT_FATES,
} from "@interleave/core";
import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { inList } from "./_shared";

export const elements = sqliteTable(
  "elements",
  {
    /** Stable UUID/ULID-style id, generated in the domain/service layer. */
    id: text("id").primaryKey(),
    /** Element type — one of the eight canonical `ElementType` values. */
    type: text("type").notNull(),
    /** Lifecycle status — one of the canonical `ElementStatus` values. */
    status: text("status").notNull(),
    /** Distillation stage — one of the canonical `DistillationStage` values. */
    stage: text("stage").notNull(),
    /** Normalized numeric priority `0.0`–`1.0` (higher = more important). */
    priority: real("priority").notNull(),
    /** Attention interval scaling factor `0.5`–`4.0` (1.0 = normal cadence). */
    attentionIntervalMultiplier: real("attention_interval_multiplier").notNull().default(1.0),
    /** ISO-8601 UTC timestamp for when this element next wants attention. */
    dueAt: text("due_at"),
    /** ISO-8601 UTC timestamp for when the user deliberately parked the element. */
    parkedAt: text("parked_at"),
    /** ISO-8601 UTC timestamp for when a deliberate topic rest returns. */
    fallowUntil: text("fallow_until"),
    /** Optional user-entered reason for deliberate topic rest. */
    fallowReason: text("fallow_reason"),
    /** Latest active fallow operation batch id, used for manual unfallow restoration. */
    fallowBatchId: text("fallow_batch_id"),
    /** Honorable terminal fate for extract rows that exit without a card. */
    extractFate: text("extract_fate"),
    /**
     * Content-staleness flag (T123): `true` when this derived element's body may no
     * longer match its source after a source block edit. Set/cleared as a self-healing
     * projection of `element_reverify_provenance` (true iff ≥1 provenance row). This is
     * CONTENT staleness — distinct from T090 CALENDAR staleness (`cards.valid_until`/
     * `review_by`). Resolution (confirm/rebase/detach) is T124. Type-coupled: only
     * extract/card/media_fragment elements may carry it.
     */
    needsReverify: integer("needs_reverify", { mode: "boolean" }).notNull().default(false),
    /** ISO-8601 UTC timestamp for when this element first became content-stale (T123). */
    staleSince: text("stale_since"),
    title: text("title").notNull(),
    /** Origin element this was derived from; `null` for top-level sources. */
    parentId: text("parent_id").references((): AnySQLiteColumn => elements.id, {
      onDelete: "set null",
    }),
    /** Denormalized lineage root (the owning `source` element). */
    sourceId: text("source_id").references((): AnySQLiteColumn => elements.id, {
      onDelete: "set null",
    }),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    /** Soft-delete marker; non-null means "in the trash", recoverable. */
    deletedAt: text("deleted_at"),
  },
  (table) => [
    check("elements_type_check", inList(table.type, ELEMENT_TYPES)),
    check("elements_status_check", inList(table.status, ELEMENT_STATUSES)),
    check("elements_stage_check", inList(table.stage, DISTILLATION_STAGES)),
    check(
      "elements_extract_fate_check",
      sql`${table.extractFate} IS NULL OR (${table.type} = 'extract' AND ${inList(table.extractFate, EXTRACT_FATES)})`,
    ),
    // T123: content-staleness may only flag derived artifacts (extracts/statements are
    // extract rows; cards; media fragments). Sources/topics/tasks/etc. are never the
    // DERIVED side of a source-block edit, so they can never be content-stale.
    check(
      "elements_needs_reverify_check",
      sql`${table.needsReverify} = 0 OR ${table.type} IN ('extract', 'card', 'media_fragment')`,
    ),
    check("elements_priority_range_check", sql`${table.priority} >= 0 AND ${table.priority} <= 1`),
    check(
      "elements_attention_interval_multiplier_range_check",
      sql`${table.attentionIntervalMultiplier} >= 0.5 AND ${table.attentionIntervalMultiplier} <= 4.0`,
    ),
    index("elements_parent_idx").on(table.parentId),
    index("elements_source_idx").on(table.sourceId),
    index("elements_type_status_idx").on(table.type, table.status),
    index("elements_due_idx").on(table.dueAt),
    // T100 (migration 0027): the analytics "new X in window" scans filter
    // `type = ? AND created_at BETWEEN ? AND ?` (AnalyticsService.countCreatedInWindow);
    // EXPLAIN QUERY PLAN at scale showed a full `SCAN elements` without this composite
    // and a clean `SEARCH ... USING INDEX elements_type_created_idx` with it. PROVEN.
    index("elements_type_created_idx").on(table.type, table.createdAt),
    // T100 (migration 0027): the analytics `deletions` count + the trash list both scan
    // `deleted_at` (`WHERE deleted_at IS NOT NULL [AND BETWEEN] ORDER BY deleted_at`).
    // EXPLAIN QUERY PLAN at scale showed a full `SCAN elements` + a TEMP B-TREE for the
    // trash sort without it, both eliminated with `SEARCH ... USING INDEX
    // elements_deleted_at_idx`. PROVEN. (The candidate `elements(type, due_at)` was
    // measured and REJECTED: for the `dueAttentionItems` read — `type NOT IN ('card')
    // AND deleted_at IS NULL AND ... AND due_at <= ? ORDER BY due_at` — the planner
    // keeps `elements_due_idx` (verified via EXPLAIN QUERY PLAN at scale, post-ANALYZE),
    // because a leading `type` column under `NOT IN ('card')` is non-sargable, so a
    // `(type, due_at)` composite cannot seek and would only ever be a redundant cost.)
    index("elements_deleted_at_idx").on(table.deletedAt),
  ],
);

export type ElementRow = typeof elements.$inferSelect;
export type NewElementRow = typeof elements.$inferInsert;
