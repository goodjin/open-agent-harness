CREATE TABLE `session_task` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`title` text NOT NULL,
	`status` text NOT NULL,
	`current_revision_id` text,
	`source_type` text NOT NULL,
	`source_ref` text NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_task_session_unique_idx` ON `session_task` (`session_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_task_session_id_unique_idx` ON `session_task` (`session_id`,`id`);
--> statement-breakpoint
CREATE TABLE `task_revision` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`version` integer NOT NULL,
	`previous_id` text,
	`status` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`body_hash` text NOT NULL,
	`source_message_id` text,
	`reason` text,
	`workflow` text NOT NULL,
	`result` text,
	`result_source` text,
	`time_created` integer NOT NULL,
	`time_activated` integer,
	`time_completed` integer,
	`time_archived` integer,
	`archive_reason` text,
	FOREIGN KEY (`task_id`) REFERENCES `session_task`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `task_revision_previous_fk` FOREIGN KEY (`task_id`,`previous_id`) REFERENCES `task_revision`(`task_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_revision_task_version_unique_idx` ON `task_revision` (`task_id`,`version`);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_revision_task_id_unique_idx` ON `task_revision` (`task_id`,`id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_revision_one_active_idx` ON `task_revision` (`task_id`) WHERE `status` = 'active';
--> statement-breakpoint
CREATE TABLE `task_handoff` (
	`id` text PRIMARY KEY NOT NULL,
	`source_session_id` text NOT NULL,
	`source_task_id` text,
	`source_message_id` text,
	`target_session_id` text,
	`target_task_id` text,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`body_hash` text NOT NULL,
	`context_refs` text NOT NULL,
	`status` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`error` text,
	`time_created` integer NOT NULL,
	`time_confirmed` integer,
	`time_completed` integer,
	CONSTRAINT `task_handoff_target_pair_check` CHECK ((`target_session_id` IS NULL) = (`target_task_id` IS NULL)),
	FOREIGN KEY (`source_session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_task_id`) REFERENCES `session_task`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_task_id`) REFERENCES `session_task`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT `task_handoff_source_task_fk` FOREIGN KEY (`source_session_id`,`source_task_id`) REFERENCES `session_task`(`session_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `task_handoff_target_task_fk` FOREIGN KEY (`target_session_id`,`target_task_id`) REFERENCES `session_task`(`session_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_handoff_dedupe_unique_idx` ON `task_handoff` (`dedupe_key`);
--> statement-breakpoint
CREATE TRIGGER `session_task_current_insert`
BEFORE INSERT ON `session_task`
WHEN NEW.`current_revision_id` IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM `task_revision`
    WHERE `id` = NEW.`current_revision_id` AND `task_id` = NEW.`id`
  )
BEGIN
  SELECT RAISE(ABORT, 'session_task current revision mismatch');
END;
--> statement-breakpoint
CREATE TRIGGER `session_task_current_update`
BEFORE UPDATE OF `current_revision_id` ON `session_task`
WHEN NEW.`current_revision_id` IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM `task_revision`
    WHERE `id` = NEW.`current_revision_id` AND `task_id` = NEW.`id`
  )
BEGIN
  SELECT RAISE(ABORT, 'session_task current revision mismatch');
END;
--> statement-breakpoint
CREATE TRIGGER `task_revision_current_delete`
BEFORE DELETE ON `task_revision`
WHEN EXISTS (
  SELECT 1 FROM `session_task`
  WHERE `id` = OLD.`task_id` AND `current_revision_id` = OLD.`id`
)
BEGIN
  SELECT RAISE(ABORT, 'task revision is current');
END;
--> statement-breakpoint
CREATE TRIGGER `task_revision_current_task_update`
BEFORE UPDATE OF `task_id` ON `task_revision`
WHEN NEW.`task_id` != OLD.`task_id`
  AND EXISTS (
    SELECT 1 FROM `session_task`
    WHERE `id` = OLD.`task_id` AND `current_revision_id` = OLD.`id`
  )
BEGIN
  SELECT RAISE(ABORT, 'task revision is current');
END;
--> statement-breakpoint
CREATE TRIGGER `task_revision_id_immutable`
BEFORE UPDATE OF `id` ON `task_revision`
WHEN NEW.`id` != OLD.`id`
BEGIN
  SELECT RAISE(ABORT, 'task revision id is immutable');
END;
