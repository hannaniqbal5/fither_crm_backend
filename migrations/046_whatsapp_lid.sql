-- 046_whatsapp_lid.sql (Nov 2026)
-- WhatsApp gives some women two ids: their number (…@s.whatsapp.net) and a
-- hidden @lid. leads.whatsapp_jid holds the one her chat uses; this keeps the
-- other so a group import or a new message under the @lid finds the same
-- woman instead of creating a second record.
-- Not UNIQUE on purpose: old duplicates may share one until they are merged.
ALTER TABLE leads
  ADD COLUMN whatsapp_lid VARCHAR(64) NULL AFTER whatsapp_jid,
  ADD INDEX idx_whatsapp_lid (whatsapp_lid);

-- Backfill: leads whose chat id already is an @lid.
UPDATE leads SET whatsapp_lid = whatsapp_jid
 WHERE whatsapp_jid LIKE '%@lid' AND whatsapp_lid IS NULL;
