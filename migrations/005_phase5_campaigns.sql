-- =============================================================
-- PHASE 5 MIGRATION — Marketing Campaigns + Group Import
-- Run AFTER 004_phase4_multichannel.sql
-- mysql -u root -p crm < migrations/005_phase5_campaigns.sql
-- =============================================================

-- ──────────────────────────────────────────────────────────────
-- 1. campaigns — campaign definitions + execution state
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS campaigns (
  campaign_id      CHAR(36)     NOT NULL,
  name             VARCHAR(160) NOT NULL,
  description      TEXT         NULL,
  channel          ENUM('whatsapp','instagram','facebook') NOT NULL DEFAULT 'whatsapp',
  language         ENUM('en','ur','any') NOT NULL DEFAULT 'any',

  -- Message content
  body             TEXT         NOT NULL COMMENT 'Supports {{name}}, {{phone}}, {{lead_score}} etc.',
  media_url        VARCHAR(500) NULL COMMENT 'Optional image/video to send with body',

  -- Sending controls (anti-ban)
  delay_min_seconds INT         NOT NULL DEFAULT 8,
  delay_max_seconds INT         NOT NULL DEFAULT 15,
  daily_cap         INT         NOT NULL DEFAULT 400 COMMENT 'Max sends per day per WA account',
  send_window_start VARCHAR(5)  NOT NULL DEFAULT '09:00' COMMENT 'HH:MM 24-hour, Asia/Karachi',
  send_window_end   VARCHAR(5)  NOT NULL DEFAULT '21:00',
  whatsapp_account_id INT       NULL COMMENT 'Specific WA account to send from; null = round-robin',

  -- Audience
  source_type      ENUM('group_import','segment','manual_list') NOT NULL DEFAULT 'group_import',
  source_meta      JSON         NULL COMMENT 'e.g. {"group_subject":"March Fither"} or segment filter JSON',

  -- Execution
  status           ENUM('draft','queued','running','paused','completed','aborted','failed') NOT NULL DEFAULT 'draft',
  total_recipients INT          NOT NULL DEFAULT 0,
  sent_count       INT          NOT NULL DEFAULT 0,
  delivered_count  INT          NOT NULL DEFAULT 0,
  read_count       INT          NOT NULL DEFAULT 0,
  replied_count    INT          NOT NULL DEFAULT 0,
  failed_count     INT          NOT NULL DEFAULT 0,
  opt_out_count    INT          NOT NULL DEFAULT 0,

  -- Audit
  created_by       INT          NULL,
  created_at       DATETIME     NOT NULL DEFAULT NOW(),
  started_at       DATETIME     NULL,
  completed_at     DATETIME     NULL,

  PRIMARY KEY (campaign_id),
  INDEX idx_status (status),
  INDEX idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ──────────────────────────────────────────────────────────────
-- 2. campaign_recipients — per-message tracking
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS campaign_recipients (
  id               BIGINT       NOT NULL AUTO_INCREMENT,
  campaign_id      CHAR(36)     NOT NULL,
  lead_id          BIGINT       NOT NULL,
  status           ENUM('queued','sending','sent','delivered','read','replied','failed','skipped','opted_out')
                   NOT NULL DEFAULT 'queued',
  external_message_id VARCHAR(120) NULL,
  rendered_body    TEXT         NULL COMMENT 'Final message after placeholder substitution',
  error_message    TEXT         NULL,
  scheduled_at     DATETIME     NULL,
  sent_at          DATETIME     NULL,
  delivered_at     DATETIME     NULL,
  read_at          DATETIME     NULL,
  replied_at       DATETIME     NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_campaign_lead (campaign_id, lead_id),
  INDEX idx_status (campaign_id, status),
  INDEX idx_lead (lead_id),
  CONSTRAINT fk_cr_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns(campaign_id) ON DELETE CASCADE,
  CONSTRAINT fk_cr_lead FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ──────────────────────────────────────────────────────────────
-- 3. group_imports — audit log of group-member extractions
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS group_imports (
  import_id        CHAR(36)     NOT NULL,
  group_subject    VARCHAR(255) NOT NULL,
  group_jid        VARCHAR(255) NULL,
  whatsapp_account_id INT       NOT NULL,
  members_total    INT          NOT NULL DEFAULT 0,
  members_added    INT          NOT NULL DEFAULT 0,
  members_skipped  INT          NOT NULL DEFAULT 0,
  members_pending  INT          NOT NULL DEFAULT 0 COMMENT 'LID-only without phone yet',
  imported_by      INT          NULL,
  created_at       DATETIME     NOT NULL DEFAULT NOW(),
  PRIMARY KEY (import_id),
  INDEX idx_account (whatsapp_account_id),
  INDEX idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ──────────────────────────────────────────────────────────────
-- 4. dnc_list — do-not-contact (auto-populated when user replies STOP)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dnc_list (
  id               BIGINT       NOT NULL AUTO_INCREMENT,
  lead_id          BIGINT       NULL COMMENT 'Null if we only have phone (not yet a lead)',
  phone            VARCHAR(20)  NULL,
  whatsapp_jid     VARCHAR(255) NULL,
  reason           ENUM('user_request','complaint','unsubscribe','manual') NOT NULL DEFAULT 'user_request',
  matched_keyword  VARCHAR(60)  NULL,
  source_message   TEXT         NULL,
  added_by         INT          NULL,
  created_at       DATETIME     NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id),
  INDEX idx_lead (lead_id),
  INDEX idx_phone (phone),
  INDEX idx_jid (whatsapp_jid),
  CONSTRAINT fk_dnc_lead FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ──────────────────────────────────────────────────────────────
-- 5. wa_account_daily_quota — per-account daily send counter
--    Resets every day. Used by the worker to enforce daily caps.
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wa_account_daily_quota (
  whatsapp_account_id INT      NOT NULL,
  quota_date          DATE     NOT NULL,
  sent_today          INT      NOT NULL DEFAULT 0,
  PRIMARY KEY (whatsapp_account_id, quota_date),
  CONSTRAINT fk_quota_account FOREIGN KEY (whatsapp_account_id) REFERENCES whatsapp_accounts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- =============================================================
-- Verify after running:
--   SHOW TABLES LIKE 'campaign%';
--   SHOW TABLES LIKE 'group_imports';
--   SHOW TABLES LIKE 'dnc_list';
--   SHOW TABLES LIKE 'wa_account_daily_quota';
-- =============================================================
