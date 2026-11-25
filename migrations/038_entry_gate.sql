-- 038_entry_gate.sql
--
-- WHY
--   `leads.source` records the CHANNEL she arrived on (whatsapp / instagram /
--   facebook / app), not the GATE she came through. Four very different kinds
--   of relationship currently all read as 'whatsapp':
--     • she messaged the sales number herself
--     • a rep messaged her from the shared WhatsApp phone
--     • her number came from an uploaded list
--     • her number came from a paid-customers group import
--   and on the Meta side a DM and an auto-DM from a comment are identical too.
--
--   That difference matters: a woman who wrote to you first is not the same as
--   a number you bought, for how she's treated, what you may send her, and
--   whether a conversion rate means anything.
--
-- WHAT
--   One nullable column, written once when the contact is created and never
--   overwritten (same discipline as `source`). `source` is untouched, so
--   everything already reading it keeps working.
--
--   VARCHAR, not ENUM, on purpose: a new gate should not need a migration.
--   The values services/frontDesk.js writes today are
--     whatsapp_inbound, whatsapp_rep_phone, crm_start_chat, fizza_chat,
--     number_upload, group_import, instagram_dm, instagram_comment,
--     facebook_dm, facebook_comment, app_signup
--
-- SAFE TO RUN ON A LIVE DB
--   Additive and nullable. Existing rows get NULL, meaning "arrived before we
--   started recording this". The code tolerates the column not existing yet,
--   so deploy order does not matter.
--
-- ROLLBACK
--   ALTER TABLE leads DROP COLUMN entry_gate;

ALTER TABLE leads
  ADD COLUMN entry_gate VARCHAR(40) NULL
    COMMENT 'Which door she came through. Set once on creation, never overwritten.'
    AFTER source,
  ADD INDEX idx_entry_gate (entry_gate);
