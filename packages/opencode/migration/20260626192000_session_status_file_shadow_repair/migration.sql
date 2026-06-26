UPDATE `session`
SET `status` = 'idle',
    `status_source` = 'recovery',
    `status_updated_at` = `time_updated`
WHERE `status_class` = 'active'
  AND `status` IN ('queued', 'starting', 'running', 'aborting')
  AND `status_detail` IS NULL;
