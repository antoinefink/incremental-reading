ALTER TABLE `review_logs` ADD `prompt_ms` integer;--> statement-breakpoint
ALTER TABLE `review_logs` ADD `prev_due_at` text;--> statement-breakpoint
ALTER TABLE `review_logs` ADD `prev_stability` real;--> statement-breakpoint
ALTER TABLE `review_logs` ADD `prev_difficulty` real;--> statement-breakpoint
ALTER TABLE `review_logs` ADD `prev_elapsed_days` real;--> statement-breakpoint
ALTER TABLE `review_logs` ADD `prev_scheduled_days` real;--> statement-breakpoint
ALTER TABLE `review_logs` ADD `prev_reps` integer;--> statement-breakpoint
ALTER TABLE `review_logs` ADD `prev_lapses` integer;--> statement-breakpoint
ALTER TABLE `review_logs` ADD `prev_learning_steps` integer;--> statement-breakpoint
ALTER TABLE `review_logs` ADD `prev_last_reviewed_at` text;--> statement-breakpoint
ALTER TABLE `review_logs` ADD `next_elapsed_days` real;--> statement-breakpoint
ALTER TABLE `review_logs` ADD `next_scheduled_days` real;--> statement-breakpoint
ALTER TABLE `review_logs` ADD `next_reps` integer;--> statement-breakpoint
ALTER TABLE `review_logs` ADD `next_lapses` integer;--> statement-breakpoint
ALTER TABLE `review_logs` ADD `next_learning_steps` integer;
