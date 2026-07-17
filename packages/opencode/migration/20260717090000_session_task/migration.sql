CREATE TABLE `session_task` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`title` text NOT NULL,
	`status` text NOT NULL,
	`current_revision_id` text,
	`source_type` text NOT NULL,
	`source_ref` text NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_task_session_unique_idx` ON `session_task` (`session_id`);
--> statement-breakpoint
CREATE TABLE `task_revision` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`version` integer NOT NULL,
	`previous_id` text,
	`status` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`body_hash` text NOT NULL,
	`source_message_id` text,
	`reason` text,
	`workflow` text NOT NULL,
	`result` text,
	`result_source` text,
	`time_created` integer NOT NULL,
	`time_activated` integer,
	`time_completed` integer,
	`time_archived` integer,
	`archive_reason` text,
	FOREIGN KEY (`task_id`) REFERENCES `session_task`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_revision_task_version_unique_idx` ON `task_revision` (`task_id`,`version`);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_revision_one_active_idx` ON `task_revision` (`task_id`) WHERE `status` = 'active';
--> statement-breakpoint
CREATE TABLE `task_handoff` (
	`id` text PRIMARY KEY NOT NULL,
	`source_session_id` text NOT NULL,
	`source_task_id` text,
	`source_message_id` text,
	`target_session_id` text,
	`target_task_id` text,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`body_hash` text NOT NULL,
	`context_refs` text NOT NULL,
	`status` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`error` text,
	`time_created` integer NOT NULL,
	`time_confirmed` integer,
	`time_completed` integer,
	FOREIGN KEY (`source_session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_task_id`) REFERENCES `session_task`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_handoff_dedupe_unique_idx` ON `task_handoff` (`dedupe_key`);
