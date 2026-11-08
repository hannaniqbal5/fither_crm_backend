-- 030_app_onboarding.sql — where she is in the app's sign-up (9 Nov 2026).
--   app_signed_up_at          when she made her app account
--   app_onboarding_step       last sign-up question page she reached (of 6)
--   app_onboarded_at          when she finished all sign-up questions
--   app_onboarding_stalled_at when the app reported she stopped (20 h+ after signup)
-- Run once:
--   node script/runMigration.js migrations/030_app_onboarding.sql

ALTER TABLE leads
  ADD COLUMN app_signed_up_at          DATETIME NULL,
  ADD COLUMN app_onboarding_step       TINYINT  NULL,
  ADD COLUMN app_onboarded_at          DATETIME NULL,
  ADD COLUMN app_onboarding_stalled_at DATETIME NULL,
  ADD INDEX idx_app_onboarding (app_onboarded_at, app_signed_up_at);
