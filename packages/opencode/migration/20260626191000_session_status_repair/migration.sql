CREATE TABLE IF NOT EXISTS `session_event_outbox` (
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
CREATE INDEX IF NOT EXISTS `session_event_outbox_session_idx` ON `session_event_outbox` (`session_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `session_event_outbox_status_idx` ON `session_event_outbox` (`status`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `session_event_outbox_dedupe_key_idx` ON `session_event_outbox` (`dedupe_key`);
--> statement-breakpoint
UPDATE `session`
SET `status` = 'idle',
    `status_source` = 'recovery',
    `status_updated_at` = `time_updated`
WHERE `status_class` = 'active'
  AND `status` = 'active'
  AND `status_detail` IS NULL;
