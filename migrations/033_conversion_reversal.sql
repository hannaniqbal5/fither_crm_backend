-- 033: Add reversal tracking to rep_conversions.
-- A reversed conversion keeps the row for history but doesn't count toward rep stats.

ALTER TABLE rep_conversions
  ADD COLUMN reversed_at    DATETIME     NULL DEFAULT NULL COMMENT 'When the conversion was reversed (frozen/cancelled/expired)',
  ADD COLUMN reverse_reason VARCHAR(60)  NULL DEFAULT NULL COMMENT 'Why: subscription_frozen, subscription_expired, refund, admin';

-- Index so the "latest un-reversed" query is fast
ALTER TABLE rep_conversions
  ADD INDEX idx_rc_lead_unreversed (lead_id, reversed_at, converted_at DESC);
