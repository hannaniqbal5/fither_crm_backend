-- 003_template_active.sql
-- Adds an on/off switch to message templates so a template can be
-- disabled without deleting it (mirrors automation_rules.active).
--
-- Safe to run multiple times: the ADD COLUMN is guarded so re-runs no-op.

-- message_templates.active  (1 = usable, 0 = disabled)
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'message_templates'
    AND COLUMN_NAME  = 'active'
);

SET @ddl := IF(@col_exists = 0,
  'ALTER TABLE message_templates ADD COLUMN active TINYINT(1) NOT NULL DEFAULT 1 AFTER media_url',
  'SELECT "message_templates.active already exists — skipping"'
);

PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
