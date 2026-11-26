-- 044_payment_requests.sql — WhatsApp payments (Nov 2026).
--
-- A rep's "Request payment" in the chat: which plan, how much, and what
-- happened to the slip she sent back. The plan/price/slip check itself lives
-- in the app backend (its payment-link record, `token`); this is the CRM's
-- side so the rep sees the status in the chat and the CRM knows which
-- incoming photo is a slip.
--
-- Rollback: DROP TABLE payment_requests;

CREATE TABLE IF NOT EXISTS payment_requests (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  lead_id         BIGINT       NOT NULL,
  rep_id          INT          NULL,
  token           VARCHAR(32)  NOT NULL COMMENT 'app backend payment link token',
  plan_title      VARCHAR(160) NULL,
  duration_label  VARCHAR(60)  NULL,
  amount          INT          NOT NULL,
  currency        VARCHAR(8)   NOT NULL DEFAULT 'PKR',
  status          ENUM('open','checking','approved','waiting_signup','review','rejected','expired','cancelled')
                  NOT NULL DEFAULT 'open',
  result_reason   VARCHAR(255) NULL,
  slip_message_id INT          NULL,
  plan_image_id   INT          NULL COMMENT 'app backend PlanImage id',
  expires_at      DATETIME     NOT NULL,
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  INDEX idx_pr_lead (lead_id, status),
  UNIQUE KEY uq_pr_token (token)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
