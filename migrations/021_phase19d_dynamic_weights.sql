-- 021_phase19d_dynamic_weights.sql
-- Phase 19d — performance-based dynamic rate reallocation.
--
-- Every 30 min the campaignWeightsJob computes a health_score per running
-- campaign and converts those scores into send weights (0–1, summing to 1
-- across all running campaigns on the same WA account, clamped between
-- 25% min and 75% max).
--
-- The broadcastWorker then uses weighted random selection instead of
-- sequential pick — so a tick is more likely to fire from a higher-scoring
-- campaign.
--
-- Score formula (recomputed every 30 min, only after min_sample sends):
--   score = (reply_rate × 100) − (optout_rate × 50) − (fail_rate × 30)
--   Examples:
--     20% reply, 0% optout, 0% fail → score = 20
--      5% reply, 1% optout, 1% fail → score = 4.2
--      0% reply, 0% optout, 0% fail (cold start) → score = 0 → gets 25% floor

ALTER TABLE campaigns
  ADD COLUMN health_score DECIMAL(8,3) NULL
    COMMENT 'Performance score: reply×100 - optout×50 - fail×30 (computed every 30 min)',
  ADD COLUMN current_weight DECIMAL(5,4) NULL DEFAULT NULL
    COMMENT 'Send weight 0..1 within its WA account group (sums to 1.0 across siblings)',
  ADD COLUMN weights_recomputed_at DATETIME NULL
    COMMENT 'Last time campaignWeightsJob updated this row';

-- Audit log of weight changes so we can show "Campaign X went 40% → 65% on 5/19 4 PM"
CREATE TABLE IF NOT EXISTS campaign_weight_history (
  id                BIGINT NOT NULL AUTO_INCREMENT,
  campaign_id       CHAR(36) NOT NULL,
  whatsapp_account_id INT NULL,
  health_score      DECIMAL(8,3) NULL,
  weight_before     DECIMAL(5,4) NULL,
  weight_after      DECIMAL(5,4) NULL,
  reply_rate        DECIMAL(6,3) NULL,
  optout_rate       DECIMAL(6,3) NULL,
  fail_rate         DECIMAL(6,3) NULL,
  sample_size       INT NULL,
  recomputed_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  INDEX idx_campaign (campaign_id, recomputed_at),
  INDEX idx_acct (whatsapp_account_id, recomputed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Tunable settings (admin can override these via Layer System tab)
INSERT IGNORE INTO layer_system_settings (setting_key, setting_value, description) VALUES
  ('weights_min_pct',           '25',  'Floor weight per campaign (% of pool)'),
  ('weights_max_pct',           '75',  'Ceiling weight per campaign (% of pool)'),
  ('weights_recompute_min',     '30',  'Recompute weights every N minutes'),
  ('weights_min_sample',        '20',  'Need this many sends before scoring a campaign'),
  ('weights_cold_start_weight', '50',  'Default weight % for new campaigns with no sample yet');
