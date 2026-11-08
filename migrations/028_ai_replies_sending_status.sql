-- ──────────────────────────────────────────────────────────────
-- 028_ai_replies_sending_status.sql
--
-- Adds 'sending' to ai_replies.status. POST /api/ai/drafts/:id/approve now
-- atomically claims a draft (draft/escalated → sending) before sending so a
-- double-click / two reps can't send the same reply twice.
--
-- MUST be applied BEFORE deploying the matching ai.routes.js change —
-- otherwise the claim UPDATE fails and approving drafts returns an error.
-- Safe to re-run (MODIFY to the same definition is a no-op).
-- 'sending' is appended at the END so MySQL/MariaDB can change the ENUM
-- in place (metadata-only) instead of rebuilding the table.
-- ──────────────────────────────────────────────────────────────

ALTER TABLE ai_replies
  MODIFY COLUMN status ENUM('draft','sent','rejected','edited','escalated','failed','sending')
    NOT NULL DEFAULT 'draft';
