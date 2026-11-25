-- 039_replying_now.sql
--
-- WHY
--   Fourteen things decided who was talking to a woman: assigned_to,
--   owner_type, owner_reason, is_escalated, escalated_to, fizza_handled,
--   auto_followup_paused, phone_requested_at, rep_tasks rows, three env
--   switches (AI_COPILOT_MODE, AI_SILENT_ESCALATIONS, automation_sends_paused)
--   and a per-campaign fizza_auto_reply. Nobody could answer "is Fizza or a
--   human replying to her right now" without reading six of them.
--
-- WHAT
--   One question, one answer, the same two words at all three scopes:
--     leads.replying_now        this one chat      (admin takes over / hands back)
--     campaigns.replying_now    this campaign's replies
--     layer_system_settings     the channel default
--
--   NULL always means "no opinion at this scope, ask the next one out", so an
--   admin can take over one chat without touching the campaign, and a campaign
--   without touching the default. services/replyOwner.js resolves the order.
--
--   This is deliberately SEPARATE from assigned_to. Who is accountable for her
--   (one rep, for credit and for whose inbox she's in) and who is replying to
--   her this minute are two different facts, and mixing them is what made
--   owner_type confusing.
--
-- SAFE TO RUN ON A LIVE DB
--   Additive and nullable. With every column NULL the behaviour is exactly
--   what it is today, because the resolver falls through to the same defaults.
--   The old fizza_handled and fizza_auto_reply flags are still read as a
--   fallback, so nothing changes until you start using the new field.
--
-- ROLLBACK
--   ALTER TABLE leads DROP COLUMN replying_now, DROP COLUMN replying_now_by, DROP COLUMN replying_now_at;
--   ALTER TABLE campaigns DROP COLUMN replying_now;
--   DELETE FROM layer_system_settings WHERE setting_key IN ('default_replier','default_replier_app');

ALTER TABLE leads
  ADD COLUMN replying_now    ENUM('fiza','rep') NULL
    COMMENT 'Who answers THIS chat. NULL = fall through to campaign, then the default.',
  ADD COLUMN replying_now_by INT      NULL COMMENT 'sales_reps.id of whoever took over',
  ADD COLUMN replying_now_at DATETIME NULL,
  ADD INDEX idx_replying_now (replying_now);

ALTER TABLE campaigns
  ADD COLUMN replying_now ENUM('fiza','rep') NULL
    COMMENT 'Who answers replies to this campaign. NULL = fall through to the default.';

-- The channel defaults. 'rep' on WhatsApp keeps today's behaviour (Fizza
-- drafts, a rep approves). 'fiza' in the app keeps today's behaviour there
-- (Fizza answers her directly). Change either from the dashboard, not here.
INSERT IGNORE INTO layer_system_settings (setting_key, setting_value, description) VALUES
  ('default_replier',     'rep',  'Who answers WhatsApp / Instagram / Facebook by default: fiza or rep'),
  ('default_replier_app', 'fiza', 'Who answers in-app chat by default: fiza or rep');
