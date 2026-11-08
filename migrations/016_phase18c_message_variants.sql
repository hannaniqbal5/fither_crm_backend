-- 016_phase18c_message_variants.sql
-- Phase 18c — message variation support for campaigns.
-- Admin writes 1-5 variants of the message body; the broadcastWorker picks one
-- at random per recipient to reduce WhatsApp's "identical-message fingerprint"
-- anti-spam detection.

ALTER TABLE campaigns
  ADD COLUMN body_variants JSON NULL
    COMMENT 'Array of 1-5 alternative message bodies. NULL = use single body column for backward compat.';
