-- ──────────────────────────────────────────────────────────────
-- 024_campaign_nurture.sql
--
-- Non-responder nurture sequence + frequency/safety controls.
-- Implements the 9 gaps in the campaign follow-up flow:
--   #1 reliable reply detection (uses messages table at send time)
--   #2 send-time re-validation
--   #3 scheduled_at / next_step_at gating
--   #4 step state + per-step analytics (campaign_step_log)
--   #5 per-step content (campaigns.nurture_steps JSON)
--   #6 30-day lifetime frequency cap (campaign_lifetime_cap_30d)
--   #7 delivery-signal targeting (campaign_recipients.delivered_at/read_at)
--   #8 per-step opt-out circuit breaker (nurture_paused + settings)
--   #9 conservative defaults (only-delivered, max 2 steps, kill switch)
-- ──────────────────────────────────────────────────────────────

-- 1. Campaign-level nurture config
ALTER TABLE campaigns
  ADD COLUMN nurture_enabled        TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN nurture_steps          JSON       NULL
      COMMENT 'Array (max 2) of {body, media_url, delay_days} for follow-up steps',
  ADD COLUMN nurture_only_delivered TINYINT(1) NOT NULL DEFAULT 1
      COMMENT 'Only nurture numbers the original was delivered/read to (#7,#9)',
  ADD COLUMN nurture_paused         TINYINT(1) NOT NULL DEFAULT 0
      COMMENT 'Circuit-breaker pause for the nurture sequence (#8)';

-- 2. Per-recipient step state
ALTER TABLE campaign_recipients
  ADD COLUMN step              INT      NOT NULL DEFAULT 0
      COMMENT 'Nurture steps sent so far (0 = original only)',
  ADD COLUMN next_step_at      DATETIME NULL
      COMMENT 'When the next nurture step is due (#3); NULL = sequence finished/stopped',
  ADD COLUMN last_step_sent_at DATETIME NULL;

CREATE INDEX idx_cr_next_step ON campaign_recipients (next_step_at);

-- 3. Per-step analytics log (#4)
CREATE TABLE IF NOT EXISTS campaign_step_log (
  id            BIGINT       NOT NULL AUTO_INCREMENT,
  campaign_id   CHAR(36)     NOT NULL,
  lead_id       BIGINT       NOT NULL,
  step          INT          NOT NULL COMMENT '0 = original, 1..N = nurture step',
  message_id    VARCHAR(120) NULL,
  sent_at       DATETIME     NOT NULL DEFAULT NOW(),
  replied       TINYINT(1)   NOT NULL DEFAULT 0,
  replied_at    DATETIME     NULL,
  opted_out     TINYINT(1)   NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  INDEX idx_csl_campaign_step (campaign_id, step),
  INDEX idx_csl_lead (lead_id),
  INDEX idx_csl_sent (sent_at),
  CONSTRAINT fk_csl_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns(campaign_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 4. Settings: frequency caps + global kill switch + nurture opt-out breaker
INSERT INTO layer_system_settings (setting_key, setting_value) VALUES
  ('campaign_lifetime_cap_30d', '4'),   -- max campaign messages per number / 30 days (#6)
  ('nurture_global_enabled',    '1'),   -- master kill switch (#9)
  ('nurture_optout_pause_pct',  '8'),   -- pause nurture if opt-out rate exceeds this % (#8)
  ('nurture_optout_min_sample', '20')   -- ...once at least this many nurture sends exist
ON DUPLICATE KEY UPDATE setting_value = setting_value;
