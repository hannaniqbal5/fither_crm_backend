-- 018_phase19a_dedup_rep_attribution.sql
-- Phase 19a — multi-campaign orchestration: dedup + sales rep attribution.
--
-- This migration adds the minimum schema needed to support:
--   1) Two campaigns can target overlapping groups WITHOUT double-sending
--      (handled at send-time via priority check, not at import-time)
--   2) Each campaign can have an assigned sales rep — new leads imported
--      from this campaign's group inherit that rep
--   3) New recipient status `deduped_by_higher_priority` for telemetry

ALTER TABLE campaigns
  ADD COLUMN assigned_rep_id INT NULL
    COMMENT 'Sales rep who owns replies + new leads from this campaign';

-- Extend the recipient status enum.
-- Original states: queued, sending, sent, replied, failed, opted_out.
-- New: deduped_by_higher_priority (skipped because same lead got message
--      from a higher-scoring campaign on the same WA account).
ALTER TABLE campaign_recipients
  MODIFY COLUMN status VARCHAR(40) NOT NULL DEFAULT 'queued'
    COMMENT 'queued | sending | sent | replied | failed | opted_out | deduped_by_higher_priority';

-- Helpful composite index for the dedup query at send-time:
-- "give me all recipient rows for this lead across active campaigns"
CREATE INDEX IF NOT EXISTS idx_cr_lead_status
  ON campaign_recipients (lead_id, status);

-- Index for fast assigned_rep lookup
CREATE INDEX IF NOT EXISTS idx_campaigns_rep
  ON campaigns (assigned_rep_id);
