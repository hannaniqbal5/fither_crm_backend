-- 047_campaign_ab_test.sql (Nov 2026)
-- Two campaigns built on the same audience to compare one change (first use:
-- Fizza on vs Fizza off). Both rows share ab_group_id; ab_arm is 0 or 1.
-- A woman's side is fixed by a hash of her lead id, so importing the same
-- group or sheet into either campaign fills both halves and nobody gets both.
ALTER TABLE campaigns
  ADD COLUMN ab_group_id CHAR(36) NULL,
  ADD COLUMN ab_arm      TINYINT  NULL,
  ADD INDEX idx_ab_group (ab_group_id);
