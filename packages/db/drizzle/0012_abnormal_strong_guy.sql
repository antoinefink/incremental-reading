PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`status` text NOT NULL,
	`payload` text NOT NULL,
	`result` text,
	`error` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer NOT NULL,
	`progress_ratio` integer DEFAULT 0 NOT NULL,
	`progress_note` text,
	`not_before` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`started_at` text,
	`finished_at` text,
	CONSTRAINT "jobs_type_check" CHECK("__new_jobs"."type" IN ('url_import', 'ocr', 'epub_import', 'embed', 'ai', 'cleanup', 'vault_verify', 'vault_gc')),
	CONSTRAINT "jobs_status_check" CHECK("__new_jobs"."status" IN ('queued', 'running', 'succeeded', 'failed', 'cancelled'))
);
--> statement-breakpoint
INSERT INTO `__new_jobs`("id", "type", "status", "payload", "result", "error", "attempts", "max_attempts", "progress_ratio", "progress_note", "not_before", "created_at", "updated_at", "started_at", "finished_at") SELECT "id", "type", "status", "payload", "result", "error", "attempts", "max_attempts", "progress_ratio", "progress_note", "not_before", "created_at", "updated_at", "started_at", "finished_at" FROM `jobs`;--> statement-breakpoint
DROP TABLE `jobs`;--> statement-breakpoint
ALTER TABLE `__new_jobs` RENAME TO `jobs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `jobs_status_idx` ON `jobs` (`status`);--> statement-breakpoint
CREATE INDEX `jobs_created_idx` ON `jobs` (`created_at`);