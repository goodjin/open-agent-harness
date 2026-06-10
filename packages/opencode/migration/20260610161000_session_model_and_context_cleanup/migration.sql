ALTER TABLE `session` ADD `model` text;
--> statement-breakpoint
UPDATE `session`
SET `agent` = json_extract(`dsl_context`, '$.session_tree.agent')
WHERE `agent` IS NULL
  AND json_type(`dsl_context`, '$.session_tree.agent') = 'text';
--> statement-breakpoint
UPDATE `session`
SET `model` = json_extract(`dsl_context`, '$.session_tree.model')
WHERE `model` IS NULL
  AND json_type(`dsl_context`, '$.session_tree.model') = 'object';
--> statement-breakpoint
UPDATE `session`
SET `dsl_context` = json_remove(`dsl_context`, '$.session_tree')
WHERE json_type(`dsl_context`, '$.session_tree') IS NOT NULL;
