-- 031_owner_rule.sql — every woman always has one owner (9 Nov 2026).
-- See the crm project doc "journey-architecture.md", section 3.
--   leads.owner_type        rep | fiza | app   (who is responsible right now)
--   leads.owner_assigned_at when the owner was last set by the owner rule
--   leads.phone_requested_at when Fiza asked her (in the app) for her WhatsApp
--   leads.owner_reason      the stuck reason waiting for her phone number
--   rep_tasks               what a rep must do, by when (push sent when due)
-- Run once:
--   node script/runMigration.js migrations/031_owner_rule.sql

ALTER TABLE leads
  ADD COLUMN owner_type         ENUM('rep','fiza','app') NULL,
  ADD COLUMN owner_assigned_at  DATETIME NULL,
  ADD COLUMN phone_requested_at DATETIME NULL,
  ADD COLUMN owner_reason       VARCHAR(40) NULL COMMENT 'stuck reason waiting while Fiza asks for her phone';

CREATE TABLE IF NOT EXISTS rep_tasks (
  id           BIGINT       NOT NULL AUTO_INCREMENT,
  lead_id      BIGINT       NOT NULL,
  rep_id       INT          NULL,
  reason       VARCHAR(40)  NOT NULL COMMENT 'onboarding_stalled | trial_no_class | payment_dropped | slip_rejected | payment_paused | retention_risk',
  urgency      ENUM('normal','hot') NOT NULL DEFAULT 'normal',
  title        VARCHAR(200) NOT NULL,
  detail       TEXT         NULL,
  due_at       DATETIME     NOT NULL,
  status       ENUM('open','done','cancelled') NOT NULL DEFAULT 'open',
  notified_at  DATETIME     NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closed_at    DATETIME     NULL,
  close_reason VARCHAR(80)  NULL,
  PRIMARY KEY (id),
  INDEX idx_rep_open (rep_id, status, due_at),
  INDEX idx_lead_open (lead_id, status, reason),
  INDEX idx_due (status, notified_at, due_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
