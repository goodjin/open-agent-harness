CREATE TABLE `runtime_interaction` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`task_id` text,
	`revision_id` text,
	`run_id` text,
	`action_id` text,
	`message_id` text,
	`request_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`payload` text NOT NULL,
	`decision` text,
	`checkpoint` text,
	`generation` integer DEFAULT 1 NOT NULL,
	`error` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	`time_resolved` integer,
	FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_interaction_request_unique_idx` ON `runtime_interaction` (`request_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_interaction_protocol_unique_idx` ON `runtime_interaction` (`session_id`,`run_id`,`action_id`,`kind`);
--> statement-breakpoint
CREATE INDEX `runtime_interaction_session_status_idx` ON `runtime_interaction` (`session_id`,`status`);
--> statement-breakpoint
CREATE INDEX `runtime_interaction_status_updated_idx` ON `runtime_interaction` (`status`,`time_updated`);
