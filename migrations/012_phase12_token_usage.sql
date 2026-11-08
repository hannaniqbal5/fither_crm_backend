-- 012_phase12_token_usage.sql
-- Phase 12 — Gemini API token usage tracking.
-- Captures every LLM and embedding call's tokens + estimated cost.

CREATE TABLE IF NOT EXISTS ai_token_usage (
  id                BIGINT NOT NULL AUTO_INCREMENT,

  -- When the call was made
  called_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- What model + what kind of call
  -- operation: reply | classifier | embedding_query | embedding_ingest | followup_draft | other
  operation         VARCHAR(40) NOT NULL,
  model             VARCHAR(60) NOT NULL,

  -- Tokens (from Gemini's usageMetadata field)
  prompt_tokens     INT NOT NULL DEFAULT 0,
  completion_tokens INT NOT NULL DEFAULT 0,
  total_tokens      INT NOT NULL DEFAULT 0,

  -- Cost estimate in USD (computed at log time from settings; doesn't auto-refresh)
  cost_usd          DECIMAL(12,6) NOT NULL DEFAULT 0,

  -- Optional links so we can drill into a specific reply
  reply_id          CHAR(36) NULL,
  lead_id           BIGINT NULL,
  rep_id            INT NULL,

  -- Outcome flag — was the call successful?
  success           BOOLEAN NOT NULL DEFAULT 1,
  error_message     VARCHAR(255) NULL,

  -- Latency in ms (helpful for debugging slow calls)
  latency_ms        INT NULL,

  PRIMARY KEY (id),
  INDEX idx_day_op (called_at, operation),
  INDEX idx_reply (reply_id),
  INDEX idx_lead  (lead_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Pricing seed (per-million-tokens, USD)
-- Update these when Google's pricing changes.
INSERT IGNORE INTO layer_system_settings (setting_key, setting_value, description) VALUES
  ('ai_price_input_per_1m_usd',   '0.075', 'Input/prompt tokens cost per 1M (Gemini 2.5 Flash)'),
  ('ai_price_output_per_1m_usd',  '0.30',  'Output/completion tokens cost per 1M (Gemini 2.5 Flash)'),
  ('ai_price_embedding_per_1m_usd','0.025','Embedding tokens cost per 1M (text-embedding-004 / gemini-embedding-001)'),
  ('ai_usd_to_pkr_rate',          '278',   'Conversion rate for PKR display in admin tab');
