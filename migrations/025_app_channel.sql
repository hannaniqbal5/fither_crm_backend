-- ──────────────────────────────────────────────────────────────
-- 025_app_channel.sql
--
-- First-party "app" channel: lets an issue/message a user reports in the
-- Fit Her app land in the CRM as an inbound conversation message the admin/rep
-- can see and reply to (no third party). Adds 'app' to the messages.channel ENUM
-- so app messages render with their own channel badge in the dashboard.
-- ──────────────────────────────────────────────────────────────

ALTER TABLE messages
  MODIFY COLUMN channel ENUM('whatsapp','instagram','facebook','app')
  NOT NULL DEFAULT 'whatsapp';
