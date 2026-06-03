CREATE TABLE `ai_suggestions` (
	`id` text PRIMARY KEY NOT NULL,
	`owning_element_id` text NOT NULL,
	`action` text NOT NULL,
	`kind` text NOT NULL,
	`provider_kind` text NOT NULL,
	`suggestion_text` text DEFAULT '' NOT NULL,
	`cards` text,
	`source_element_id` text,
	`source_block_ids` text,
	`start_offset` integer,
	`end_offset` integer,
	`selected_text` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`owning_element_id`) REFERENCES `elements`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_element_id`) REFERENCES `elements`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ai_suggestions_action_check" CHECK("ai_suggestions"."action" IN ('explain', 'simplify', 'suggest_qa', 'suggest_cloze', 'detect_ambiguity', 'propose_prerequisites', 'summarize')),
	CONSTRAINT "ai_suggestions_kind_check" CHECK("ai_suggestions"."kind" IN ('text', 'card_qa', 'card_cloze', 'prerequisite_list')),
	CONSTRAINT "ai_suggestions_status_value_check" CHECK("ai_suggestions"."status" IN ('draft', 'approved', 'dismissed'))
);
--> statement-breakpoint
CREATE INDEX `ai_suggestions_owning_idx` ON `ai_suggestions` (`owning_element_id`);--> statement-breakpoint
CREATE INDEX `ai_suggestions_status_idx` ON `ai_suggestions` (`status`);