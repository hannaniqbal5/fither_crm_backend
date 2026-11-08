-- =============================================================
-- PHASE 6 MIGRATION — FitHer App ↔ CRM Integration
-- Run AFTER 005_phase5_campaigns.sql
-- mysql -u root -p crm < migrations/006_phase6_app_integration.sql
-- =============================================================

-- ──────────────────────────────────────────────────────────────
-- 1. leads — add subscription + engagement cache columns
--    These are fed by webhooks from the FitHer app backend.
--    The app backend remains the source of truth.
-- ──────────────────────────────────────────────────────────────
ALTER TABLE leads
  ADD COLUMN subscription_plan_id        INT          NULL COMMENT 'FK-like ref to app DB Plan.id',
  ADD COLUMN subscription_plan_title     VARCHAR(160) NULL COMMENT 'Cached display name',
  ADD COLUMN subscription_status         ENUM('none','trial','active','frozen','expired','cancelled') NOT NULL DEFAULT 'none',
  ADD COLUMN subscription_started_at     DATETIME     NULL,
  ADD COLUMN subscription_expires_at     DATETIME     NULL,
  ADD COLUMN subscription_amount         DECIMAL(10,2) NULL COMMENT 'Most recent payment amount',
  ADD COLUMN subscription_currency       VARCHAR(3)   NULL COMMENT 'PKR, USD, etc.',
  ADD COLUMN last_login_at               DATETIME     NULL,
  ADD COLUMN total_workouts_completed    INT          NOT NULL DEFAULT 0,
  ADD COLUMN total_diet_days_completed   INT          NOT NULL DEFAULT 0,
  ADD COLUMN lifetime_value_pkr          DECIMAL(12,2) NOT NULL DEFAULT 0 COMMENT 'Cumulative payments in PKR',
  ADD COLUMN has_pcos                    TINYINT(1)   NOT NULL DEFAULT 0,
  ADD COLUMN target_weight_kg            DECIMAL(5,1) NULL,
  ADD COLUMN main_goal_app               VARCHAR(80)  NULL COMMENT 'User.mainGoal from app',
  ADD COLUMN app_timezone                VARCHAR(60)  NULL COMMENT 'User.timeZone from app',
  ADD COLUMN app_synced_at               DATETIME     NULL COMMENT 'Last successful webhook sync',
  ADD INDEX idx_subscription_status (subscription_status),
  ADD INDEX idx_expires (subscription_expires_at),
  ADD INDEX idx_app_user (app_user_id);

-- ──────────────────────────────────────────────────────────────
-- 2. app_events — audit log of every webhook received from app
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_events (
  event_id          CHAR(36)     NOT NULL,
  external_event_id VARCHAR(120) NULL COMMENT 'Idempotency key from app (e.g. payment txn id)',
  lead_id           BIGINT       NULL COMMENT 'NULL until matched',
  app_user_id       VARCHAR(64)  NOT NULL COMMENT 'Firebase UID / app User.id',
  event_type        VARCHAR(60)  NOT NULL,
  payload           JSON         NULL,
  status            ENUM('received','processed','skipped','failed') NOT NULL DEFAULT 'received',
  error_message     TEXT         NULL,
  received_at       DATETIME     NOT NULL DEFAULT NOW(),
  processed_at      DATETIME     NULL,
  PRIMARY KEY (event_id),
  UNIQUE KEY uq_external (external_event_id),
  INDEX idx_app_user (app_user_id, received_at),
  INDEX idx_event_type (event_type),
  INDEX idx_status (status),
  INDEX idx_lead (lead_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ──────────────────────────────────────────────────────────────
-- 3. Seed automation rules wiring the new app events to existing
--    automation engine (welcome on subscription, win-back on expire, etc.)
-- ──────────────────────────────────────────────────────────────

-- Welcome message when a user subscribes (Urdu)
INSERT IGNORE INTO automation_rules (rule_id, name, trigger_event, conditions, actions, channel, delay_minutes, run_once_per_person, active) VALUES
(UUID(), 'Subscription Welcome (UR)', 'subscription_started',
  '{"language":"ur"}',
  '[{"type":"send_message","template":"subscription_ur","channel":"whatsapp"},{"type":"update_stage","stage":"user"}]',
  'whatsapp', 5, 1, 1);

-- Welcome message when a user subscribes (English)
INSERT IGNORE INTO automation_rules (rule_id, name, trigger_event, conditions, actions, channel, delay_minutes, run_once_per_person, active) VALUES
(UUID(), 'Subscription Welcome (EN)', 'subscription_started',
  '{"language":"en"}',
  '[{"type":"send_message","template":"subscription_en","channel":"whatsapp"},{"type":"update_stage","stage":"user"}]',
  'whatsapp', 5, 1, 1);

-- Win-back when a subscription expires (Urdu)
INSERT IGNORE INTO automation_rules (rule_id, name, trigger_event, conditions, actions, channel, delay_minutes, run_once_per_person, active) VALUES
(UUID(), 'Expiration Win-back (UR)', 'subscription_expired',
  '{"language":"ur"}',
  '[{"type":"send_message","template":"winback_ur","channel":"whatsapp"},{"type":"update_stage","stage":"churned"}]',
  'whatsapp', 1440, 1, 1);

-- Win-back when a subscription expires (English)
INSERT IGNORE INTO automation_rules (rule_id, name, trigger_event, conditions, actions, channel, delay_minutes, run_once_per_person, active) VALUES
(UUID(), 'Expiration Win-back (EN)', 'subscription_expired',
  '{"language":"en"}',
  '[{"type":"send_message","template":"winback_en","channel":"whatsapp"},{"type":"update_stage","stage":"churned"}]',
  'whatsapp', 1440, 1, 1);

-- =============================================================
-- Verify after running:
--   SHOW COLUMNS FROM leads LIKE 'subscription%';
--   SHOW TABLES LIKE 'app_events';
--   SELECT name, trigger_event FROM automation_rules WHERE trigger_event LIKE 'subscription%';
-- =============================================================
