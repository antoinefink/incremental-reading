-- T125 — Card-edit write barrier: review_logs edit-marker columns.
--
-- HAND-EDITED to be PURELY ADDITIVE. `drizzle-kit generate` wanted to REBUILD the
-- `review_logs` table (PRAGMA foreign_keys=OFF; CREATE __new_review_logs → copy →
-- DROP review_logs → RENAME) because this diff adds three columns plus two new CHECK
-- constraints. That rebuild is the exact shape that fired `ON DELETE SET NULL`/cascade
-- on FK-bearing tables and NULLED every parent/source link in the real vault during
-- migration 0030
-- (see docs/solutions/database-issues/sqlite-table-rebuild-with-foreign-keys-on-fires-on-delete-actions.md
-- and the 0037/0038 header notes). Adding columns with `ALTER TABLE ... ADD COLUMN`
-- (incl. a column-level CHECK that allows NULL, exactly as migration 0032 did for
-- `extract_fate` and 0037 did for `needs_reverify`) does NOT rebuild the table and
-- cannot copy/drop rows. The end-state schema is identical to the generated snapshot,
-- so future `db:generate` runs stay clean.
--
-- If a future `db:generate` ever proposes a `review_logs` rebuild here, hand-edit it
-- back down to ONLY the additive `ALTER TABLE ... ADD COLUMN` statements below.
--
-- All three columns are nullable and default NULL on every existing row: a NULL
-- `edit_marker_at` means "a normal graded review" (the only kind that existed before
-- T125), so the nullable-domain CHECKs pass for every pre-existing row.
ALTER TABLE `review_logs` ADD `edit_marker_at` text;--> statement-breakpoint
ALTER TABLE `review_logs` ADD `edit_class` text CHECK ("edit_class" IS NULL OR "edit_class" IN ('typo', 'substantive'));--> statement-breakpoint
ALTER TABLE `review_logs` ADD `edit_choice` text CHECK ("edit_choice" IS NULL OR "edit_choice" IN ('keep', 're_stabilize'));
