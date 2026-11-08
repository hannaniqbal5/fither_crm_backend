-- 009_phase8_layer_system.sql
-- Layer System v1 — intent detection, goal tracking, funnel stage.
-- Adds 8 new fields to `leads` table (Sequelize model: People).
-- Plus a `intent_followup_queue` table for Layer 5 scheduled follow-ups.
-- Plus a `category_metrics` table for soft-launch graduation tracking.

-- ──────────────────────────────────────────────────────────────────────
-- 1. People (leads) — add Layer System columns
-- ──────────────────────────────────────────────────────────────────────

ALTER TABLE leads
  ADD COLUMN interaction_status ENUM(
    'new_inbound','awaiting_reply','active_chat','ghosted',
    'asking_about_program','asking_about_price','comparing_plans','discussing_with_family','requesting_trial',
    'price_negotiation','price_objection','timing_objection','medical_concern','husband_blocking','will_start_later',
    'callback_scheduled','ready_to_pay','payment_link_sent','payment_pending','onboarded',
    'not_interested','wrong_number','lost_to_competitor','opted_out'
  ) NULL DEFAULT NULL,

  ADD COLUMN main_goal ENUM(
    'pcos','weight_loss','weight_gain','postpartum','diabetes','general'
  ) NULL DEFAULT NULL,

  ADD COLUMN last_objection ENUM(
    'price','timing','family','medical','fit','none'
  ) NULL DEFAULT 'none',

  ADD COLUMN funnel_stage TINYINT UNSIGNED NULL DEFAULT 1
    COMMENT '1 Discovery, 2 Goal mapped, 3 Pricing, 4 Objection, 5 Close',

  ADD COLUMN last_intent_detected_at DATETIME NULL,

  ADD COLUMN auto_followup_paused BOOLEAN NOT NULL DEFAULT 0,

  ADD COLUMN intent_history JSON NULL
    COMMENT 'Last 10 intent snapshots: [{ts, status, goal, objection, score_delta, reason}]',

  ADD COLUMN goal_detected_at DATETIME NULL,

  ADD INDEX idx_interaction_status (interaction_status),
  ADD INDEX idx_main_goal (main_goal),
  ADD INDEX idx_funnel_stage (funnel_stage),
  ADD INDEX idx_paused (auto_followup_paused);

-- ──────────────────────────────────────────────────────────────────────
-- 2. intent_followup_queue — Layer 5 scheduled follow-ups
-- One row per scheduled follow-up. Worker scans 'pending' rows every 5 minutes.
-- ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS intent_followup_queue (
  id                BIGINT NOT NULL AUTO_INCREMENT,
  lead_id           BIGINT NOT NULL,

  -- Why this follow-up was scheduled
  trigger_status    VARCHAR(40) NOT NULL,
  trigger_goal      VARCHAR(20) NULL,
  template_key      VARCHAR(80) NOT NULL COMMENT 'e.g. ghosted__pcos__24h',

  -- When to fire
  scheduled_for     DATETIME NOT NULL,

  -- Tier 1 (auto) or Tier 2 (draft only)
  send_tier         ENUM('tier1_auto','tier2_draft') NOT NULL DEFAULT 'tier2_draft',

  -- pending → sent | drafted | skipped | cancelled
  status            ENUM('pending','sent','drafted','skipped','cancelled') NOT NULL DEFAULT 'pending',
  skip_reason       VARCHAR(120) NULL,

  -- Result tracking
  fired_at          DATETIME NULL,
  message_id        BIGINT NULL,
  ai_reply_id       CHAR(36) NULL,

  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  INDEX idx_pending_scan (status, scheduled_for),
  INDEX idx_lead (lead_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ──────────────────────────────────────────────────────────────────────
-- 3. category_metrics — graduation tracking for soft-launch
-- Aggregates rep edit / approve / reject rates per template_key.
-- After 7-day soft launch, categories with high approval graduate to Tier 1.
-- ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS category_metrics (
  id                BIGINT NOT NULL AUTO_INCREMENT,
  template_key      VARCHAR(80) NOT NULL,
  metric_date       DATE NOT NULL,

  total_fires       INT NOT NULL DEFAULT 0,
  approved_count    INT NOT NULL DEFAULT 0,
  edited_count      INT NOT NULL DEFAULT 0,
  rejected_count    INT NOT NULL DEFAULT 0,
  auto_sent_count   INT NOT NULL DEFAULT 0,

  -- Decision flags (set by graduation evaluator)
  graduated         BOOLEAN NOT NULL DEFAULT 0,
  graduated_at      DATETIME NULL,

  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_template_date (template_key, metric_date),
  INDEX idx_graduated (graduated, template_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ──────────────────────────────────────────────────────────────────────
-- 4. layer_system_settings — admin kill switches + per-category toggles
-- One global row + one row per category we want to control individually.
-- ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS layer_system_settings (
  id                INT NOT NULL AUTO_INCREMENT,
  setting_key       VARCHAR(80) NOT NULL UNIQUE,
  setting_value     VARCHAR(255) NOT NULL,
  description       VARCHAR(255) NULL,
  updated_by        INT NULL,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO layer_system_settings (setting_key, setting_value, description) VALUES
  ('global_auto_send_enabled',    '0', 'Master kill switch — 0 disables all Tier 1 auto-send'),
  ('soft_launch_mode',            '1', '1 = all categories draft-only, 0 = graduated categories auto-send'),
  ('soft_launch_started_at',      '',  'ISO date when soft launch began; 7 days = window'),
  ('founder_alert_threshold',     '150', 'Score ≥ this triggers WhatsApp alert to founder'),
  ('max_consecutive_followups',   '3',  'Per lead, in 30 days'),
  ('min_gap_between_msgs_hours',  '18', 'Min hours between two system-sent messages to same lead'),
  ('daily_cap_per_lead',          '2',  'Max system-sent messages per lead per 24h'),
  ('working_hours_start',         '09', 'Start of working hours (24h, PKT)'),
  ('working_hours_end',           '21', 'End of working hours (24h, PKT)');
