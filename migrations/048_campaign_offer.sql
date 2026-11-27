-- 048_campaign_offer.sql (Nov 2026)
-- The offer a campaign makes ("30% off the 3-month plan") and when it ends.
-- Follow-ups after she replies read these, so they repeat the real offer
-- while it runs and never promise it after it ends.
ALTER TABLE campaigns
  ADD COLUMN offer_text    VARCHAR(300) NULL,
  ADD COLUMN offer_ends_at DATE         NULL;
