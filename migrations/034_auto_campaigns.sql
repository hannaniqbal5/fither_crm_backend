-- 034: Automated trigger-based campaigns (rule engine).
--
-- Unlike Phase 5 campaigns (manual blast to a list), these fire automatically
-- when a lead matches a trigger condition. Manager creates the rules,
-- system executes them.

CREATE TABLE IF NOT EXISTS auto_campaign_rules (
  id              INT          NOT NULL AUTO_INCREMENT,
  name            VARCHAR(120) NOT NULL COMMENT 'e.g. "Trial day 3 no class nudge"',
  
  -- Trigger
  trigger_event   VARCHAR(60)  NOT NULL COMMENT 'onboarding_stalled, trial_no_class, trial_ending, gone_quiet, subscription_expiring, post_signup, custom',
  delay_hours     INT          NOT NULL DEFAULT 24 COMMENT 'Hours after trigger before sending',
  
  -- Conditions (JSON, all must be true)
  conditions      JSON         NULL COMMENT '{"min_days_since_signup":3, "subscription_status":"none", "stage":"lead"}',
  
  -- Message
  channel         ENUM('whatsapp','app_push','both') NOT NULL DEFAULT 'whatsapp',
  message_template TEXT        NOT NULL COMMENT 'Supports {name}, {trial_days_left}, {plan_name}, {rep_name}',
  media_url       VARCHAR(500) NULL,
  
  -- Guards
  max_sends_per_lead  INT      NOT NULL DEFAULT 1 COMMENT 'How many times this rule can fire per lead',
  cooldown_hours      INT      NOT NULL DEFAULT 48 COMMENT 'Min hours between any auto-campaign to same lead',
  skip_if_rep_active  TINYINT(1) NOT NULL DEFAULT 1 COMMENT 'Skip if rep messaged in last X hours',
  rep_active_hours    INT      NOT NULL DEFAULT 6 COMMENT 'Hours to consider rep "active" on the lead',
  skip_if_lead_replied TINYINT(1) NOT NULL DEFAULT 1 COMMENT 'Skip if lead replied recently',
  
  -- State
  is_active       TINYINT(1)  NOT NULL DEFAULT 1,
  created_by      INT         NULL COMMENT 'Admin user who created this',
  created_at      DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  
  PRIMARY KEY (id),
  INDEX idx_acr_active (is_active, trigger_event)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


CREATE TABLE IF NOT EXISTS auto_campaign_sends (
  id              BIGINT       NOT NULL AUTO_INCREMENT,
  rule_id         INT          NOT NULL,
  lead_id         BIGINT       NOT NULL,
  
  -- What was sent
  channel         VARCHAR(20)  NOT NULL,
  message_sent    TEXT         NULL,
  media_url       VARCHAR(500) NULL,
  
  -- Outcome
  status          ENUM('sent','delivered','read','replied','failed','skipped') NOT NULL DEFAULT 'sent',
  skip_reason     VARCHAR(120) NULL COMMENT 'rep_active, lead_replied, cooldown, dnc, no_jid, max_reached',
  wa_message_id   VARCHAR(120) NULL,
  
  -- Tracking
  sent_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  delivered_at    DATETIME     NULL,
  read_at         DATETIME     NULL,
  replied_at      DATETIME     NULL,
  
  PRIMARY KEY (id),
  INDEX idx_acs_rule (rule_id, sent_at),
  INDEX idx_acs_lead (lead_id, sent_at),
  INDEX idx_acs_status (status, sent_at),
  CONSTRAINT fk_acs_rule FOREIGN KEY (rule_id) REFERENCES auto_campaign_rules(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
