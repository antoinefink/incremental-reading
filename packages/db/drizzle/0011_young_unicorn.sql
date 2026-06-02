PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`owning_element_id` text NOT NULL,
	`kind` text NOT NULL,
	`vault_root` text NOT NULL,
	`relative_path` text NOT NULL,
	`content_hash` text NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`width` integer,
	`height` integer,
	`duration_ms` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`owning_element_id`) REFERENCES `elements`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "assets_kind_check" CHECK("__new_assets"."kind" IN ('source_html', 'source_pdf', 'source_epub', 'snapshot', 'image', 'audio', 'video', 'export', 'backup')),
	CONSTRAINT "assets_vault_root_check" CHECK("__new_assets"."vault_root" IN ('assets', 'exports', 'backups'))
);
--> statement-breakpoint
INSERT INTO `__new_assets`("id", "owning_element_id", "kind", "vault_root", "relative_path", "content_hash", "mime", "size", "width", "height", "duration_ms", "created_at") SELECT "id", "owning_element_id", "kind", "vault_root", "relative_path", "content_hash", "mime", "size", "width", "height", "duration_ms", "created_at" FROM `assets`;--> statement-breakpoint
DROP TABLE `assets`;--> statement-breakpoint
ALTER TABLE `__new_assets` RENAME TO `assets`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `assets_owning_element_idx` ON `assets` (`owning_element_id`);--> statement-breakpoint
CREATE INDEX `assets_content_hash_idx` ON `assets` (`content_hash`);