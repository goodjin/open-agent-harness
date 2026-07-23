ALTER TABLE `session_task` ADD `requirement_id` text;
--> statement-breakpoint
ALTER TABLE `session_task` ADD `status_reason` text;
--> statement-breakpoint
ALTER TABLE `session_task` ADD `last_event_seq` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `session_task` ADD `checkpoint_id` text;
--> statement-breakpoint
ALTER TABLE `session_task` ADD `schema_version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE `task_revision` ADD `requirement_id` text;
--> statement-breakpoint
ALTER TABLE `task_revision` ADD `spec_ref` text;
--> statement-breakpoint
ALTER TABLE `task_revision` ADD `design_ref` text;
--> statement-breakpoint
ALTER TABLE `task_revision` ADD `plan_ref` text;
--> statement-breakpoint
ALTER TABLE `task_revision` ADD `graph_id` text;
--> statement-breakpoint
ALTER TABLE `task_revision` ADD `schema_version` integer DEFAULT 1 NOT NULL;
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
	CONSTRAINT `task_requirement_supersedes_fk` FOREIGN KEY (`task_id`,`supersedes_id`) REFERENCES `task_requirement`(`task_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_requirement_task_version_unique_idx` ON `task_requirement` (`task_id`,`version`);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_requirement_task_id_unique_idx` ON `task_requirement` (`task_id`,`id`);
--> statement-breakpoint
CREATE INDEX `task_requirement_task_created_idx` ON `task_requirement` (`task_id`,`time_created`);
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
	FOREIGN KEY (`revision_id`) REFERENCES `task_revision`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_resource_identity_unique_idx` ON `task_resource` (`task_id`,`kind`,`hash`,`uri`);
--> statement-breakpoint
CREATE INDEX `task_resource_revision_idx` ON `task_resource` (`revision_id`);
--> statement-breakpoint
CREATE INDEX `task_resource_task_kind_idx` ON `task_resource` (`task_id`,`kind`);
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
CREATE UNIQUE INDEX `task_command_idempotency_unique_idx` ON `task_command` (`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `task_command_task_created_idx` ON `task_command` (`task_id`,`time_created`);
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
	FOREIGN KEY (`revision_id`) REFERENCES `task_revision`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`command_id`) REFERENCES `task_command`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_event_id_unique_idx` ON `task_event` (`id`);
--> statement-breakpoint
CREATE INDEX `task_event_task_type_idx` ON `task_event` (`task_id`,`type`);
--> statement-breakpoint
CREATE INDEX `task_event_revision_idx` ON `task_event` (`revision_id`);
