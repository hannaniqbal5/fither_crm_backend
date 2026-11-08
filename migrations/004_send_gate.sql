-- 004_send_gate.sql
-- Unified proactive-send governance ("send gate").
--
--   * proactive_send_log : one row per ACTUAL proactive send (campaign,
--     follow-up auto-send, automation). Used to enforce a combined per-contact
--     frequency budget across all proactive senders.
--   * layer_system_settings rows : tunable thresholds + gate_mode.
--
-- The gate ships in MONITOR mode: it logs what it WOULD block but blocks
-- nothing until gate_mode = 'enforce'. Flip it once the numbers look right.
--
-- Safe to run multiple times.

CREATE TABLE IF NOT EXISTS proactive_send_log (
  id                  BIGINT       NOT NULL AUTO_INCREMENT,
  lead_id             BIGINT       NOT NULL,
  whatsapp_account_id INT          NULL,
  source              VARCHAR(40)  NOT NULL,           -- 'campaign' | 'followup' | 'automation'
  template_key        VARCHAR(120) NULL,
  created_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_psl_lead    (lead_id, created_at),
  KEY idx_psl_account (whatsapp_account_id, created_at)
);

-- Tunable settings (no-op if they already exist).
INSERT IGNORE INTO layer_system_settings (setting_key, setting_value) VALUES
  ('gate_mode',                      'monitor'),  -- 'monitor' | 'enforce'
  ('proactive_max_per_contact_day',  '1'),
  ('proactive_max_per_contact_7d',   '3'),
  ('proactive_min_gap_hours',        '24'),
  ('proactive_stop_after_no_reply',  '2'),
  ('proactive_quiet_start',          '9'),        -- PKT hour, inclusive
  ('proactive_quiet_end',            '21'),       -- PKT hour, exclusive
  ('number_total_daily_softcap',     '800');      -- reactive + proactive combined, per number/day
