CREATE INDEX `elements_type_created_idx` ON `elements` (`type`,`created_at`);--> statement-breakpoint
CREATE INDEX `elements_deleted_at_idx` ON `elements` (`deleted_at`);