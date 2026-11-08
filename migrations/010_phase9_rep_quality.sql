-- 010_phase9_rep_quality.sql
-- Phase 9 — Sales Rep Quality scorecard system.
-- Adds 4 tables: rep_sessions, rep_conversions, rep_daily_stats, rep_quality_flags.
-- Plus appends 6 working-hours-related rows to layer_system_settings.

-- ──────────────────────────────────────────────────────────────────────
-- 1. rep_sessions — auto open/close as rep enters/leaves working hours
-- One row per active session. Closes on logout, 60-min idle, or 9 PM rollover.
-- ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS rep_sessions (
  id                BIGINT NOT NULL AUTO_INCREMENT,
  rep_id            INT    NOT NULL,
  started_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at          DATETIME NULL,

  -- Minute counters maintained by the heartbeat tick (every 1 min while active)
  active_minutes    INT    NOT NULL DEFAULT 0   COMMENT 'foreground time inside 9-9 window',
  background_minutes INT   NOT NULL DEFAULT 0   COMMENT 'app open but tab/screen not active',
  idle_minutes      INT    NOT NULL DEFAULT 0   COMMENT 'foreground but no UI activity > 5 min',

  -- Tracking
  last_heartbeat_at DATETIME NULL,
  state             ENUM('active','background','idle','closed') NOT NULL DEFAULT 'active',
  close_reason      VARCHAR(40) NULL  COMMENT 'logout | idle_timeout | end_of_day | crash',

  -- Was this session entirely inside the 9 AM – 9 PM PKT window?
  in_window         BOOLEAN NOT NULL DEFAULT 1,

  PRIMARY KEY (id),
  INDEX idx_rep_started (rep_id, started_at),
  INDEX idx_state (state),
  INDEX idx_open (ended_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ──────────────────────────────────────────────────────────────────────
-- 2. rep_conversions — sales attribution (lead → user transitions)
-- One row per conversion. Linked to the rep who owned the lead at conversion time.
-- ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS rep_conversions (
  id                BIGINT NOT NULL AUTO_INCREMENT,
  rep_id            INT    NOT NULL,
  lead_id           BIGINT NOT NULL,

  -- Sale details
  plan_name         VARCHAR(120) NULL  COMMENT '1-month, 2-month, 3-month or custom',
  plan_duration_months TINYINT NULL,
  amount_paid       DECIMAL(10,2) NULL,
  currency          VARCHAR(8)    DEFAULT 'PKR',
  payment_account_id INT NULL,

  -- Lifecycle
  conversion_source ENUM('magic_link','manual_slip','app_webhook','manual_admin') NOT NULL DEFAULT 'magic_link',
  converted_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- Was the conversion during this rep's active session?
  attributed_session_id BIGINT NULL,

  notes             VARCHAR(255) NULL,

  PRIMARY KEY (id),
  UNIQUE KEY uq_lead_conv (lead_id, converted_at),
  INDEX idx_rep_converted (rep_id, converted_at),
  INDEX idx_lead (lead_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ──────────────────────────────────────────────────────────────────────
-- 3. rep_daily_stats — historical per-day rollup (written by nightly cron)
-- ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS rep_daily_stats (
  id                BIGINT NOT NULL AUTO_INCREMENT,
  rep_id            INT    NOT NULL,
  stat_date         DATE   NOT NULL,

  -- Time / presence (all minute counters scoped to 9 AM – 9 PM PKT)
  active_minutes    INT    NOT NULL DEFAULT 0,
  background_minutes INT   NOT NULL DEFAULT 0,
  idle_minutes      INT    NOT NULL DEFAULT 0,
  shift_minutes     INT    NOT NULL DEFAULT 0    COMMENT '720 = full 12-hour shift',
  presence_pct      DECIMAL(5,2) NOT NULL DEFAULT 0  COMMENT 'active/shift × 100',

  -- Workload
  messages_received INT    NOT NULL DEFAULT 0,
  messages_sent     INT    NOT NULL DEFAULT 0,
  conversations_handled INT NOT NULL DEFAULT 0,
  leads_assigned    INT    NOT NULL DEFAULT 0,

  -- Quality
  avg_response_time_min DECIMAL(6,2) NOT NULL DEFAULT 0  COMMENT 'avg minutes, in-window only',
  on_time_pct       DECIMAL(5,2) NOT NULL DEFAULT 0   COMMENT '% replies within 5 min SLA',
  missed_replies    INT    NOT NULL DEFAULT 0,
  escalations       INT    NOT NULL DEFAULT 0,

  -- Sales
  conversions_count INT    NOT NULL DEFAULT 0,
  revenue_attributed DECIMAL(12,2) NOT NULL DEFAULT 0,

  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_rep_date (rep_id, stat_date),
  INDEX idx_date (stat_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ──────────────────────────────────────────────────────────────────────
-- 4. rep_quality_flags — auto-flagged underperformance signals
-- ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS rep_quality_flags (
  id                BIGINT NOT NULL AUTO_INCREMENT,
  rep_id            INT    NOT NULL,
  flag_date         DATE   NOT NULL,

  -- e.g. slow_response, low_presence, high_miss_rate, low_conversion, overload
  flag_type         VARCHAR(40) NOT NULL,
  severity          ENUM('info','warning','critical') NOT NULL DEFAULT 'warning',

  -- Snapshot of metric that triggered
  metric_value      DECIMAL(10,2) NULL,
  threshold_value   DECIMAL(10,2) NULL,
  message           VARCHAR(500) NULL,

  -- Lifecycle
  acknowledged      BOOLEAN NOT NULL DEFAULT 0,
  acknowledged_by   INT    NULL,
  acknowledged_at   DATETIME NULL,

  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  INDEX idx_rep_date (rep_id, flag_date),
  INDEX idx_unack (acknowledged, severity)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ──────────────────────────────────────────────────────────────────────
-- 5. Settings — additional knobs (reuses layer_system_settings table)
-- ──────────────────────────────────────────────────────────────────────

INSERT IGNORE INTO layer_system_settings (setting_key, setting_value, description) VALUES
  ('rep_shift_start_hour',         '09', 'Working hours start (PKT, 24h)'),
  ('rep_shift_end_hour',           '21', 'Working hours end (PKT, 24h)'),
  ('rep_sla_response_minutes',     '5',  'Max minutes for a reply to count as "on time"'),
  ('rep_idle_timeout_minutes',     '5',  'Mins of no UI activity before session marked idle'),
  ('rep_max_idle_to_close',        '60', 'Mins of idle before session auto-closed'),
  ('rep_quality_min_presence_pct', '60', 'Below this presence_pct → low_presence flag'),
  ('rep_quality_max_rt_minutes',   '15', 'Avg response time > this minutes → slow_response flag'),
  ('rep_quality_max_miss_pct',     '20', 'Missed reply rate > this pct → high_miss_rate flag');
