ALTER TABLE `elements` ADD `attention_interval_multiplier` real DEFAULT 1.0 NOT NULL CHECK (`attention_interval_multiplier` >= 0.5 AND `attention_interval_multiplier` <= 4.0);
