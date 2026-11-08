-- ──────────────────────────────────────────────────────────────
-- 027_indexes_hotpaths.sql
--
-- Hot-path indexes (works on MySQL 8 and MariaDB — plain CREATE INDEX).
--   • campaign_recipients(external_message_id): every WhatsApp delivery/read
--     receipt runs  UPDATE campaign_recipients ... WHERE external_message_id = ?
--     which was a full table scan.
--   • messages(whatsapp_account_id, direction, created_at): the send gate's
--     per-number daily total (COUNT(*) ... WHERE whatsapp_account_id = ? AND
--     direction = 'OUT' AND created_at >= ?) runs before every proactive send.
--
-- NOTE: run ONCE. Plain CREATE INDEX fails with "Duplicate key name" if this
-- file is re-run — that error is harmless (the index already exists).
-- (MySQL 8 has no CREATE INDEX IF NOT EXISTS, so it is not used here.)
-- ──────────────────────────────────────────────────────────────

CREATE INDEX idx_cr_external_msg ON campaign_recipients (external_message_id);

CREATE INDEX idx_msg_account_dir_created ON messages (whatsapp_account_id, direction, created_at);
