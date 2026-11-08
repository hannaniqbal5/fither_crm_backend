-- 013_phase13_search.sql
-- Phase 13 — Universal search across leads + messages.
-- FULLTEXT index on message body for fast content search.

-- ─── messages: FULLTEXT on body ─────────────────────────────────
-- ngram parser handles short queries (CJK, mixed-script Roman Urdu, etc.)
-- gracefully where the default tokenizer fails on tokens shorter than 3 chars.
ALTER TABLE messages
  ADD FULLTEXT INDEX ft_message_body (message) /*!50700 WITH PARSER ngram */;

-- ─── leads: indexes on common search columns ────────────────────
-- We do prefix LIKE matches on these, plus exact-match phone.
ALTER TABLE leads
  ADD INDEX idx_search_name (name),
  ADD INDEX idx_search_email (email),
  ADD INDEX idx_search_ig (instagram_username),
  ADD INDEX idx_search_fb_name (facebook_name);
