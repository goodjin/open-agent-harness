CREATE TABLE `assignment` (
  `id` text PRIMARY KEY NOT NULL,
  `parent_id` text,
  `session_id` text NOT NULL,
  `source_type` text NOT NULL,
  `source_session_id` text,
  `source_message_id` text,
  `source_run_id` text,
  `source_action_id` text,
  `target` text NOT NULL,
  `title` text NOT NULL,
  `status` text NOT NULL,
  `content_ref` text NOT NULL,
  `content_hash` text NOT NULL,
  `content_version` integer NOT NULL,
  `result_ref` text,
  `result_status` text,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `assignment_session_status_idx` ON `assignment` (`session_id`,`status`);
--> statement-breakpoint
CREATE INDEX `assignment_parent_idx` ON `assignment` (`parent_id`);
--> statement-breakpoint
CREATE INDEX `assignment_source_idx` ON `assignment` (`source_session_id`,`source_run_id`,`source_action_id`);
