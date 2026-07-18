ALTER TABLE `task_revision` ADD `terminal_status` text;
--> statement-breakpoint
ALTER TABLE `task_revision` ADD `stopped_child_count` integer;
--> statement-breakpoint
ALTER TABLE `task_revision` ADD `result_status` text;
--> statement-breakpoint
UPDATE `task_revision`
SET `result_status` = CASE
  WHEN `result_source` = 'fallback_summary' THEN 'partial'
  WHEN `result_source` = 'protocol' THEN 'completed'
END
WHERE `status` = 'archived'
  AND `result_status` IS NULL
  AND `result` IS NOT NULL
  AND length(trim(`result`)) > 0
  AND `result_source` IN ('protocol', 'fallback_summary');
