-- ──────────────────────────────────────────────────────────────
-- 023_per_account_assignment.sql
--
-- Multi-WhatsApp-account fix: give the round-robin a SEPARATE pointer
-- per WhatsApp account, so an inbound lead that lands on account B is
-- only ever assigned to a rep that belongs to account B.
--
-- Before this, assignment_state held a single global pointer and
-- getNextRepRoundRobin() picked from ALL active reps regardless of which
-- number received the message — which orphaned leads on multi-account
-- setups (the assigned rep couldn't even see them, since the rep inbox
-- is filtered by whatsapp_account_id).
-- ──────────────────────────────────────────────────────────────

ALTER TABLE assignment_state
  ADD COLUMN whatsapp_account_id INT NULL AFTER id;

-- Drop the legacy single global seed row (NULL account). Per-account
-- pointer rows are created lazily by getNextRepRoundRobin() on first use.
DELETE FROM assignment_state WHERE whatsapp_account_id IS NULL;

-- One round-robin pointer row per account.
ALTER TABLE assignment_state
  ADD UNIQUE KEY uq_assignment_account (whatsapp_account_id);

ALTER TABLE assignment_state
  ADD CONSTRAINT fk_assignment_account
  FOREIGN KEY (whatsapp_account_id)
  REFERENCES whatsapp_accounts(id)
  ON DELETE CASCADE;
