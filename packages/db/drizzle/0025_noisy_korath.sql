-- T092: verification tasks — widen the EXISTING `tasks` side-table.
--
-- Adds `task_type` CHECK (the core TASK_TYPES tuple: verify_claim /
-- find_better_source / update_outdated_card / check_current_version / custom),
-- `linked_element_id` (text, nullable, FK → elements.id ON DELETE SET NULL — the
-- element a verification task protects; dual-modeled with the canonical `references`
-- edge, like cards.source_location_id) + `tasks_linked_element_idx`, `note` (free
-- text ≤2048), and the PARTIAL UNIQUE INDEX `tasks_open_link_type_uq` on
-- (linked_element_id, task_type) WHERE status NOT IN ('done','dismissed','deleted')
-- so at most ONE OPEN task of a kind protects a given element (idempotent
-- generateVerificationTasks). NO new operation_log op type (create → create_element,
-- link → add_relation, schedule/complete/postpone → reschedule_element) and NO new
-- ELEMENT_STATUSES value — a task reuses the existing element/status/attention model.
--
-- Adding the `task_type` CHECK requires a table rebuild (SQLite cannot ALTER a CHECK).
-- NO trigger drop/recreate is needed: the FTS sync triggers reference
-- documents/elements/cards, never `tasks`. The INSERT…SELECT copies ONLY the
-- PRE-EXISTING columns (element_id/task_type/due_at/status); the two new columns
-- default to NULL (no backfill) — corrected from Drizzle 0.45.x's mis-generated SELECT
-- that wrongly listed the just-added columns (same fix as migrations 0023 + 0024).
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_tasks` (
	`element_id` text PRIMARY KEY NOT NULL,
	`task_type` text NOT NULL,
	`due_at` text,
	`status` text NOT NULL,
	`linked_element_id` text,
	`note` text,
	FOREIGN KEY (`element_id`) REFERENCES `elements`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`linked_element_id`) REFERENCES `elements`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "tasks_status_check" CHECK("__new_tasks"."status" IN ('inbox', 'pending', 'active', 'scheduled', 'done', 'dismissed', 'suspended', 'deleted')),
	CONSTRAINT "tasks_task_type_check" CHECK("__new_tasks"."task_type" IN ('verify_claim', 'find_better_source', 'update_outdated_card', 'check_current_version', 'custom'))
);
--> statement-breakpoint
INSERT INTO `__new_tasks`("element_id", "task_type", "due_at", "status") SELECT "element_id", "task_type", "due_at", "status" FROM `tasks`;--> statement-breakpoint
DROP TABLE `tasks`;--> statement-breakpoint
ALTER TABLE `__new_tasks` RENAME TO `tasks`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `tasks_due_idx` ON `tasks` (`due_at`);--> statement-breakpoint
CREATE INDEX `tasks_linked_element_idx` ON `tasks` (`linked_element_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_open_link_type_uq` ON `tasks` (`linked_element_id`,`task_type`) WHERE status NOT IN ('done', 'dismissed', 'deleted');