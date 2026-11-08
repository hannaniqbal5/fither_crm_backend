-- 020_phase19c_scheduling.sql
-- Phase 19c — schedule campaigns to auto-start at a future time.
--
-- New flow:
--   Admin creates campaign + sets scheduled_start_at = '2026-05-20 09:00:00'
--   Campaign status flips to 'scheduled' (instead of 'running' immediately)
--   broadcastWorker tick() scans for scheduled campaigns where
--   scheduled_start_at <= NOW() and promotes them to 'running' (sets started_at).

ALTER TABLE campaigns
  ADD COLUMN scheduled_start_at DATETIME NULL
    COMMENT 'If set, campaign auto-flips from scheduled -> running at this time';

-- Update the status enum/comment to include the new state
-- (status is VARCHAR not ENUM, so just a doc comment refresh)
ALTER TABLE campaigns
  MODIFY COLUMN status VARCHAR(30) NOT NULL DEFAULT 'draft'
    COMMENT 'draft | scheduled | running | paused | aborted | completed | failed';

CREATE INDEX IF NOT EXISTS idx_campaigns_scheduled
  ON campaigns (status, scheduled_start_at);
