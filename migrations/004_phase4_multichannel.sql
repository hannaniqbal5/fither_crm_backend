-- =============================================================
-- PHASE 4 MIGRATION — Multichannel (Instagram + Facebook Messenger)
-- Run AFTER 003_phase3_ai.sql
-- mysql -u root -p crm < migrations/004_phase4_multichannel.sql
-- =============================================================

-- ──────────────────────────────────────────────────────────────
-- 1. meta_pages — registry of connected FB Pages / IG accounts
--    (one row per Page; IG account linked to a Page shares this row)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS meta_pages (
  id                       INT          NOT NULL AUTO_INCREMENT,
  page_id                  VARCHAR(64)  NOT NULL UNIQUE COMMENT 'Facebook Page numeric ID',
  page_name                VARCHAR(120) NULL,
  instagram_account_id     VARCHAR(64)  NULL UNIQUE COMMENT 'Linked Instagram Business account ID',
  page_access_token        TEXT         NOT NULL COMMENT 'Long-lived token; refresh every ~50 days',
  token_expires_at         DATETIME     NULL,
  status                   ENUM('active','disconnected','error') NOT NULL DEFAULT 'active',
  last_webhook_at          DATETIME     NULL,
  created_at               DATETIME     NOT NULL DEFAULT NOW(),
  updated_at               DATETIME     NOT NULL DEFAULT NOW() ON UPDATE NOW(),
  PRIMARY KEY (id),
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ──────────────────────────────────────────────────────────────
-- 2. leads — add Instagram + Facebook identity columns
--    (whatsapp_jid stays for WA leads; new columns for IG/FB leads)
-- ──────────────────────────────────────────────────────────────
ALTER TABLE leads
  ADD COLUMN instagram_psid    VARCHAR(64)  NULL COMMENT 'Instagram-scoped user ID (PSID)',
  ADD COLUMN instagram_username VARCHAR(120) NULL,
  ADD COLUMN facebook_psid     VARCHAR(64)  NULL COMMENT 'Facebook-scoped user ID (PSID)',
  ADD COLUMN facebook_name     VARCHAR(120) NULL,
  ADD COLUMN meta_page_id      INT          NULL COMMENT 'FK to meta_pages.id when this lead came via Meta',
  ADD INDEX idx_instagram_psid (instagram_psid),
  ADD INDEX idx_facebook_psid (facebook_psid),
  ADD CONSTRAINT fk_lead_meta_page FOREIGN KEY (meta_page_id) REFERENCES meta_pages(id);

-- Extend the source enum (MySQL syntax — drop & recreate enum)
ALTER TABLE leads
  MODIFY COLUMN source
  ENUM('whatsapp','instagram','facebook','website','app','ad','organic','referral','unknown')
  NOT NULL DEFAULT 'whatsapp';

-- ──────────────────────────────────────────────────────────────
-- 3. messages — make channel-agnostic
--    Existing rows keep whatsapp_message_id; new rows can use external_message_id.
-- ──────────────────────────────────────────────────────────────
ALTER TABLE messages
  ADD COLUMN channel ENUM('whatsapp','instagram','facebook') NOT NULL DEFAULT 'whatsapp' AFTER `from`,
  ADD COLUMN external_message_id VARCHAR(120) NULL COMMENT 'Platform message ID for non-WA channels',
  ADD COLUMN external_thread_id  VARCHAR(120) NULL COMMENT 'PSID for IG/FB; null for WA',
  ADD INDEX idx_channel (channel),
  ADD INDEX idx_external_msg (external_message_id);

-- Make whatsapp_account_id nullable (not all messages come via WA anymore)
ALTER TABLE messages
  MODIFY COLUMN whatsapp_account_id INT NULL;

-- ──────────────────────────────────────────────────────────────
-- 4. comments — Instagram + Facebook public comments
--    Stored separately from messages because they're public, not 1:1 DMs.
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS comments (
  comment_id        VARCHAR(120) NOT NULL COMMENT 'Platform comment ID (Meta)',
  channel           ENUM('instagram','facebook') NOT NULL,
  post_id           VARCHAR(120) NOT NULL,
  parent_comment_id VARCHAR(120) NULL COMMENT 'For replies-to-replies',
  meta_page_id      INT          NOT NULL,
  external_user_id  VARCHAR(64)  NULL COMMENT 'IG/FB user who commented',
  external_username VARCHAR(120) NULL,
  message           TEXT         NULL,
  lead_id           BIGINT       NULL COMMENT 'Linked lead if we successfully DMed them',
  status            ENUM('new','public_replied','dm_sent','converted','ignored') NOT NULL DEFAULT 'new',
  ai_handled        TINYINT(1)   NOT NULL DEFAULT 0,
  created_at        DATETIME     NOT NULL DEFAULT NOW(),
  PRIMARY KEY (comment_id),
  INDEX idx_post (post_id),
  INDEX idx_status (status),
  INDEX idx_lead (lead_id),
  INDEX idx_meta_page (meta_page_id),
  CONSTRAINT fk_comment_lead FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL,
  CONSTRAINT fk_comment_page FOREIGN KEY (meta_page_id) REFERENCES meta_pages(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- =============================================================
-- Verify after running:
--   SHOW COLUMNS FROM leads LIKE 'instagram_psid';
--   SHOW COLUMNS FROM messages LIKE 'channel';
--   SHOW TABLES LIKE 'meta_pages';
--   SHOW TABLES LIKE 'comments';
-- =============================================================
