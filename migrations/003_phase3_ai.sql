-- =============================================================
-- PHASE 3 MIGRATION — AI Sales Agent (Fiza)
-- Run AFTER 002_phase2_automation.sql
-- mysql -u root -p crm < migrations/003_phase3_ai.sql
-- =============================================================

-- ──────────────────────────────────────────────────────────────
-- 1. kb_chunks — chunked knowledge base with Gemini embeddings
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kb_chunks (
  chunk_id      CHAR(36)     NOT NULL,
  source_file   VARCHAR(120) NOT NULL,
  section_title VARCHAR(255) NULL,
  chunk_text    TEXT         NOT NULL,
  embedding     JSON         NOT NULL COMMENT 'Array of 768 floats from text-embedding-004',
  token_count   INT          NULL,
  created_at    DATETIME     NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chunk_id),
  INDEX idx_source (source_file)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ──────────────────────────────────────────────────────────────
-- 2. ai_replies — every AI-generated reply, draft or sent
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_replies (
  reply_id          CHAR(36)     NOT NULL,
  lead_id           BIGINT       NOT NULL,
  message_id        INT          NULL COMMENT 'Inbound message that triggered this reply',
  user_message      TEXT         NULL,
  ai_response       TEXT         NOT NULL,
  retrieved_chunks  JSON         NULL COMMENT 'Array of {chunk_id, source_file, score}',
  confidence        DECIMAL(4,3) NULL,
  escalate_reason   VARCHAR(40)  NULL,
  status            ENUM('draft','sent','rejected','edited','escalated','failed') NOT NULL DEFAULT 'draft',
  rep_id            INT          NULL,
  edited_response   TEXT         NULL,
  feedback          ENUM('good','fix','escalate') NULL,
  error_message     TEXT         NULL,
  created_at        DATETIME     NOT NULL DEFAULT NOW(),
  sent_at           DATETIME     NULL,
  PRIMARY KEY (reply_id),
  INDEX idx_lead (lead_id, created_at),
  INDEX idx_status (status),
  INDEX idx_rep (rep_id),
  CONSTRAINT fk_ai_reply_lead FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ──────────────────────────────────────────────────────────────
-- 3. ai_corrections — feedback loop for KB improvement
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_corrections (
  correction_id   CHAR(36) NOT NULL,
  reply_id        CHAR(36) NOT NULL,
  rep_id          INT      NOT NULL,
  original_reply  TEXT     NOT NULL,
  corrected_reply TEXT     NOT NULL,
  notes           TEXT     NULL,
  created_at      DATETIME NOT NULL DEFAULT NOW(),
  PRIMARY KEY (correction_id),
  INDEX idx_reply (reply_id),
  INDEX idx_rep (rep_id, created_at),
  CONSTRAINT fk_correction_reply FOREIGN KEY (reply_id) REFERENCES ai_replies(reply_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- =============================================================
-- Verify after running:
--   SHOW TABLES;
--   DESCRIBE kb_chunks;
--   DESCRIBE ai_replies;
--   DESCRIBE ai_corrections;
-- =============================================================
