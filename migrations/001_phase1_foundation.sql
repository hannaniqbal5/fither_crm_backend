-- =============================================================
-- PHASE 1 COMPLETE SCHEMA — FitHer CRM
-- Fresh install on empty database
-- Run: mysql -u root -p crmm < migrations/001_phase1_foundation.sql
-- =============================================================

SET FOREIGN_KEY_CHECKS = 0;

-- ──────────────────────────────────────────────────────────────
-- 1. whatsapp_accounts
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS whatsapp_accounts (
  id           INT          NOT NULL AUTO_INCREMENT,
  phone_number VARCHAR(20)  NOT NULL UNIQUE,
  session_path VARCHAR(255) NOT NULL,
  status       ENUM('active','inactive') NOT NULL DEFAULT 'active',
  createdAt    DATETIME     NOT NULL DEFAULT NOW(),
  updatedAt    DATETIME     NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ──────────────────────────────────────────────────────────────
-- 2. sales_reps
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sales_reps (
  id                   INT          NOT NULL AUTO_INCREMENT,
  name                 VARCHAR(100) NOT NULL,
  email                VARCHAR(180) NOT NULL UNIQUE,
  password             VARCHAR(255) NOT NULL,
  role                 ENUM('rep','admin') NOT NULL DEFAULT 'rep',
  status               ENUM('active','inactive') NOT NULL DEFAULT 'active',
  whatsapp_account_id  INT          NOT NULL,
  createdAt            DATETIME     NOT NULL DEFAULT NOW(),
  updatedAt            DATETIME     NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id),
  INDEX idx_wa_account (whatsapp_account_id),
  CONSTRAINT fk_rep_wa
    FOREIGN KEY (whatsapp_account_id)
    REFERENCES whatsapp_accounts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ──────────────────────────────────────────────────────────────
-- 3. assignment_state (round-robin pointer)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS assignment_state (
  id          INT      NOT NULL AUTO_INCREMENT,
  last_rep_id INT      NULL,
  updated_at  DATETIME NOT NULL DEFAULT NOW() ON UPDATE NOW(),
  PRIMARY KEY (id),
  CONSTRAINT fk_assignment_rep
    FOREIGN KEY (last_rep_id)
    REFERENCES sales_reps(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Seed one row so the round-robin works immediately
INSERT INTO assignment_state (last_rep_id) VALUES (NULL);

-- ──────────────────────────────────────────────────────────────
-- 4. sales_rep_push_tokens
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sales_rep_push_tokens (
  id           INT          NOT NULL AUTO_INCREMENT,
  sales_rep_id INT          NOT NULL,
  token        VARCHAR(255) NOT NULL UNIQUE,
  created_at   DATETIME     NOT NULL DEFAULT NOW(),
  last_seen_at DATETIME     NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id),
  INDEX idx_rep (sales_rep_id),
  CONSTRAINT fk_token_rep
    FOREIGN KEY (sales_rep_id)
    REFERENCES sales_reps(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ──────────────────────────────────────────────────────────────
-- 5. leads (People table — blueprint name is People, table is leads)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS leads (
  id                  BIGINT       NOT NULL AUTO_INCREMENT,
  phone               VARCHAR(20)  NULL,
  name                VARCHAR(100) NULL,
  email               VARCHAR(180) NULL,

  -- CRM stage (blueprint)
  stage               ENUM('visitor','lead','user','churned') NOT NULL DEFAULT 'visitor',
  language            ENUM('en','ur') NOT NULL DEFAULT 'en',
  lead_score          INT          NOT NULL DEFAULT 0,
  app_user_id         VARCHAR(128) NULL COMMENT 'Firebase UID from Flutter app',
  churn_trigger       VARCHAR(40)  NULL COMMENT 'subscription_cancelled | payment_failed_3x',

  -- Rep-facing pipeline status
  status              ENUM('new','interested','followup','converted','lost') NOT NULL DEFAULT 'new',
  unread_count        INT          NOT NULL DEFAULT 0,

  -- WhatsApp
  whatsapp_jid        VARCHAR(255) NULL UNIQUE,
  whatsapp_account_id INT          NOT NULL,

  -- Assignment
  assigned_to         INT          NULL,

  -- Escalation
  is_escalated        TINYINT(1)   NOT NULL DEFAULT 0,
  escalated_to        INT          NULL,
  escalated_at        DATETIME     NULL,

  -- Timestamps
  last_message_at     DATETIME     NULL,
  last_activity_at    DATETIME     NULL,
  created_at          DATETIME     NOT NULL DEFAULT NOW(),

  -- Source + extras
  source              ENUM('whatsapp','instagram','website','app','ad','organic','referral','unknown') NOT NULL DEFAULT 'whatsapp',
  campaign_id         INT          NULL,
  notes               TEXT         NULL,

  PRIMARY KEY (id),
  UNIQUE KEY uq_phone_wa (phone, whatsapp_account_id),
  INDEX idx_assigned    (assigned_to),
  INDEX idx_wa_account  (whatsapp_account_id),
  INDEX idx_last_msg    (last_message_at),
  INDEX idx_stage       (stage),
  INDEX idx_score       (lead_score),

  CONSTRAINT fk_lead_wa
    FOREIGN KEY (whatsapp_account_id)
    REFERENCES whatsapp_accounts(id),
  CONSTRAINT fk_lead_rep
    FOREIGN KEY (assigned_to)
    REFERENCES sales_reps(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ──────────────────────────────────────────────────────────────
-- 6. messages
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
  id                  INT          NOT NULL AUTO_INCREMENT,
  lead_id             BIGINT       NOT NULL,
  rep_id              INT          NULL,
  whatsapp_account_id INT          NOT NULL,
  `from`              ENUM('user','rep','bot') NOT NULL,
  message             TEXT         NULL,
  direction           ENUM('IN','OUT') NOT NULL,
  message_type        ENUM('text','image','video','audio','voice','document','sticker','location') NOT NULL DEFAULT 'text',
  media_url           VARCHAR(500) NULL,
  media_mime          VARCHAR(100) NULL,
  media_size          INT          NULL,
  duration            INT          NULL,
  file_name           VARCHAR(255) NULL,
  whatsapp_message_id VARCHAR(100) NULL UNIQUE,
  status              ENUM('sending','sent','delivered','read','received') NOT NULL DEFAULT 'received',
  is_read             TINYINT(1)   NOT NULL DEFAULT 0,
  created_at          DATETIME     NOT NULL DEFAULT NOW(),
  updated_at          DATETIME     NULL,

  PRIMARY KEY (id),
  INDEX idx_lead_created (lead_id, created_at),
  INDEX idx_rep          (rep_id),
  INDEX idx_direction    (direction),

  CONSTRAINT fk_msg_lead
    FOREIGN KEY (lead_id)
    REFERENCES leads(id) ON DELETE CASCADE,
  CONSTRAINT fk_msg_rep
    FOREIGN KEY (rep_id)
    REFERENCES sales_reps(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ──────────────────────────────────────────────────────────────
-- 7. escalations
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS escalations (
  id          BIGINT   NOT NULL AUTO_INCREMENT,
  lead_id     BIGINT   NOT NULL,
  raised_by   INT      NOT NULL,
  assigned_to INT      NOT NULL,
  issue_type  VARCHAR(100) NULL,
  description TEXT     NULL,
  status      ENUM('open','in_progress','resolved') NOT NULL DEFAULT 'open',
  resolved_at DATETIME NULL,
  created_at  DATETIME NOT NULL DEFAULT NOW(),

  PRIMARY KEY (id),
  INDEX idx_lead (lead_id),
  CONSTRAINT fk_esc_lead
    FOREIGN KEY (lead_id)
    REFERENCES leads(id) ON DELETE CASCADE,
  CONSTRAINT fk_esc_rep
    FOREIGN KEY (assigned_to)
    REFERENCES sales_reps(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ──────────────────────────────────────────────────────────────
-- 8. activities (Phase 1 new — append-only touchpoint log)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS activities (
  activity_id   CHAR(36)    NOT NULL,
  lead_id       BIGINT      NOT NULL,
  activity_type VARCHAR(60) NOT NULL COMMENT 'message_received | workout_started | payment_completed | etc',
  source        VARCHAR(40) NOT NULL DEFAULT 'whatsapp',
  metadata      JSON        NULL,
  created_at    DATETIME    NOT NULL DEFAULT NOW(),

  PRIMARY KEY (activity_id),
  INDEX idx_lead_created (lead_id, created_at),
  INDEX idx_type         (activity_type),

  CONSTRAINT fk_act_lead
    FOREIGN KEY (lead_id)
    REFERENCES leads(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ──────────────────────────────────────────────────────────────
-- 9. events (Phase 1 new — automation engine queue)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS events (
  event_id   CHAR(36)    NOT NULL,
  lead_id    BIGINT      NOT NULL,
  event_type VARCHAR(60) NOT NULL COMMENT 'lead_created | conversation_started | payment_success | etc',
  payload    JSON        NULL,
  processed  TINYINT(1)  NOT NULL DEFAULT 0,
  created_at DATETIME    NOT NULL DEFAULT NOW(),

  PRIMARY KEY (event_id),
  INDEX idx_unprocessed (processed, created_at),
  INDEX idx_lead        (lead_id),

  CONSTRAINT fk_evt_lead
    FOREIGN KEY (lead_id)
    REFERENCES leads(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ──────────────────────────────────────────────────────────────
-- 10. integrations (Phase 1 new — Baileys health tracking)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS integrations (
  integration_id CHAR(36)    NOT NULL,
  name           VARCHAR(80) NOT NULL,
  type           ENUM('whatsapp','instagram','payment','app') NOT NULL,
  config         JSON        NULL,
  status         ENUM('active','disconnected','error') NOT NULL DEFAULT 'disconnected',
  last_ping_at   DATETIME    NULL,
  created_at     DATETIME    NOT NULL DEFAULT NOW(),

  PRIMARY KEY (integration_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Seed Baileys row
INSERT INTO integrations (integration_id, name, type, status)
VALUES (UUID(), 'baileys_wa', 'whatsapp', 'disconnected');

SET FOREIGN_KEY_CHECKS = 1;

-- ──────────────────────────────────────────────────────────────
-- Done. Verify:
--   SHOW TABLES;
--   SHOW COLUMNS FROM leads;
-- ──────────────────────────────────────────────────────────────
