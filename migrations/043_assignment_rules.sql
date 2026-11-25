-- 043_assignment_rules.sql — who gets new leads (Nov 2026).
--
-- One rule for every door (WhatsApp, app signup, Start chat, uploads, handoffs),
-- set by the admin in Team → "New leads go to":
--   assign_mode = 'round_robin'  → turn by turn among reps with in_rotation = 1
--   assign_mode = 'single'       → all new leads to assign_single_rep_id
-- Admins never get leads from the rotation.
--
-- Rollback:
--   ALTER TABLE sales_reps DROP COLUMN in_rotation;
--   DELETE FROM layer_system_settings WHERE setting_key IN ('assign_mode','assign_single_rep_id');

ALTER TABLE sales_reps
  ADD COLUMN in_rotation TINYINT(1) NOT NULL DEFAULT 1
  COMMENT '1 = gets new leads in the round robin; admin can take a rep out';

INSERT IGNORE INTO layer_system_settings (setting_key, setting_value, description) VALUES
  ('assign_mode', 'round_robin', 'New leads: round_robin (reps in the rotation) or single (one rep gets all)'),
  ('assign_single_rep_id', '', 'Rep who gets every new lead when assign_mode = single');
