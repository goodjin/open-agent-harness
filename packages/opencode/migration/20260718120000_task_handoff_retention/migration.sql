CREATE TABLE `task_handoff_retained` (
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
	CONSTRAINT `task_handoff_target_pair_check` CHECK ((`target_session_id` IS NULL) = (`target_task_id` IS NULL)),
	FOREIGN KEY (`source_session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_task_id`) REFERENCES `session_task`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `task_handoff_source_task_fk` FOREIGN KEY (`source_session_id`,`source_task_id`) REFERENCES `session_task`(`session_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `task_handoff_retained` SELECT * FROM `task_handoff`;
--> statement-breakpoint
DROP TABLE `task_handoff`;
--> statement-breakpoint
ALTER TABLE `task_handoff_retained` RENAME TO `task_handoff`;
--> statement-breakpoint
CREATE UNIQUE INDEX `task_handoff_dedupe_unique_idx` ON `task_handoff` (`dedupe_key`);
