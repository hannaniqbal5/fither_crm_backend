-- 052_followup_switches.sql
--
-- Two admin switches for the GENERAL follow-ups (Layer 5, jobs/followupEngine.js).
-- Campaign follow-ups (Touch 2 / Touch 3) are separate and are NOT affected.
--
--   followups_enabled               1 = general follow-ups run, 0 = stopped
--                                   (no auto-sends AND no new rep drafts)
--   followups_skip_campaign_ladder  1 = never send a general follow-up to a
--                                   woman who is inside a campaign: queued for
--                                   Touch 1, waiting for Touch 2/3, or got a
--                                   campaign message in the last 7 days without
--                                   replying. Once she replies, normal rules apply.
--
-- Safe on a live DB: insert-only. The engine also seeds these on start.

INSERT IGNORE INTO layer_system_settings (setting_key, setting_value, description) VALUES
  ('followups_enabled', '1', 'General follow-ups on (1) or stopped (0). Campaign follow-ups are separate.'),
  ('followups_skip_campaign_ladder', '1', 'Skip women inside a campaign (queued, Touch 2/3 pending, or campaign message in last 7 days with no reply).');
