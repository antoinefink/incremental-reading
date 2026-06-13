-- T123 — Stale propagation through the lineage DAG.
--
-- HAND-EDITED to be PURELY ADDITIVE. `drizzle-kit generate` wanted to REBUILD the
-- `elements` table (CREATE __new_elements → copy → DROP elements → RENAME) because
-- this diff adds two columns plus a new CHECK. That 12-step rebuild is the exact
-- shape that fired `ON DELETE SET NULL` on the self-referential lineage FKs and
-- NULLED every parent/source link in the real vault during migration 0030
-- (see docs/solutions/database-issues/sqlite-table-rebuild-with-foreign-keys-on-fires-on-delete-actions.md).
-- Adding columns with `ALTER TABLE ... ADD COLUMN` (incl. a CHECK that references a
-- sibling column, exactly as migration 0032 did for `extract_fate`) does NOT rebuild
-- the table and cannot disturb lineage. The end-state schema is identical to the
-- generated snapshot, so future `db:generate` runs stay clean.
--
-- New `needs_reverify` defaults to 0 for every existing row, so the type-coupled
-- CHECK passes for all rows regardless of type (`needs_reverify = 0` is satisfied).
CREATE TABLE `element_reverify_provenance` (
	`id` text PRIMARY KEY NOT NULL,
	`element_id` text NOT NULL,
	`source_element_id` text NOT NULL,
	`stable_block_id` text NOT NULL,
	`batch_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`element_id`) REFERENCES `elements`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_element_id`) REFERENCES `elements`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `element_reverify_provenance_unique_idx` ON `element_reverify_provenance` (`element_id`,`source_element_id`,`stable_block_id`);--> statement-breakpoint
CREATE INDEX `element_reverify_provenance_element_idx` ON `element_reverify_provenance` (`element_id`);--> statement-breakpoint
CREATE INDEX `element_reverify_provenance_source_block_idx` ON `element_reverify_provenance` (`source_element_id`,`stable_block_id`);--> statement-breakpoint
ALTER TABLE `source_block_processing` ADD `pre_stale_hash` text;--> statement-breakpoint
ALTER TABLE `elements` ADD `needs_reverify` integer DEFAULT false NOT NULL CHECK (`needs_reverify` = 0 OR `type` IN ('extract', 'card', 'media_fragment'));--> statement-breakpoint
ALTER TABLE `elements` ADD `stale_since` text;
