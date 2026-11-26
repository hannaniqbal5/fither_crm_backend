-- 045_campaign_ramp.sql
-- Slow start per campaign (Nov 2026): ramp_caps = "100,200,350,400" means
-- 100 sends on the campaign's 1st sending day, 200 on the 2nd, 350 on the
-- 3rd and 400 every day after. Empty = the fixed daily_cap as before.
-- Days are counted by days the campaign actually SENT, so a paused day
-- doesn't skip a step. The per-number shared cap still applies on top.
ALTER TABLE campaigns
  ADD COLUMN ramp_caps VARCHAR(200) NULL AFTER daily_cap;
