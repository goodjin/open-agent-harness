CREATE TABLE `session_log` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`message_id` text,
	`part_id` text,
	`level` text NOT NULL,
	`type` text NOT NULL,
	`data` text NOT NULL,
	`time_created` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `session_log_session_time_id_idx` ON `session_log` (`session_id`,`time_created`,`id`);
--> statement-breakpoint
CREATE INDEX `session_log_time_idx` ON `session_log` (`time_created`);
