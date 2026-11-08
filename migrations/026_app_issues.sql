-- ──────────────────────────────────────────────────────────────
-- 026_app_issues.sql
--
-- Dedicated record for technical / app-service issues reported from the app,
-- so the admin has a separate "App Issues" section (instead of mixing them
-- into the sales Leads list). The conversation message still lives in
-- `messages` (channel='app'); this table tracks the issue itself: category,
-- priority, plan context, and open/resolved status.
-- ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_issues (
  id            BIGINT       NOT NULL AUTO_INCREMENT,
  lead_id       BIGINT       NOT NULL,
  app_user_id   VARCHAR(64)  NULL,
  category      VARCHAR(40)  NULL COMMENT 'APP_ISSUE | PAYMENT | PLAN | CLASS | OTHER | MEDICAL',
  priority      ENUM('normal','high') NOT NULL DEFAULT 'normal',
  message       TEXT         NULL,
  image_url     VARCHAR(500) NULL,
  plan_title    VARCHAR(160) NULL,
  status        ENUM('open','resolved') NOT NULL DEFAULT 'open',
  resolved_note TEXT         NULL,
  resolved_by   INT          NULL,
  resolved_at   DATETIME     NULL,
  created_at    DATETIME     NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id),
  INDEX idx_appissue_status (status),
  INDEX idx_appissue_lead (lead_id),
  INDEX idx_appissue_created (created_at),
  CONSTRAINT fk_appissue_lead FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
