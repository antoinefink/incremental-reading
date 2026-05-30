-- T042 fix — keep `card_fts` in sync on element soft-delete/restore.
--
-- The original `elements_fts_au` trigger (migration 0002) rebuilt `source_fts`
-- and `extract_fts` on every `elements` UPDATE (so a soft-deleted source/extract
-- drops out of the index) but NEVER touched `card_fts`. A card is soft-deleted
-- via `UPDATE elements SET deleted_at = …`, which fires this trigger — so a
-- soft-deleted card left a STALE row in `card_fts`. No data leaked (the search
-- query re-joins live `elements`), but the index drifted from the base tables,
-- contradicting migration 0002's own "triggers prevent index drift" claim.
--
-- This migration drops + recreates the trigger so it ALSO drop/restores the
-- card's `card_fts` row (keyed on element_id), mirroring the source/extract
-- handling: DELETE the row, then re-INSERT from the owning `cards` row only when
-- the element is live. Like all the FTS objects, the trigger is migration-only
-- (not modeled in the Drizzle TS schema), so it is hand-authored here.

DROP TRIGGER `elements_fts_au`;
--> statement-breakpoint
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
