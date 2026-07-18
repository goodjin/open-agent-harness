CREATE TABLE `task_confirmation` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`proposal_id` text NOT NULL,
	`operation` text NOT NULL,
	`decision` text NOT NULL,
	`status` text NOT NULL,
	`expected_revision_id` text,
	`handoff_id` text,
	`assignment_id` text,
	`message_id` text NOT NULL,
	`error` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_confirmation_session_proposal_unique_idx` ON `task_confirmation` (`session_id`,`proposal_id`);
--> statement-breakpoint
CREATE INDEX `task_confirmation_status_idx` ON `task_confirmation` (`status`);
