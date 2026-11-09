-- 032_identity_link.sql — one woman, one lead (10 Nov 2026).
--   leads.merged_into_lead_id : this lead was a duplicate of another lead
--   (e.g. made from an app signup before she was linked). It is kept for
--   history but ignored by app-event matching.
-- Run once:
--   node script/runMigration.js migrations/032_identity_link.sql

ALTER TABLE leads
  ADD COLUMN merged_into_lead_id BIGINT NULL,
  ADD INDEX idx_merged_into (merged_into_lead_id);
