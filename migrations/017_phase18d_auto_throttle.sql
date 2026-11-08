-- 017_phase18d_auto_throttle.sql
-- Phase 18d — auto-throttle on opt-out spike.
-- When campaign opt-out rate exceeds threshold within an hour, broadcastWorker
-- auto-pauses the campaign and writes an event row + alerts admin.

ALTER TABLE campaigns
  ADD COLUMN auto_paused_reason VARCHAR(200) NULL
    COMMENT 'Reason text when broadcastWorker auto-pauses (opt-out spike, etc.)',
  ADD COLUMN auto_paused_at DATETIME NULL;

CREATE TABLE IF NOT EXISTS campaign_auto_pause_events (
  id              BIGINT NOT NULL AUTO_INCREMENT,
  campaign_id     CHAR(36) NOT NULL,
  event_type      VARCHAR(40) NOT NULL COMMENT 'opt_out_spike | high_fail_rate | manual_pause',
  reason          VARCHAR(500) NULL,
  metric_value    DECIMAL(10,4) NULL,
  threshold_value DECIMAL(10,4) NULL,
  sent_in_window  INT NULL,
  optouts_in_window INT NULL,
  acknowledged_by INT NULL,
  acknowledged_at DATETIME NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  INDEX idx_campaign (campaign_id, created_at),
  INDEX idx_unack (acknowledged_at, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Seed default threshold settings into layer_system_settings
INSERT IGNORE INTO layer_system_settings (setting_key, setting_value, description) VALUES
  ('campaign_optout_threshold_pct',    '3.0',   'Auto-pause if opt-out % exceeds this in the last hour'),
  ('campaign_optout_min_sample',       '30',    'Minimum messages sent before opt-out check kicks in'),
  ('campaign_optout_window_minutes',   '60',    'Rolling window for opt-out rate calculation');
