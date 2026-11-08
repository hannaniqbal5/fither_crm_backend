-- 029_app_events_reliability.sql
-- App → CRM webhook reliability (9 Nov 2026).
--   occurred_at : when the event happened in the app (not when the CRM got it).
--                 Used to ignore an older subscription/payment event that
--                 arrives after a newer one (retries can reorder delivery).
-- Safe to run once. Run with:
--   node script/runMigration.js migrations/029_app_events_reliability.sql

ALTER TABLE app_events
  ADD COLUMN occurred_at DATETIME(3) NULL COMMENT 'When it happened in the app' AFTER payload,
  ADD INDEX idx_user_occurred (app_user_id, occurred_at);
