-- T042 — Search: SQLite FTS5 full-text index (hand-authored migration).
--
-- Drizzle's schema introspection does NOT model FTS5 virtual tables, so this
-- migration is hand-authored and NOT generated from packages/db/src/schema.
-- The FTS objects below (source_fts / extract_fts / card_fts + their sync
-- triggers) are migration-only — they intentionally do not appear in the TS
-- schema barrel, so future `drizzle-kit generate` runs will not try to drop
-- them. better-sqlite3 ships with ENABLE_FTS5 compiled in (verified).
--
-- The three FTS tables are DERIVED, rebuildable indexes — not the source of
-- truth. They are kept in sync with the base tables by triggers, inside the same
-- write transaction as each base-table mutation, so the index cannot drift from
-- a missed code path. `element_id` is UNINDEXED (stored, not tokenized) so the
-- repository can join FTS hits back to live `elements`. A one-time backfill at
-- the bottom makes any pre-existing rows (the seed, an existing DB) searchable
-- immediately after migrating.
--
-- Body provenance per type:
--   source  → elements.title + documents.plain_text (sources always have a doc)
--   extract → elements.title + source_locations.selected_text (the verbatim
--             extracted text; extracts have NO documents row — their body lives
--             in the source-location anchor)
--   card    → cards.prompt/cloze + cards.answer
-- The `tags` column on each is aggregated from element_tags.

CREATE VIRTUAL TABLE `source_fts` USING fts5(
	element_id UNINDEXED,
	title,
	body,
	tags,
	tokenize='unicode61 remove_diacritics 2'
);
--> statement-breakpoint
CREATE VIRTUAL TABLE `extract_fts` USING fts5(
	element_id UNINDEXED,
	title,
	body,
	tags,
	tokenize='unicode61 remove_diacritics 2'
);
--> statement-breakpoint
CREATE VIRTUAL TABLE `card_fts` USING fts5(
	element_id UNINDEXED,
	prompt,
	answer,
	tags,
	tokenize='unicode61 remove_diacritics 2'
);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Source body triggers. A `documents` row belongs 1:1 to an element; for a
-- `source` element it is the body mirror. On any document change rebuild the
-- owning SOURCE's FTS row (extracts have no documents row, so this is sources
-- only). DELETE-then-INSERT keyed on element_id keeps a single row per element.
-- ---------------------------------------------------------------------------

CREATE TRIGGER `documents_fts_ai` AFTER INSERT ON `documents` BEGIN
	DELETE FROM `source_fts` WHERE element_id = new.element_id;
	INSERT INTO `source_fts`(element_id, title, body, tags)
		SELECT e.id, e.title, new.plain_text,
			(SELECT COALESCE(group_concat(t.name, ' '), '')
				FROM element_tags et JOIN tags t ON t.id = et.tag_id
				WHERE et.element_id = e.id)
		FROM elements e WHERE e.id = new.element_id AND e.type = 'source' AND e.deleted_at IS NULL;
END;
--> statement-breakpoint
CREATE TRIGGER `documents_fts_au` AFTER UPDATE ON `documents` BEGIN
	DELETE FROM `source_fts` WHERE element_id = new.element_id;
	INSERT INTO `source_fts`(element_id, title, body, tags)
		SELECT e.id, e.title, new.plain_text,
			(SELECT COALESCE(group_concat(t.name, ' '), '')
				FROM element_tags et JOIN tags t ON t.id = et.tag_id
				WHERE et.element_id = e.id)
		FROM elements e WHERE e.id = new.element_id AND e.type = 'source' AND e.deleted_at IS NULL;
END;
--> statement-breakpoint
CREATE TRIGGER `documents_fts_ad` AFTER DELETE ON `documents` BEGIN
	DELETE FROM `source_fts` WHERE element_id = old.element_id;
END;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Extract body triggers. An extract's searchable body is the verbatim
-- `source_locations.selected_text` anchoring it (extracts carry exactly one).
-- On any source-location change for an extract, rebuild its extract_fts row
-- (title from elements, body from the selected text).
-- ---------------------------------------------------------------------------

CREATE TRIGGER `source_locations_fts_ai` AFTER INSERT ON `source_locations` BEGIN
	DELETE FROM `extract_fts` WHERE element_id = new.element_id;
	INSERT INTO `extract_fts`(element_id, title, body, tags)
		SELECT e.id, e.title, new.selected_text,
			(SELECT COALESCE(group_concat(t.name, ' '), '')
				FROM element_tags et JOIN tags t ON t.id = et.tag_id
				WHERE et.element_id = e.id)
		FROM elements e WHERE e.id = new.element_id AND e.type = 'extract' AND e.deleted_at IS NULL;
END;
--> statement-breakpoint
CREATE TRIGGER `source_locations_fts_au` AFTER UPDATE ON `source_locations` BEGIN
	DELETE FROM `extract_fts` WHERE element_id = new.element_id;
	INSERT INTO `extract_fts`(element_id, title, body, tags)
		SELECT e.id, e.title, new.selected_text,
			(SELECT COALESCE(group_concat(t.name, ' '), '')
				FROM element_tags et JOIN tags t ON t.id = et.tag_id
				WHERE et.element_id = e.id)
		FROM elements e WHERE e.id = new.element_id AND e.type = 'extract' AND e.deleted_at IS NULL;
END;
--> statement-breakpoint
CREATE TRIGGER `source_locations_fts_ad` AFTER DELETE ON `source_locations` BEGIN
	DELETE FROM `extract_fts` WHERE element_id = old.element_id;
END;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Element title trigger. When a source/extract title changes (or an element is
-- soft-deleted/restored), rebuild its FTS row so the title column stays current
-- and a soft-deleted element drops out of the index. The body is re-derived
-- from the type-appropriate source (documents for sources, the source-location
-- selected text for extracts). Cards carry no title in FTS.
--
-- NOTE (fixed in migration 0005): this ORIGINAL version did NOT touch card_fts,
-- so a soft-deleted card left a stale card_fts row (index drift, masked only by
-- the query-time deleted_at join). Migration 0005 drops + recreates this trigger
-- to also maintain card_fts. It is left here verbatim so already-migrated DBs
-- replay identically before 0005 applies the fix.
-- ---------------------------------------------------------------------------

CREATE TRIGGER `elements_fts_au` AFTER UPDATE ON `elements` BEGIN
	DELETE FROM `source_fts` WHERE element_id = new.id;
	DELETE FROM `extract_fts` WHERE element_id = new.id;
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
END;
--> statement-breakpoint
CREATE TRIGGER `elements_fts_ad` AFTER DELETE ON `elements` BEGIN
	DELETE FROM `source_fts` WHERE element_id = old.id;
	DELETE FROM `extract_fts` WHERE element_id = old.id;
	DELETE FROM `card_fts` WHERE element_id = old.id;
END;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Card triggers. A card's prompt/answer/cloze drive its FTS row; the tags
-- column is aggregated from element_tags. Cloze cards have no prompt/answer, so
-- the cloze text is folded into `prompt` for searchability.
-- ---------------------------------------------------------------------------

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
END;
--> statement-breakpoint
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
END;
--> statement-breakpoint
CREATE TRIGGER `cards_fts_ad` AFTER DELETE ON `cards` BEGIN
	DELETE FROM `card_fts` WHERE element_id = old.element_id;
END;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Tag-membership triggers. Adding/removing a tag changes only the aggregated
-- `tags` column of whichever FTS table owns the element. We recompute it in
-- place (FTS5 supports UPDATE on its columns). The aggregate is read AFTER the
-- element_tags change has been applied.
-- ---------------------------------------------------------------------------

CREATE TRIGGER `element_tags_fts_ai` AFTER INSERT ON `element_tags` BEGIN
	UPDATE `source_fts`
		SET tags = (SELECT COALESCE(group_concat(t.name, ' '), '')
			FROM element_tags et JOIN tags t ON t.id = et.tag_id
			WHERE et.element_id = new.element_id)
		WHERE element_id = new.element_id;
	UPDATE `extract_fts`
		SET tags = (SELECT COALESCE(group_concat(t.name, ' '), '')
			FROM element_tags et JOIN tags t ON t.id = et.tag_id
			WHERE et.element_id = new.element_id)
		WHERE element_id = new.element_id;
	UPDATE `card_fts`
		SET tags = (SELECT COALESCE(group_concat(t.name, ' '), '')
			FROM element_tags et JOIN tags t ON t.id = et.tag_id
			WHERE et.element_id = new.element_id)
		WHERE element_id = new.element_id;
END;
--> statement-breakpoint
CREATE TRIGGER `element_tags_fts_ad` AFTER DELETE ON `element_tags` BEGIN
	UPDATE `source_fts`
		SET tags = (SELECT COALESCE(group_concat(t.name, ' '), '')
			FROM element_tags et JOIN tags t ON t.id = et.tag_id
			WHERE et.element_id = old.element_id)
		WHERE element_id = old.element_id;
	UPDATE `extract_fts`
		SET tags = (SELECT COALESCE(group_concat(t.name, ' '), '')
			FROM element_tags et JOIN tags t ON t.id = et.tag_id
			WHERE et.element_id = old.element_id)
		WHERE element_id = old.element_id;
	UPDATE `card_fts`
		SET tags = (SELECT COALESCE(group_concat(t.name, ' '), '')
			FROM element_tags et JOIN tags t ON t.id = et.tag_id
			WHERE et.element_id = old.element_id)
		WHERE element_id = old.element_id;
END;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- One-time backfill of any rows that already exist (the seed / a pre-existing
-- DB) so search works immediately after migrating, before any new writes.
-- ---------------------------------------------------------------------------

INSERT INTO `source_fts`(element_id, title, body, tags)
	SELECT e.id, e.title, d.plain_text,
		(SELECT COALESCE(group_concat(t.name, ' '), '')
			FROM element_tags et JOIN tags t ON t.id = et.tag_id
			WHERE et.element_id = e.id)
	FROM elements e JOIN documents d ON d.element_id = e.id
	WHERE e.type = 'source' AND e.deleted_at IS NULL;
--> statement-breakpoint
INSERT INTO `extract_fts`(element_id, title, body, tags)
	SELECT e.id, e.title,
		(SELECT COALESCE(group_concat(sl.selected_text, ' '), '')
			FROM source_locations sl WHERE sl.element_id = e.id),
		(SELECT COALESCE(group_concat(t.name, ' '), '')
			FROM element_tags et JOIN tags t ON t.id = et.tag_id
			WHERE et.element_id = e.id)
	FROM elements e
	WHERE e.type = 'extract' AND e.deleted_at IS NULL;
--> statement-breakpoint
INSERT INTO `card_fts`(element_id, prompt, answer, tags)
	SELECT c.element_id,
		COALESCE(c.prompt, c.cloze, ''),
		COALESCE(c.answer, ''),
		(SELECT COALESCE(group_concat(t.name, ' '), '')
			FROM element_tags et JOIN tags t ON t.id = et.tag_id
			WHERE et.element_id = c.element_id)
	FROM cards c JOIN elements e ON e.id = c.element_id
	WHERE e.deleted_at IS NULL;
