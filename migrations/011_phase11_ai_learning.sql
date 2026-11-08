-- 011_phase11_ai_learning.sql
-- Phase 11 — Fiza Learning Loop.
-- Extend ai_corrections with context snapshot + admin promotion flags
-- so corrections can be retrieved as few-shot examples for similar future drafts.

ALTER TABLE ai_corrections
  ADD COLUMN interaction_status VARCHAR(40)  NULL  COMMENT 'Lead state at time of edit',
  ADD COLUMN main_goal          VARCHAR(20)  NULL,
  ADD COLUMN last_objection     VARCHAR(20)  NULL,
  ADD COLUMN user_message       TEXT         NULL  COMMENT 'Customer message that triggered the draft',
  ADD COLUMN edit_distance      DECIMAL(4,2) NULL  COMMENT 'Levenshtein-normalized 0-1; 0 = no edit, 1 = full rewrite',
  ADD COLUMN edit_action        ENUM('approved','edited','rejected') NULL,

  ADD COLUMN promoted           BOOLEAN  NOT NULL DEFAULT 0  COMMENT 'Admin promoted as a few-shot example',
  ADD COLUMN promoted_by        INT      NULL,
  ADD COLUMN promoted_at        DATETIME NULL,
  ADD COLUMN dismissed          BOOLEAN  NOT NULL DEFAULT 0  COMMENT 'Admin reviewed and dismissed (not useful)',
  ADD COLUMN dismissed_at       DATETIME NULL,

  ADD INDEX idx_promoted_ctx (promoted, interaction_status, main_goal),
  ADD INDEX idx_review_queue (dismissed, promoted, created_at);

-- Approved-as-is logs (no edit) — kept lighter than ai_corrections to avoid bloat.
-- One row per approved/rejected draft so we have an audit trail and metric source.
CREATE TABLE IF NOT EXISTS ai_reply_decisions (
  id                BIGINT NOT NULL AUTO_INCREMENT,
  reply_id          CHAR(36) NOT NULL,
  lead_id           BIGINT NOT NULL,
  rep_id            INT    NOT NULL,
  decision          ENUM('approved','edited','rejected') NOT NULL,
  template_key      VARCHAR(80) NULL  COMMENT 'For Layer 5 followups (status__goal)',
  interaction_status VARCHAR(40) NULL,
  main_goal         VARCHAR(20) NULL,
  last_objection    VARCHAR(20) NULL,
  edit_distance     DECIMAL(4,2) NULL,
  created_at        DATETIME NOT NULL DEFAULT NOW(),

  PRIMARY KEY (id),
  INDEX idx_template (template_key, decision),
  INDEX idx_rep_recent (rep_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
