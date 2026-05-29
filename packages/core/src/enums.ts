/**
 * Core domain enums (T005).
 *
 * The string values here are the canonical vocabulary of the whole product and
 * MUST match `docs/domain-model.md` and `CLAUDE.md` exactly — no renames, no
 * casual additions. They are persisted verbatim in SQLite (`elements.type`,
 * `elements.status`, `elements.stage`) and travel through the operation log and
 * the eventual cloud sync, so a rename is a data migration, not a refactor.
 *
 * Each enum is expressed as a `const` tuple (the source of truth for runtime
 * validation/iteration) plus a derived union type (the compile-time vocabulary).
 */

/**
 * The eight core element types. `Element` is the universal primitive — every
 * source, topic, extract, card, task, concept, media fragment, and synthesis
 * note **is** an element of one of these types. Introducing a parallel object
 * model is forbidden (see the most important invariant in `domain-model.md`).
 */
export const ELEMENT_TYPES = [
  "source",
  "topic",
  "extract",
  "card",
  "task",
  "concept",
  "media_fragment",
  "synthesis_note",
] as const;
export type ElementType = (typeof ELEMENT_TYPES)[number];

/**
 * Lifecycle statuses. Status answers *"where in the workflow is this element?"*
 * and is deliberately distinct from {@link DistillationStage} (which answers
 * *"how refined is it?"*). `deleted` is a **soft** delete (recoverable via
 * trash) — user data is never silently destroyed.
 */
export const ELEMENT_STATUSES = [
  "inbox",
  "pending",
  "active",
  "scheduled",
  "done",
  "dismissed",
  "suspended",
  "deleted",
] as const;
export type ElementStatus = (typeof ELEMENT_STATUSES)[number];

/**
 * Distillation stages — *where in the refinery* an element sits, from a raw
 * import to a mature card or higher-order synthesis. This is INDEPENDENT of
 * {@link ElementStatus}: e.g. an element can be `active` (status) while still a
 * `raw_extract` (stage). Keeping the two axes separate is a load-bearing
 * invariant (see "stage vs status" in `domain-model.md`).
 */
export const DISTILLATION_STAGES = [
  "raw_source",
  "rough_topic",
  "raw_extract",
  "clean_extract",
  "atomic_statement",
  "card_draft",
  "active_card",
  "mature_card",
  "synthesis",
] as const;
export type DistillationStage = (typeof DISTILLATION_STAGES)[number];

/**
 * Typed edges between elements (`element_relations.relation_type`). Lineage is
 * sacred and modeled as explicit rows, not implicit nesting: `derived_from`
 * carries the extract→source chain, `sibling_group` keeps cloze/Q&A siblings
 * from interfering in review, `concept_membership` organizes, and `references`
 * records cross-links.
 */
export const RELATION_TYPES = [
  "parent_child",
  "derived_from",
  "sibling_group",
  "concept_membership",
  "references",
] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

/**
 * Active-recall card flavours (`cards.kind`). Only `qa` and `cloze` ship in the
 * MVP; richer media-card kinds arrive in later milestones (M15).
 */
export const CARD_KINDS = ["qa", "cloze"] as const;
export type CardKind = (typeof CARD_KINDS)[number];

/**
 * FSRS card-memory states (`review_states.fsrs_state`). FSRS scheduling applies
 * to cards ONLY — sources/topics/extracts use the separate attention scheduler.
 * Forcing topic/extract scheduling into this model is forbidden.
 */
export const FSRS_STATES = ["new", "learning", "review", "relearning"] as const;
export type FsrsState = (typeof FSRS_STATES)[number];

/**
 * Review grades. `again | hard | good | easy` map to the FSRS rating values
 * `1 | 2 | 3 | 4` — see {@link REVIEW_RATING_VALUE}.
 */
export const REVIEW_RATINGS = ["again", "hard", "good", "easy"] as const;
export type ReviewRating = (typeof REVIEW_RATINGS)[number];

/** Numeric FSRS rating values, indexed by {@link ReviewRating}. */
export const REVIEW_RATING_VALUE: Readonly<Record<ReviewRating, 1 | 2 | 3 | 4>> = {
  again: 1,
  hard: 2,
  good: 3,
  easy: 4,
};

/**
 * Kinds of large binary an {@link Asset} can describe. The bytes live in the
 * filesystem asset vault, never in SQLite (see asset-vault separation).
 */
export const ASSET_KINDS = [
  "source_html",
  "source_pdf",
  "snapshot",
  "image",
  "audio",
  "video",
  "export",
  "backup",
] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

/**
 * Logical roots inside the asset vault that a {@link LocalVaultPath} can be
 * relative to. Resolved to an absolute path only by the Electron main/DB
 * service — the renderer never sees a raw filesystem path.
 */
export const VAULT_ROOTS = ["assets", "exports", "backups"] as const;
export type VaultRoot = (typeof VAULT_ROOTS)[number];
