-- 008_phase7_kb_category.sql
-- Add a `category` column to kb_chunks so Fiza can filter by mode.
--
-- Categories are tags that map chunks to modes:
--   sales   uses: basic_info, pricing, programs, conditions, weight_loss, objections, trainers
--   winback uses: pricing, whats_new, return_offer, programs, conditions, objections
--   support uses: troubleshooting_*

ALTER TABLE kb_chunks
  ADD COLUMN IF NOT EXISTS category VARCHAR(40) NULL AFTER section_title;

CREATE INDEX IF NOT EXISTS idx_kb_category ON kb_chunks(category);
