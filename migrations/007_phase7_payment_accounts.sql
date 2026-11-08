-- 007_phase7_payment_accounts.sql
-- Multi-country payment accounts for the sales rep workflow.
-- Admin adds accounts per country (Pakistan: JazzCash + HBL; UAE: ADCB; etc.).
-- Sales rep clicks "Payment Accounts" button → modal shows accounts for the
-- lead's country (auto-detected by phone), with override to view all.

CREATE TABLE IF NOT EXISTS payment_accounts (
  id              INT          NOT NULL AUTO_INCREMENT,
  -- ISO 3166 alpha-2 country code (PK, AE, US, etc.) — matches phoneCountry.js output
  country_code    VARCHAR(2)   NOT NULL,
  country_name    VARCHAR(80)  NOT NULL,
  currency        VARCHAR(8)   NOT NULL DEFAULT 'PKR',

  -- Account display details
  account_type    ENUM('bank', 'jazzcash', 'easypaisa', 'sadapay', 'nayapay', 'paypal', 'wise', 'other')
                  NOT NULL DEFAULT 'bank',
  bank_name       VARCHAR(120) NOT NULL,
  account_holder  VARCHAR(160) NOT NULL,
  account_number  VARCHAR(60)  NOT NULL,
  iban            VARCHAR(60)  NULL,
  branch_code     VARCHAR(40)  NULL,
  swift_code      VARCHAR(20)  NULL,

  -- Optional rep-facing instructions (e.g., "Send to this account only after Mr. Ahmed confirms")
  instructions    TEXT         NULL,

  -- Lifecycle
  is_active       BOOLEAN      NOT NULL DEFAULT 1,
  display_order   INT          NOT NULL DEFAULT 0  COMMENT 'Lower = shown first',
  created_by      INT          NULL,
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  INDEX idx_country (country_code, is_active),
  INDEX idx_active (is_active, display_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Seed a sample Pakistan account so the feature has something to show out of the box.
-- Admin can edit/delete/add more via the admin panel.
INSERT IGNORE INTO payment_accounts
  (country_code, country_name, currency, account_type, bank_name, account_holder, account_number, instructions, display_order)
VALUES
  ('PK', 'Pakistan', 'PKR', 'jazzcash', 'JazzCash', 'FitHer Pakistan',  '0345-XXXXXXX',   'Easiest for most customers — instant transfer.', 1);
