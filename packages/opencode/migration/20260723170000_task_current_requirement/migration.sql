CREATE TABLE `__task_current_requirement_guard` (
	`ok` integer NOT NULL,
	CONSTRAINT `task_current_requirement_guard_check` CHECK (`ok` = 1)
);
--> statement-breakpoint
INSERT INTO `__task_current_requirement_guard` (`ok`)
SELECT 0
FROM `session_task`
WHERE `requirement_id` IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM `task_requirement`
    WHERE `id` = `session_task`.`requirement_id`
      AND `task_id` = `session_task`.`id`
  )
LIMIT 1;
--> statement-breakpoint
DROP TABLE `__task_current_requirement_guard`;
--> statement-breakpoint
CREATE TRIGGER `session_task_requirement_insert`
BEFORE INSERT ON `session_task`
WHEN NEW.`requirement_id` IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM `task_requirement`
    WHERE `id` = NEW.`requirement_id` AND `task_id` = NEW.`id`
  )
BEGIN
  SELECT RAISE(ABORT, 'session_task current requirement mismatch');
END;
--> statement-breakpoint
CREATE TRIGGER `session_task_requirement_update`
BEFORE UPDATE OF `id`, `requirement_id` ON `session_task`
WHEN NEW.`requirement_id` IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM `task_requirement`
    WHERE `id` = NEW.`requirement_id` AND `task_id` = NEW.`id`
  )
BEGIN
  SELECT RAISE(ABORT, 'session_task current requirement mismatch');
END;
--> statement-breakpoint
CREATE TRIGGER `task_requirement_current_delete`
BEFORE DELETE ON `task_requirement`
WHEN EXISTS (
  SELECT 1 FROM `session_task`
  WHERE `id` = OLD.`task_id` AND `requirement_id` = OLD.`id`
)
BEGIN
  SELECT RAISE(ABORT, 'task requirement is current');
END;
--> statement-breakpoint
CREATE TRIGGER `task_requirement_identity_immutable`
BEFORE UPDATE OF `id`, `task_id` ON `task_requirement`
WHEN NEW.`id` != OLD.`id` OR NEW.`task_id` != OLD.`task_id`
BEGIN
  SELECT RAISE(ABORT, 'task requirement identity is immutable');
END;
