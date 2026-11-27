-- 049_phone_last10.sql (Nov 2026)
-- "Is this the same number?" was answered by stripping characters inside SQL
-- (RIGHT(REPLACE(...))), which can't use an index and scanned every lead on
-- every check. These columns hold the last 10 digits, kept by MySQL itself
-- whenever phone / app_phone change, and indexed. 0300…, 92300…, +92 300-…
-- all give the same value. Under 10 digits → NULL (never matches).
ALTER TABLE leads
  ADD COLUMN phone_last10 CHAR(10) GENERATED ALWAYS AS (
    IF(CHAR_LENGTH(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(phone,''),' ',''),'+',''),'-',''),'(',''),')',''),'.','')) >= 10,
       RIGHT(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone,' ',''),'+',''),'-',''),'(',''),')',''),'.',''), 10),
       NULL)
  ) STORED,
  ADD COLUMN app_phone_last10 CHAR(10) GENERATED ALWAYS AS (
    IF(CHAR_LENGTH(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(app_phone,''),' ',''),'+',''),'-',''),'(',''),')',''),'.','')) >= 10,
       RIGHT(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(app_phone,' ',''),'+',''),'-',''),'(',''),')',''),'.',''), 10),
       NULL)
  ) STORED,
  ADD INDEX idx_phone_last10 (phone_last10),
  ADD INDEX idx_app_phone_last10 (app_phone_last10);
