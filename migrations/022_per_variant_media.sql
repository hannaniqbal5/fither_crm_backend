-- 022_per_variant_media.sql
-- Per-variant media: pair each body_variant with its own image/media URL.
-- Index N of media_variants pairs with index N of body_variants.
-- The legacy `media_url` column pairs with the legacy `body` column (variant 0).

ALTER TABLE campaigns
  ADD COLUMN media_variants JSON NULL
    COMMENT 'Array of media URLs (string), parallel to body_variants. NULL = reuse media_url for all sends.';
