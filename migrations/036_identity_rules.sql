-- 036_identity_rules.sql — one woman = one lead, without guessing (11 Nov 2026).
--
-- 1. leads.app_user_id is UNIQUE: one app account can never sit on two
--    leads. Merged (history) leads already have app_user_id = NULL
--    (linkByCrmLeadId clears it); older ones are cleared here first.
--    Check first: GET /api/identity/report → duplicate_app_accounts must be 0.
-- 2. leads.app_phone: the number she typed in the app. Kept apart from
--    leads.phone (her WhatsApp / contact number) so neither overwrites the
--    other, and so an app lead can exist next to a WhatsApp lead with the
--    same number (leads has UNIQUE(phone, whatsapp_account_id)).
-- 3. lead_match_suggestions: "maybe the same woman" (same typed phone or
--    email, no link). A rep confirms (merge) or rejects — never automatic.
--
-- Run once:
--   node script/runMigration.js migrations/036_identity_rules.sql

UPDATE leads SET app_user_id = NULL
 WHERE merged_into_lead_id IS NOT NULL AND app_user_id IS NOT NULL;

ALTER TABLE leads
  ADD COLUMN app_phone VARCHAR(20) NULL AFTER phone,
  ADD UNIQUE KEY uq_app_user_id (app_user_id);

CREATE TABLE IF NOT EXISTS lead_match_suggestions (
  id                BIGINT       NOT NULL AUTO_INCREMENT,
  lead_id           BIGINT       NOT NULL COMMENT 'the app lead (has app_user_id)',
  candidate_lead_id BIGINT       NOT NULL COMMENT 'the existing lead she may be (usually WhatsApp)',
  reason            VARCHAR(20)  NOT NULL COMMENT 'phone | email',
  detail            VARCHAR(255) NULL,
  status            ENUM('open','confirmed','rejected') NOT NULL DEFAULT 'open',
  decided_by        INT          NULL,
  decided_at        DATETIME     NULL,
  created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_pair (lead_id, candidate_lead_id),
  INDEX idx_match_status (status),
  INDEX idx_match_candidate (candidate_lead_id),
  CONSTRAINT fk_match_lead FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
  CONSTRAINT fk_match_candidate FOREIGN KEY (candidate_lead_id) REFERENCES leads(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
