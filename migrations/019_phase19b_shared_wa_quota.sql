-- 019_phase19b_shared_wa_quota.sql
-- Phase 19b — shared daily quota across all campaigns on the same WA account.
--
-- Previously each campaign had its own daily_cap.  When 2+ campaigns ran on the
-- same WA account, they each thought they had a full budget — combined burst
-- exceeded WhatsApp's anti-spam threshold.
--
-- New model:
--   whatsapp_accounts.shared_daily_cap = HARD CEILING for the whole account
--   campaigns.daily_cap                = SOFT CAP (per-campaign limit)
--   Worker enforces BOTH. Sends if (account_sent_today < shared_cap) AND
--   (campaign_sent_today < campaign_daily_cap).

ALTER TABLE whatsapp_accounts
  ADD COLUMN shared_daily_cap INT NOT NULL DEFAULT 400
    COMMENT 'Hard ceiling for total sends across all campaigns on this WA account per day';

-- Optional: a setting key to globally pause the account if needed
ALTER TABLE whatsapp_accounts
  ADD COLUMN paused_until DATETIME NULL
    COMMENT 'If set in future, worker skips all campaigns on this account';

-- Index for fast quota lookups by date + account
CREATE INDEX IF NOT EXISTS idx_quota_acc_date
  ON wa_account_daily_quota (whatsapp_account_id, quota_date);

-- Optional override per WA account / settings table backup
INSERT IGNORE INTO layer_system_settings (setting_key, setting_value, description) VALUES
  ('campaign_shared_quota_warn_pct', '80', 'Push admin alert when shared daily cap usage exceeds this %');
