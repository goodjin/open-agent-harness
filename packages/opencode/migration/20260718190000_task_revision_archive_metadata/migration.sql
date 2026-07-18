ALTER TABLE `task_revision` ADD `terminal_status` text;
--> statement-breakpoint
ALTER TABLE `task_revision` ADD `stopped_child_count` integer;
--> statement-breakpoint
ALTER TABLE `task_revision` ADD `result_status` text;
