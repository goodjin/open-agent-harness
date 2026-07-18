ALTER TABLE `task_confirmation` ADD `owner_token` text;
--> statement-breakpoint
ALTER TABLE `task_confirmation` ADD `generation` integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE `task_confirmation` ADD `lease_until` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `task_confirmation` ADD `snapshot` text;
--> statement-breakpoint
ALTER TABLE `task_confirmation` ADD `snapshot_hash` text;
--> statement-breakpoint
ALTER TABLE `task_confirmation` ADD `result` text;
--> statement-breakpoint
CREATE TEMP TABLE `assignment_source_unique_audit` (`ok` integer NOT NULL CHECK (`ok` = 1));
--> statement-breakpoint
INSERT INTO `assignment_source_unique_audit`
SELECT CASE WHEN EXISTS (
	SELECT 1 FROM `assignment`
	WHERE `source_session_id` IS NOT NULL AND `source_run_id` IS NOT NULL AND `source_action_id` IS NOT NULL
	GROUP BY `source_session_id`, `source_run_id`, `source_action_id`
	HAVING count(*) > 1
) THEN 0 ELSE 1 END;
--> statement-breakpoint
DROP TABLE `assignment_source_unique_audit`;
--> statement-breakpoint
DROP INDEX `assignment_source_idx`;
--> statement-breakpoint
CREATE UNIQUE INDEX `assignment_source_unique_idx` ON `assignment` (`source_session_id`,`source_run_id`,`source_action_id`);
