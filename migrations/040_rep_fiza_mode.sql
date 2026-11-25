-- 040_rep_fiza_mode.sql
-- Per-rep Fiza autonomy. The admin sets each rep's mode:
--   'copilot'  — Fiza drafts, this rep approves and sends (nothing auto-sends).
--   'autopilot'— Fiza sends on its own for this rep's leads (routine traffic).
-- NULL = inherit the channel default (preserves pre-migration behaviour), so
-- deploying this changes nothing until the admin assigns modes.
--
-- Slots into replyOwner.whoReplies() as step 5, BELOW the locked guardrails
-- (sensitive topic, admin takeover, 24h human lock). Even an autopilot rep's
-- money-moment (ready_to_pay / human_requested) is still handed to a human.

ALTER TABLE sales_reps
  ADD COLUMN fiza_mode ENUM('copilot','autopilot') NULL DEFAULT NULL
  COMMENT 'Per-rep Fiza autonomy; NULL = inherit channel default';
