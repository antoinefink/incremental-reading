-- T090: claim-lifetime fields are CARDS-ONLY; the elements mirror is deferred. T092's
-- generateVerificationTasks scans card-backed facts only.
--
-- Adds the six nullable claim-lifetime columns to `cards` (fact_stability, valid_from,
-- valid_until, jurisdiction, software_version, review_by) + a CHECK on fact_stability
-- (the core FACT_STABILITY tuple) + `cards_review_by_idx` (so T092's expiry scan
-- `WHERE review_by < now` / `valid_until < now` is cheap). All fields nullable, no
-- backfill — a fact with no lifetime never expires. "Expired" is a DERIVED attribute,
-- NOT a new ELEMENT_STATUSES value, and no new operation_log op type is introduced
-- (edits are update_element).
--
-- Adding the `fact_stability` CHECK requires a table rebuild (SQLite cannot ALTER a
-- CHECK). The FTS sync triggers that reference `cards` (cards_fts_*, elements_fts_au)
-- must be DROPPED before the DROP/RENAME and RECREATED verbatim after — otherwise the
-- rename fails with "no such table: main.cards" from inside a trigger body referencing
-- the mid-rewrite table (the SAME pattern migration 0014 used). Recreated exactly as
-- they stood (migrations 0002 + 0005 + 0014).
DROP TRIGGER `cards_fts_ai`;--> statement-breakpoint
DROP TRIGGER `cards_fts_au`;--> statement-breakpoint
DROP TRIGGER `cards_fts_ad`;--> statement-breakpoint
DROP TRIGGER `elements_fts_au`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_cards` (
	`element_id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`prompt` text,
	`answer` text,
	`cloze` text,
	`source_location_id` text,
	`source_uri` text,
	`media_ref` text,
	`is_leech` integer DEFAULT false NOT NULL,
	`desired_retention` real,
	`is_retired` integer DEFAULT false NOT NULL,
	`fact_stability` text,
	`valid_from` text,
	`valid_until` text,
	`jurisdiction` text,
	`software_version` text,
	`review_by` text,
	FOREIGN KEY (`element_id`) REFERENCES `elements`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_location_id`) REFERENCES `source_locations`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "cards_kind_check" CHECK("__new_cards"."kind" IN ('qa', 'cloze', 'image_occlusion')),
	CONSTRAINT "cards_fact_stability_check" CHECK("__new_cards"."fact_stability" IN ('stable', 'slow', 'volatile'))
);
--> statement-breakpoint
-- Only the PRE-EXISTING columns are copied; the six new claim-lifetime columns default
-- to NULL (no backfill). (Drizzle 0.45.x mis-generates the SELECT list to include the
-- new columns when an added column also adds a CHECK that forces a rebuild — corrected
-- here so the copy reads only the old shape.)
INSERT INTO `__new_cards`("element_id", "kind", "prompt", "answer", "cloze", "source_location_id", "source_uri", "media_ref", "is_leech", "desired_retention", "is_retired") SELECT "element_id", "kind", "prompt", "answer", "cloze", "source_location_id", "source_uri", "media_ref", "is_leech", "desired_retention", "is_retired" FROM `cards`;--> statement-breakpoint
DROP TABLE `cards`;--> statement-breakpoint
ALTER TABLE `__new_cards` RENAME TO `cards`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `cards_source_location_idx` ON `cards` (`source_location_id`);--> statement-breakpoint
CREATE INDEX `cards_is_leech_idx` ON `cards` (`is_leech`);--> statement-breakpoint
CREATE INDEX `cards_is_retired_idx` ON `cards` (`is_retired`);--> statement-breakpoint
CREATE INDEX `cards_review_by_idx` ON `cards` (`review_by`);--> statement-breakpoint
-- Recreate the dropped FTS sync triggers verbatim (migrations 0002 + 0005 + 0014).
CREATE TRIGGER `cards_fts_ai` AFTER INSERT ON `cards` BEGIN
	DELETE FROM `card_fts` WHERE element_id = new.element_id;
	INSERT INTO `card_fts`(element_id, prompt, answer, tags)
		SELECT new.element_id,
			COALESCE(new.prompt, new.cloze, ''),
			COALESCE(new.answer, ''),
			(SELECT COALESCE(group_concat(t.name, ' '), '')
				FROM element_tags et JOIN tags t ON t.id = et.tag_id
				WHERE et.element_id = new.element_id)
		FROM elements e WHERE e.id = new.element_id AND e.deleted_at IS NULL;
END;--> statement-breakpoint
CREATE TRIGGER `cards_fts_au` AFTER UPDATE ON `cards` BEGIN
	DELETE FROM `card_fts` WHERE element_id = new.element_id;
	INSERT INTO `card_fts`(element_id, prompt, answer, tags)
		SELECT new.element_id,
			COALESCE(new.prompt, new.cloze, ''),
			COALESCE(new.answer, ''),
			(SELECT COALESCE(group_concat(t.name, ' '), '')
				FROM element_tags et JOIN tags t ON t.id = et.tag_id
				WHERE et.element_id = new.element_id)
		FROM elements e WHERE e.id = new.element_id AND e.deleted_at IS NULL;
END;--> statement-breakpoint
CREATE TRIGGER `cards_fts_ad` AFTER DELETE ON `cards` BEGIN
	DELETE FROM `card_fts` WHERE element_id = old.element_id;
END;--> statement-breakpoint
CREATE TRIGGER `elements_fts_au` AFTER UPDATE ON `elements` BEGIN
	DELETE FROM `source_fts` WHERE element_id = new.id;
	DELETE FROM `extract_fts` WHERE element_id = new.id;
	DELETE FROM `card_fts` WHERE element_id = new.id;
	INSERT INTO `source_fts`(element_id, title, body, tags)
		SELECT new.id, new.title, d.plain_text,
			(SELECT COALESCE(group_concat(t.name, ' '), '')
				FROM element_tags et JOIN tags t ON t.id = et.tag_id
				WHERE et.element_id = new.id)
		FROM documents d
		WHERE d.element_id = new.id AND new.type = 'source' AND new.deleted_at IS NULL;
	INSERT INTO `extract_fts`(element_id, title, body, tags)
		SELECT new.id, new.title,
			(SELECT COALESCE(group_concat(sl.selected_text, ' '), '')
				FROM source_locations sl WHERE sl.element_id = new.id),
			(SELECT COALESCE(group_concat(t.name, ' '), '')
				FROM element_tags et JOIN tags t ON t.id = et.tag_id
				WHERE et.element_id = new.id)
		FROM elements e
		WHERE e.id = new.id AND new.type = 'extract' AND new.deleted_at IS NULL;
	INSERT INTO `card_fts`(element_id, prompt, answer, tags)
		SELECT new.id,
			COALESCE(c.prompt, c.cloze, ''),
			COALESCE(c.answer, ''),
			(SELECT COALESCE(group_concat(t.name, ' '), '')
				FROM element_tags et JOIN tags t ON t.id = et.tag_id
				WHERE et.element_id = new.id)
		FROM cards c
		WHERE c.element_id = new.id AND new.type = 'card' AND new.deleted_at IS NULL;
END;
