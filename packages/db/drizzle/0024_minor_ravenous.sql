-- T091: source-reliability metadata. Adds four nullable columns to `sources`
-- (source_type, reliability_tier, confidence, reliability_notes) + three CHECKs on
-- the three enum columns (the core SOURCE_TYPES / RELIABILITY_TIERS / CONFIDENCE_LEVELS
-- tuples — the DB + the domain union can't drift). All fields nullable, no backfill —
-- a source with no reliability data renders exactly as before (no badge). Reliability
-- is PROVENANCE (on the `sources` side-table), not lineage; editing it is
-- update_element (no new operation_log op type), and no new ELEMENT_STATUSES value is
-- introduced.
--
-- Adding the three CHECKs requires a table rebuild (SQLite cannot ALTER a CHECK). No
-- triggers reference `sources` (the FTS triggers read `documents`/`elements`, not
-- `sources`), so no trigger drop/recreate is needed — unlike the cards rebuild (0023).
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_sources` (
	`element_id` text PRIMARY KEY NOT NULL,
	`url` text,
	`canonical_url` text,
	`original_url` text,
	`author` text,
	`published_at` text,
	`accessed_at` text,
	`snapshot_key` text,
	`reason_added` text,
	`media_kind` text,
	`source_type` text,
	`reliability_tier` text,
	`confidence` text,
	`reliability_notes` text,
	FOREIGN KEY (`element_id`) REFERENCES `elements`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "sources_source_type_check" CHECK("__new_sources"."source_type" IN ('paper', 'book', 'article', 'docs', 'reference', 'blog', 'forum', 'video', 'dataset', 'personal_note', 'other')),
	CONSTRAINT "sources_reliability_tier_check" CHECK("__new_sources"."reliability_tier" IN ('primary', 'secondary', 'tertiary')),
	CONSTRAINT "sources_confidence_check" CHECK("__new_sources"."confidence" IN ('high', 'medium', 'low'))
);
--> statement-breakpoint
-- Only the PRE-EXISTING columns are copied; the four new reliability columns default
-- to NULL (no backfill). (Drizzle 0.45.x mis-generates the SELECT list to include the
-- new columns when an added column also adds a CHECK that forces a rebuild — corrected
-- here so the copy reads only the old shape, exactly as migration 0023 did for cards.)
INSERT INTO `__new_sources`("element_id", "url", "canonical_url", "original_url", "author", "published_at", "accessed_at", "snapshot_key", "reason_added", "media_kind") SELECT "element_id", "url", "canonical_url", "original_url", "author", "published_at", "accessed_at", "snapshot_key", "reason_added", "media_kind" FROM `sources`;--> statement-breakpoint
DROP TABLE `sources`;--> statement-breakpoint
ALTER TABLE `__new_sources` RENAME TO `sources`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `sources_canonical_url_idx` ON `sources` (`canonical_url`);
