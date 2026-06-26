ALTER TABLE `session` ADD `status_class` text NOT NULL DEFAULT 'active';
--> statement-breakpoint
ALTER TABLE `session` ADD `status` text NOT NULL DEFAULT 'idle';
--> statement-breakpoint
ALTER TABLE `session` ADD `status_message` text;
--> statement-breakpoint
ALTER TABLE `session` ADD `status_recoverable` integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE `session` ADD `status_updated_at` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `session` ADD `status_source` text NOT NULL DEFAULT 'runtime';
--> statement-breakpoint
ALTER TABLE `session` ADD `status_detail` text;
--> statement-breakpoint
UPDATE `session` SET `status_updated_at` = `time_updated` WHERE `status_updated_at` = 0;
--> statement-breakpoint
DELETE FROM `session_result`
WHERE `rowid` NOT IN (
  SELECT max(`rowid`)
  FROM `session_result`
  WHERE `parent_session_id` IS NOT NULL
    AND `child_session_id` IS NOT NULL
    AND `run_id` IS NOT NULL
    AND `action_id` IS NOT NULL
  GROUP BY `parent_session_id`, `child_session_id`, `run_id`, `action_id`
)
AND `parent_session_id` IS NOT NULL
AND `child_session_id` IS NOT NULL
AND `run_id` IS NOT NULL
AND `action_id` IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `session_result_parent_child_run_action_unique_idx` ON `session_result` (`parent_session_id`,`child_session_id`,`run_id`,`action_id`);
--> statement-breakpoint
CREATE TABLE `session_event_outbox` (
  `id` text PRIMARY KEY NOT NULL,
  `session_id` text NOT NULL,
  `target_session_id` text,
  `kind` text NOT NULL,
  `dedupe_key` text NOT NULL,
  `status` text NOT NULL,
  `payload` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `delivered_at` integer,
  `acked_at` integer,
  `error` text,
  FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `session_event_outbox_session_idx` ON `session_event_outbox` (`session_id`);
--> statement-breakpoint
CREATE INDEX `session_event_outbox_status_idx` ON `session_event_outbox` (`status`);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_event_outbox_dedupe_key_idx` ON `session_event_outbox` (`dedupe_key`);
