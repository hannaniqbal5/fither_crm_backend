-- 035: Fiza auto-takeover rules (manager-defined)
-- When a rep is slow, Fiza (AI) auto-responds to the lead.

CREATE TABLE IF NOT EXISTS auto_takeover_rules (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name            VARCHAR(200)  NOT NULL,

  -- When to trigger
  trigger_type    ENUM('rep_slow','no_reply','outside_hours','lead_urgent') NOT NULL DEFAULT 'rep_slow',
  wait_minutes    INT UNSIGNED  NOT NULL DEFAULT 15  COMMENT 'Minutes to wait before Fiza takes over',

  -- Filters (which leads this applies to)
  applies_to_stage  JSON        NULL  COMMENT '["prospect","trial","user"] or null = all',
  applies_to_status JSON        NULL  COMMENT '["active","trial"] or null = all',

  -- What Fiza does
  action          ENUM('reply','reply_and_notify_rep','notify_rep_only') NOT NULL DEFAULT 'reply_and_notify_rep',
  fiza_prompt     TEXT          NULL  COMMENT 'Extra context for Fiza when generating reply, e.g. "be warm, mention class schedule"',
  fallback_message TEXT         NULL  COMMENT 'Fixed message if AI generation fails',

  -- Guard rails
  max_takeovers_per_lead INT UNSIGNED NOT NULL DEFAULT 3  COMMENT 'Max auto-replies per lead per day',
  cooldown_minutes       INT UNSIGNED NOT NULL DEFAULT 30 COMMENT 'Min gap between two takeovers for same lead',
  only_during_hours      BOOLEAN NOT NULL DEFAULT FALSE   COMMENT 'Only trigger during business hours (9am-9pm PKT)',
  notify_manager         BOOLEAN NOT NULL DEFAULT TRUE    COMMENT 'Notify manager when takeover happens',

  is_active       BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Track each takeover
CREATE TABLE IF NOT EXISTS auto_takeover_log (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  rule_id         INT UNSIGNED  NOT NULL,
  lead_id         INT UNSIGNED  NOT NULL,
  rep_id          INT UNSIGNED  NULL,
  trigger_type    VARCHAR(40)   NOT NULL,
  wait_actual_min INT UNSIGNED  NULL      COMMENT 'How many minutes rep was actually inactive',

  action_taken    ENUM('replied','notified_rep','skipped') NOT NULL,
  message_sent    TEXT          NULL,
  skip_reason     VARCHAR(120)  NULL      COMMENT 'cooldown, max_reached, rep_replied_in_time, outside_hours',

  created_at      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,

  INDEX idx_rule    (rule_id),
  INDEX idx_lead    (lead_id),
  INDEX idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
