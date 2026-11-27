-- 050_trial_and_class_data.sql (Nov 2026)
-- What makes each woman personal to Fizza and the reps, from the app:
--   trial_started_at / trial_expires_at  her free trial window
--   trial_classes_attended               trial classes done (0–3)
--   subscription_frozen_at               her paid plan is frozen since
--   last_class_at                        her last class (any plan)
-- (total_workouts_completed already exists; it now really counts classes.)
-- ai/journeyContext.js and services/autoCampaign.service.js already read the
-- first four; they were never created, so those queries failed.
-- Filled live by app events and nightly by the plan sync.
ALTER TABLE leads
  ADD COLUMN trial_started_at       DATETIME NULL,
  ADD COLUMN trial_expires_at       DATETIME NULL,
  ADD COLUMN trial_classes_attended TINYINT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN subscription_frozen_at DATETIME NULL,
  ADD COLUMN last_class_at          DATETIME NULL,
  ADD INDEX idx_trial_started (trial_started_at),
  ADD INDEX idx_trial_expires (trial_expires_at);
