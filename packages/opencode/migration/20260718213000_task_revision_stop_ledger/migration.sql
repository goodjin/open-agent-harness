UPDATE `task_revision`
SET `result_status` = NULL
WHERE `status` = 'archived'
  AND `result_source` = 'action_result'
  AND `result_status` = 'completed';
--> statement-breakpoint
CREATE TABLE `task_revision_stop` (
  `revision_id` text NOT NULL,
  `child_session_id` text NOT NULL,
  `run_id` text NOT NULL,
  `action_id` text NOT NULL,
  `state` text NOT NULL,
  `reason` text NOT NULL,
  `time_created` integer NOT NULL,
  `time_applied` integer,
  PRIMARY KEY(`revision_id`, `child_session_id`),
  FOREIGN KEY (`revision_id`) REFERENCES `task_revision`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `task_revision_stop_state_idx` ON `task_revision_stop` (`revision_id`,`state`);
