/**
 * AI-assisted distillation layer (T093): `ai_suggestions`.
 *
 * The on-device AI runner (a DB-free `utilityProcess` worker running a local model OR
 * the user's own-key HTTP call) produces a DRAFT suggestion for a selected source span
 * and posts it back to MAIN, which persists it HERE as an INERT, REVIEWABLE row — it is
 * NEVER a scheduled element, NEVER in any queue, and NEVER auto-applied. A card-shaped
 * suggestion becomes a real card only when the user EXPLICITLY approves it (which mints
 * a parked, un-due `card_draft` via the draft-only `CardService` seam).
 *
 * Like a `jobs` row or an `ocr_pages` row, an `ai_suggestions` row is a transient
 * draft/infra artifact — it appends NO `operation_log` entry (mirroring the
 * `AssetRepository` "asset rows have no dedicated operation" note). Approving a card
 * appends the existing `create_element`/`create_card` ops through the normal card path.
 *
 * ## Grounding (T094) — model output stored SEPARATELY from the source quote
 *
 * Every suggestion stores WHICH source span produced it: `source_element_id` +
 * `source_block_ids` (JSON) + `start_offset`/`end_offset` + the verbatim
 * `selected_text`. The model's generated text lives in `suggestion_text`, a DIFFERENT
 * column from `selected_text` (the source quote) — so we always know "the model said X
 * _about_ this exact source text", and a card minted from a suggestion inherits the
 * grounding as a real `source_locations` row.
 *
 * The `owning_element_id` (the extract/source the action ran on) cascades on delete, so
 * a soft-deleted owner's drafts are cleaned up with it.
 */

import { AI_ACTION_TYPES, AI_SUGGESTION_KINDS, AI_SUGGESTION_STATUSES } from "@interleave/core";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { inList } from "./_shared";
import { elements } from "./elements";

export const aiSuggestions = sqliteTable(
  "ai_suggestions",
  {
    /** Stable id (domain-generated). */
    id: text("id").primaryKey(),
    /** The extract/source element the AI action ran ON (the action's owner). */
    owningElementId: text("owning_element_id")
      .notNull()
      .references(() => elements.id, { onDelete: "cascade" }),
    /** Which formulation action produced this (CHECK against the core action tuple). */
    action: text("action").notNull(),
    /** The suggestion shape (text | card_qa | card_cloze | prerequisite_list). */
    kind: text("kind").notNull(),
    /** Which provider produced it (local | anthropic | openai | managed_proxy). */
    providerKind: text("provider_kind").notNull(),
    /** The MODEL's generated text — stored SEPARATELY from the source quote below. */
    suggestionText: text("suggestion_text").notNull().default(""),
    /**
     * Structured card drafts for the card-shaped actions, JSON-encoded
     * (`DraftCard[]`); `null` for the text/prerequisite_list shapes. The card-quality
     * report for an approved draft is re-evaluated on read, not stored here.
     */
    cards: text("cards"),
    // --- grounding (T094): which source span produced this suggestion ---
    /** The source element the selected span lives in (the jump-to-source target). */
    sourceElementId: text("source_element_id").references(() => elements.id, {
      onDelete: "set null",
    }),
    /** The source block ids the span covers, JSON-encoded (`string[]`). */
    sourceBlockIds: text("source_block_ids"),
    /** Start char offset of the span within the first block, when available. */
    startOffset: integer("start_offset"),
    /** End char offset of the span within the last block, when available. */
    endOffset: integer("end_offset"),
    /** The VERBATIM selected source quote — stored separately from `suggestion_text`. */
    selectedText: text("selected_text").notNull().default(""),
    /** Lifecycle: `draft` (un-actioned) | `approved` (a card was minted) | `dismissed`. */
    status: text("status").notNull().default("draft"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("ai_suggestions_owning_idx").on(table.owningElementId),
    index("ai_suggestions_status_idx").on(table.status),
    check("ai_suggestions_action_check", inList(table.action, AI_ACTION_TYPES)),
    check("ai_suggestions_kind_check", inList(table.kind, AI_SUGGESTION_KINDS)),
    check("ai_suggestions_status_value_check", inList(table.status, AI_SUGGESTION_STATUSES)),
  ],
);

export type AiSuggestionRow = typeof aiSuggestions.$inferSelect;
export type NewAiSuggestionRow = typeof aiSuggestions.$inferInsert;
