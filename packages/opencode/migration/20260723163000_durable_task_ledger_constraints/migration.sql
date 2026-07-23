ALTER TABLE `task_event` RENAME TO `__old_task_event`;
--> statement-breakpoint
ALTER TABLE `task_resource` RENAME TO `__old_task_resource`;
--> statement-breakpoint
ALTER TABLE `task_command` RENAME TO `__old_task_command`;
--> statement-breakpoint
ALTER TABLE `task_revision_stop` RENAME TO `__old_task_revision_stop`;
--> statement-breakpoint
ALTER TABLE `task_revision` RENAME TO `__old_task_revision`;
--> statement-breakpoint
ALTER TABLE `task_requirement` RENAME TO `__old_task_requirement`;
--> statement-breakpoint
CREATE TABLE `task_requirement` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`version` integer NOT NULL,
	`source_refs` text NOT NULL,
	`body_ref` text NOT NULL,
	`body_hash` text NOT NULL,
	`constraints` text NOT NULL,
	`acceptance` text NOT NULL,
	`created_by` text NOT NULL,
	`confirmed_at` integer,
	`supersedes_id` text,
	`time_created` integer NOT NULL,
	CONSTRAINT `task_requirement_body_hash_check` CHECK (length(`body_hash`) = 64),
	FOREIGN KEY (`task_id`) REFERENCES `session_task`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `task_requirement_supersedes_fk` FOREIGN KEY (`task_id`,`supersedes_id`) REFERENCES `task_requirement`(`task_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `__new_task_requirement_task_version_idx` ON `task_requirement` (`task_id`,`version`);
--> statement-breakpoint
CREATE UNIQUE INDEX `__new_task_requirement_task_id_idx` ON `task_requirement` (`task_id`,`id`);
--> statement-breakpoint
INSERT INTO `task_requirement`
SELECT `id`, `task_id`, `version`, `source_refs`, `body_ref`, `body_hash`, `constraints`, `acceptance`, `created_by`, `confirmed_at`, `supersedes_id`, `time_created`
FROM `__old_task_requirement`;
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
	`terminal_status` text,
	`stopped_child_count` integer,
	`result_status` text,
	`requirement_id` text,
	`spec_ref` text,
	`design_ref` text,
	`plan_ref` text,
	`graph_id` text,
	`schema_version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `session_task`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `task_revision_previous_fk` FOREIGN KEY (`task_id`,`previous_id`) REFERENCES `task_revision`(`task_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `task_revision_requirement_fk` FOREIGN KEY (`task_id`,`requirement_id`) REFERENCES `task_requirement`(`task_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `__new_task_revision_task_version_idx` ON `task_revision` (`task_id`,`version`);
--> statement-breakpoint
CREATE UNIQUE INDEX `__new_task_revision_task_id_idx` ON `task_revision` (`task_id`,`id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `__new_task_revision_one_active_idx` ON `task_revision` (`task_id`) WHERE `status` = 'active';
--> statement-breakpoint
INSERT INTO `task_revision`
SELECT `id`, `task_id`, `version`, `previous_id`, `status`, `title`, `body`, `body_hash`, `source_message_id`, `reason`, `workflow`, `result`, `result_source`, `time_created`, `time_activated`, `time_completed`, `time_archived`, `archive_reason`, `terminal_status`, `stopped_child_count`, `result_status`, `requirement_id`, `spec_ref`, `design_ref`, `plan_ref`, `graph_id`, `schema_version`
FROM `__old_task_revision`;
--> statement-breakpoint
CREATE TABLE `task_command` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text,
	`kind` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`status` text NOT NULL,
	`result_ref` text,
	`time_created` integer NOT NULL,
	`time_applied` integer,
	FOREIGN KEY (`task_id`) REFERENCES `session_task`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `__new_task_command_idempotency_idx` ON `task_command` (`idempotency_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `__new_task_command_task_id_idx` ON `task_command` (`task_id`,`id`);
--> statement-breakpoint
INSERT INTO `task_command`
SELECT `id`, `task_id`, `kind`, `idempotency_key`, `status`, `result_ref`, `time_created`, `time_applied`
FROM `__old_task_command`;
--> statement-breakpoint
CREATE TABLE `task_resource` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`revision_id` text,
	`kind` text NOT NULL,
	`uri` text NOT NULL,
	`hash` text NOT NULL,
	`size` integer NOT NULL,
	`summary` text,
	`producer_type` text NOT NULL,
	`producer_id` text NOT NULL,
	`visibility` text NOT NULL,
	`lifecycle` text NOT NULL,
	`time_created` integer NOT NULL,
	CONSTRAINT `task_resource_hash_check` CHECK (length(`hash`) = 64),
	CONSTRAINT `task_resource_size_check` CHECK (`size` >= 0),
	FOREIGN KEY (`task_id`) REFERENCES `session_task`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `task_resource_revision_fk` FOREIGN KEY (`task_id`,`revision_id`) REFERENCES `task_revision`(`task_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `__new_task_resource_identity_idx` ON `task_resource` (`task_id`,`kind`,`hash`,`uri`);
--> statement-breakpoint
INSERT INTO `task_resource`
SELECT `id`, `task_id`, `revision_id`, `kind`, `uri`, `hash`, `size`, `summary`, `producer_type`, `producer_id`, `visibility`, `lifecycle`, `time_created`
FROM `__old_task_resource`;
--> statement-breakpoint
CREATE TABLE `task_event` (
	`task_id` text NOT NULL,
	`seq` integer NOT NULL,
	`id` text NOT NULL,
	`type` text NOT NULL,
	`revision_id` text,
	`command_id` text,
	`data` text NOT NULL,
	`resource_refs` text NOT NULL,
	`time_created` integer NOT NULL,
	PRIMARY KEY(`task_id`, `seq`),
	FOREIGN KEY (`task_id`) REFERENCES `session_task`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `task_event_revision_fk` FOREIGN KEY (`task_id`,`revision_id`) REFERENCES `task_revision`(`task_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT `task_event_command_fk` FOREIGN KEY (`task_id`,`command_id`) REFERENCES `task_command`(`task_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `__new_task_event_id_idx` ON `task_event` (`id`);
--> statement-breakpoint
INSERT INTO `task_event`
SELECT `task_id`, `seq`, `id`, `type`, `revision_id`, `command_id`, `data`, `resource_refs`, `time_created`
FROM `__old_task_event`;
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
INSERT INTO `task_revision_stop`
SELECT `revision_id`, `child_session_id`, `run_id`, `action_id`, `state`, `reason`, `time_created`, `time_applied`
FROM `__old_task_revision_stop`;
--> statement-breakpoint
DROP TABLE `__old_task_event`;
--> statement-breakpoint
DROP TABLE `__old_task_resource`;
--> statement-breakpoint
DROP TABLE `__old_task_revision_stop`;
--> statement-breakpoint
DROP TABLE `__old_task_revision`;
--> statement-breakpoint
DROP TABLE `__old_task_command`;
--> statement-breakpoint
DROP TABLE `__old_task_requirement`;
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
--> statement-breakpoint
CREATE UNIQUE INDEX `task_requirement_task_version_unique_idx` ON `task_requirement` (`task_id`,`version`);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_requirement_task_id_unique_idx` ON `task_requirement` (`task_id`,`id`);
--> statement-breakpoint
CREATE INDEX `task_requirement_task_created_idx` ON `task_requirement` (`task_id`,`time_created`);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_revision_task_version_unique_idx` ON `task_revision` (`task_id`,`version`);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_revision_task_id_unique_idx` ON `task_revision` (`task_id`,`id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_revision_one_active_idx` ON `task_revision` (`task_id`) WHERE `status` = 'active';
--> statement-breakpoint
CREATE UNIQUE INDEX `task_command_idempotency_unique_idx` ON `task_command` (`idempotency_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_command_task_id_unique_idx` ON `task_command` (`task_id`,`id`);
--> statement-breakpoint
CREATE INDEX `task_command_task_created_idx` ON `task_command` (`task_id`,`time_created`);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_resource_identity_unique_idx` ON `task_resource` (`task_id`,`kind`,`hash`,`uri`);
--> statement-breakpoint
CREATE INDEX `task_resource_revision_idx` ON `task_resource` (`revision_id`);
--> statement-breakpoint
CREATE INDEX `task_resource_task_kind_idx` ON `task_resource` (`task_id`,`kind`);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_event_id_unique_idx` ON `task_event` (`id`);
--> statement-breakpoint
CREATE INDEX `task_event_task_type_idx` ON `task_event` (`task_id`,`type`);
--> statement-breakpoint
CREATE INDEX `task_event_revision_idx` ON `task_event` (`revision_id`);
--> statement-breakpoint
CREATE INDEX `task_revision_stop_state_idx` ON `task_revision_stop` (`revision_id`,`state`);
--> statement-breakpoint
DROP INDEX `__new_task_requirement_task_version_idx`;
--> statement-breakpoint
DROP INDEX `__new_task_requirement_task_id_idx`;
--> statement-breakpoint
DROP INDEX `__new_task_revision_task_version_idx`;
--> statement-breakpoint
DROP INDEX `__new_task_revision_task_id_idx`;
--> statement-breakpoint
DROP INDEX `__new_task_revision_one_active_idx`;
--> statement-breakpoint
DROP INDEX `__new_task_command_idempotency_idx`;
--> statement-breakpoint
DROP INDEX `__new_task_command_task_id_idx`;
--> statement-breakpoint
DROP INDEX `__new_task_resource_identity_idx`;
--> statement-breakpoint
DROP INDEX `__new_task_event_id_idx`;
