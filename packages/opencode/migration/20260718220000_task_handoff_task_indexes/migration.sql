CREATE INDEX `task_handoff_source_task_idx` ON `task_handoff` (`source_task_id`);
--> statement-breakpoint
CREATE INDEX `task_handoff_target_task_idx` ON `task_handoff` (`target_task_id`);
