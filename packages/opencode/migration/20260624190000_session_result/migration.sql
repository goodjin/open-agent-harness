CREATE TABLE `session_result` (
  `id` text PRIMARY KEY NOT NULL,
  `carrier` text NOT NULL,
  `status` text NOT NULL,
  `satisfying` integer NOT NULL,
  `session_id` text NOT NULL,
  `parent_session_id` text,
  `child_session_id` text,
  `run_id` text,
  `action_id` text,
  `target_action_id` text,
  `raw_ref` text NOT NULL,
  `summary` text,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `session_result_session_idx` ON `session_result` (`session_id`);
--> statement-breakpoint
CREATE INDEX `session_result_parent_child_idx` ON `session_result` (`parent_session_id`,`child_session_id`);
--> statement-breakpoint
CREATE INDEX `session_result_run_action_idx` ON `session_result` (`run_id`,`action_id`);
