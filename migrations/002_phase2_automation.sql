-- =============================================================
-- PHASE 2 MIGRATION — Automation Engine
-- Run AFTER 001_phase1_foundation.sql
-- mysql -u root -p crmm < migrations/002_phase2_automation.sql
-- =============================================================

-- ──────────────────────────────────────────────────────────────
-- 1. automation_rules
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS automation_rules (
  rule_id             CHAR(36)     NOT NULL,
  name                VARCHAR(120) NOT NULL,
  trigger_event       VARCHAR(60)  NOT NULL COMMENT 'lead_created | inactivity_24h | inactivity_7d | churn_detected | payment_success | subscription_started | workout_completed',
  conditions          JSON         NULL     COMMENT 'e.g. {"stage":"lead","language":"ur","source":"whatsapp"}',
  actions             JSON         NOT NULL COMMENT '[{"type":"send_message","template":"followup_ur_1","channel":"whatsapp"}]',
  channel             ENUM('whatsapp','instagram','email','any') NOT NULL DEFAULT 'any',
  delay_minutes       INT          NOT NULL DEFAULT 0,
  run_once_per_person TINYINT(1)   NOT NULL DEFAULT 1,
  active              TINYINT(1)   NOT NULL DEFAULT 1,
  created_by          INT          NULL,
  created_at          DATETIME     NOT NULL DEFAULT NOW(),

  PRIMARY KEY (rule_id),
  INDEX idx_trigger (trigger_event),
  INDEX idx_active  (active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ──────────────────────────────────────────────────────────────
-- 2. message_templates
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS message_templates (
  template_id  CHAR(36)     NOT NULL,
  name         VARCHAR(100) NOT NULL UNIQUE COMMENT 'e.g. followup_1_ur — referenced in rule actions JSON',
  channel      ENUM('whatsapp','instagram','email') NOT NULL DEFAULT 'whatsapp',
  language     ENUM('en','ur') NOT NULL DEFAULT 'en',
  body         TEXT         NOT NULL COMMENT 'Message text with {{name}}, {{class_name}} placeholders',
  media_url    VARCHAR(500) NULL,
  created_by   INT          NULL,
  created_at   DATETIME     NOT NULL DEFAULT NOW(),

  PRIMARY KEY (template_id),
  INDEX idx_channel_lang (channel, language)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ──────────────────────────────────────────────────────────────
-- 3. automation_logs
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS automation_logs (
  log_id        CHAR(36)    NOT NULL,
  rule_id       CHAR(36)    NOT NULL,
  lead_id       BIGINT      NOT NULL,
  event_id      CHAR(36)    NOT NULL,
  channel       VARCHAR(40) NOT NULL DEFAULT 'system' COMMENT 'whatsapp | instagram | email | system',
  status        ENUM('pending','success','failed','skipped') NOT NULL DEFAULT 'pending',
  error_message TEXT        NULL,
  executed_at   DATETIME    NOT NULL DEFAULT NOW(),

  PRIMARY KEY (log_id),
  INDEX idx_rule_lead   (rule_id, lead_id),
  INDEX idx_channel     (channel),
  INDEX idx_status      (status),
  INDEX idx_executed_at (executed_at),

  CONSTRAINT fk_log_rule
    FOREIGN KEY (rule_id) REFERENCES automation_rules(rule_id) ON DELETE CASCADE,
  CONSTRAINT fk_log_lead
    FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ──────────────────────────────────────────────────────────────
-- 4. pipeline — Phase 4 kanban board (created now to avoid FK issues later)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pipeline (
  pipeline_id       CHAR(36)   NOT NULL,
  lead_id           BIGINT     NOT NULL UNIQUE,
  stage             ENUM('new','contacted','consulted','trialing','converted','churned') NOT NULL DEFAULT 'new',
  assigned_agent_id INT        NULL,
  stage_entered_at  DATETIME   NOT NULL DEFAULT NOW(),
  updated_at        DATETIME   NOT NULL DEFAULT NOW() ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (pipeline_id),
  CONSTRAINT fk_pipeline_lead FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ──────────────────────────────────────────────────────────────
-- 5. Seed default bilingual templates
--    (safe to re-run — INSERT IGNORE)
-- ──────────────────────────────────────────────────────────────

-- WhatsApp — English
INSERT IGNORE INTO message_templates (template_id, name, channel, language, body) VALUES
  (UUID(), 'welcome_en',       'whatsapp', 'en', 'Hi {{name}}! 👋 Welcome to FitHer. We are excited to have you on your fitness journey. How can we help you today?'),
  (UUID(), 'followup_1_en',    'whatsapp', 'en', 'Hi {{name}}, just checking in! 💪 Have you had a chance to explore our fitness programs? We would love to help you get started.'),
  (UUID(), 'followup_2_en',    'whatsapp', 'en', 'Hey {{name}}! 🌟 Still thinking about joining FitHer? Our team is here to answer any questions you might have.'),
  (UUID(), 'inactivity_24h_en','whatsapp', 'en', 'Hi {{name}}, we noticed you have not been active recently. 🏃‍♀️ Your fitness journey is waiting — come back and let us help you reach your goals!'),
  (UUID(), 'inactivity_7d_en', 'whatsapp', 'en', 'Hey {{name}}! It has been a week since we heard from you. 💙 We miss you! Remember, consistency is the key to results. Ready to get back on track?'),
  (UUID(), 'winback_en',       'whatsapp', 'en', 'Hi {{name}}, we noticed your subscription ended. 😢 We would love to have you back! Reply to this message for a special comeback offer.'),
  (UUID(), 'payment_success_en','whatsapp','en', 'Payment confirmed! ✅ Thank you {{name}}. Your FitHer subscription is now active. Let us crush those fitness goals together! 💪'),
  (UUID(), 'subscription_en',  'whatsapp', 'en', '🎉 Welcome to FitHer {{name}}! Your subscription is active. Check the app for your personalized workout plan. Let us get started!');

-- WhatsApp — Urdu
INSERT IGNORE INTO message_templates (template_id, name, channel, language, body) VALUES
  (UUID(), 'welcome_ur',       'whatsapp', 'ur', 'السلام علیکم {{name}}! 👋 FitHer میں خوش آمدید۔ آپ کے فٹنس سفر میں ہم آپ کے ساتھ ہیں۔ ہم آپ کی کیسے مدد کر سکتے ہیں؟'),
  (UUID(), 'followup_1_ur',    'whatsapp', 'ur', 'السلام علیکم {{name}}، بس ایک بار چیک کر رہے تھے! 💪 کیا آپ نے ہمارے فٹنس پروگرام دیکھے؟ شروع کرنے میں ہم آپ کی مدد کریں گے۔'),
  (UUID(), 'followup_2_ur',    'whatsapp', 'ur', 'ہیلو {{name}}! 🌟 FitHer جوائن کرنے کے بارے میں سوچ رہے ہیں؟ کوئی سوال ہو تو بتائیں، ہم حاضر ہیں۔'),
  (UUID(), 'inactivity_24h_ur','whatsapp', 'ur', 'السلام علیکم {{name}}، ہم نے نوٹ کیا کہ آپ کچھ دیر سے غائب ہیں۔ 🏃‍♀️ آپ کا فٹنس سفر آپ کا انتظار کر رہا ہے — واپس آئیں!'),
  (UUID(), 'inactivity_7d_ur', 'whatsapp', 'ur', 'ہیلو {{name}}! ایک ہفتہ ہو گیا آپ سے بات کیے۔ 💙 ہم آپ کو مس کر رہے ہیں! یاد رہے، مستقل مزاجی ہی نتائج کی کنجی ہے۔'),
  (UUID(), 'winback_ur',       'whatsapp', 'ur', 'السلام علیکم {{name}}، ہم نے دیکھا کہ آپ کی سبسکرپشن ختم ہو گئی۔ 😢 ہم آپ کو واپس دیکھنا چاہتے ہیں! خصوصی آفر کے لیے جواب دیں۔'),
  (UUID(), 'payment_success_ur','whatsapp','ur', 'ادائیگی کامیاب! ✅ شکریہ {{name}}۔ آپ کی FitHer سبسکرپشن فعال ہو گئی ہے۔ آئیں مل کر فٹنس گولز حاصل کریں! 💪'),
  (UUID(), 'subscription_ur',  'whatsapp', 'ur', '🎉 FitHer میں خوش آمدید {{name}}! آپ کی سبسکرپشن فعال ہے۔ ایپ میں اپنا ذاتی ورک آؤٹ پلان دیکھیں۔');

-- ──────────────────────────────────────────────────────────────
-- 5. Seed default automation rules
-- ──────────────────────────────────────────────────────────────

-- Welcome message when a new lead is created (WhatsApp EN)
INSERT IGNORE INTO automation_rules (rule_id, name, trigger_event, conditions, actions, channel, delay_minutes, run_once_per_person, active) VALUES
(UUID(), 'New Lead Welcome (EN)', 'lead_created',
  '{"stage":"visitor","language":"en"}',
  '[{"type":"update_stage","stage":"lead"},{"type":"send_message","template":"welcome_en","channel":"whatsapp"}]',
  'whatsapp', 2, 1, 1);

-- Welcome message when a new lead is created (WhatsApp UR)
INSERT IGNORE INTO automation_rules (rule_id, name, trigger_event, conditions, actions, channel, delay_minutes, run_once_per_person, active) VALUES
(UUID(), 'New Lead Welcome (UR)', 'lead_created',
  '{"stage":"visitor","language":"ur"}',
  '[{"type":"update_stage","stage":"lead"},{"type":"send_message","template":"welcome_ur","channel":"whatsapp"}]',
  'whatsapp', 2, 1, 1);

-- 24h inactivity follow-up (EN)
INSERT IGNORE INTO automation_rules (rule_id, name, trigger_event, conditions, actions, channel, delay_minutes, run_once_per_person, active) VALUES
(UUID(), '24h Inactivity Follow-up (EN)', 'inactivity_24h',
  '{"stage":"lead","language":"en"}',
  '[{"type":"send_message","template":"followup_1_en","channel":"whatsapp"}]',
  'whatsapp', 0, 1, 1);

-- 24h inactivity follow-up (UR)
INSERT IGNORE INTO automation_rules (rule_id, name, trigger_event, conditions, actions, channel, delay_minutes, run_once_per_person, active) VALUES
(UUID(), '24h Inactivity Follow-up (UR)', 'inactivity_24h',
  '{"stage":"lead","language":"ur"}',
  '[{"type":"send_message","template":"followup_1_ur","channel":"whatsapp"}]',
  'whatsapp', 0, 1, 1);

-- 7d inactivity follow-up (EN)
INSERT IGNORE INTO automation_rules (rule_id, name, trigger_event, conditions, actions, channel, delay_minutes, run_once_per_person, active) VALUES
(UUID(), '7d Inactivity Follow-up (EN)', 'inactivity_7d',
  '{"stage":"user","language":"en"}',
  '[{"type":"send_message","template":"inactivity_7d_en","channel":"whatsapp"}]',
  'whatsapp', 0, 1, 1);

-- 7d inactivity follow-up (UR)
INSERT IGNORE INTO automation_rules (rule_id, name, trigger_event, conditions, actions, channel, delay_minutes, run_once_per_person, active) VALUES
(UUID(), '7d Inactivity Follow-up (UR)', 'inactivity_7d',
  '{"stage":"user","language":"ur"}',
  '[{"type":"send_message","template":"inactivity_7d_ur","channel":"whatsapp"}]',
  'whatsapp', 0, 1, 1);

-- Churn win-back (EN)
INSERT IGNORE INTO automation_rules (rule_id, name, trigger_event, conditions, actions, channel, delay_minutes, run_once_per_person, active) VALUES
(UUID(), 'Churn Win-back (EN)', 'churn_detected',
  '{"language":"en"}',
  '[{"type":"send_message","template":"winback_en","channel":"whatsapp"}]',
  'whatsapp', 10080, 1, 1);

-- Churn win-back (UR) — fires 7 days (10080 min) after churn
INSERT IGNORE INTO automation_rules (rule_id, name, trigger_event, conditions, actions, channel, delay_minutes, run_once_per_person, active) VALUES
(UUID(), 'Churn Win-back (UR)', 'churn_detected',
  '{"language":"ur"}',
  '[{"type":"send_message","template":"winback_ur","channel":"whatsapp"}]',
  'whatsapp', 10080, 1, 1);

-- Payment success confirmation (any language — uses "any" channel)
INSERT IGNORE INTO automation_rules (rule_id, name, trigger_event, conditions, actions, channel, delay_minutes, run_once_per_person, active) VALUES
(UUID(), 'Payment Success Confirmation', 'payment_success',
  '{"language":"en"}',
  '[{"type":"send_message","template":"payment_success_en","channel":"any"},{"type":"update_stage","stage":"user"}]',
  'any', 0, 1, 1);

-- =============================================================
-- Done. Verify:
--   SHOW TABLES;
--   SELECT name, trigger_event, channel FROM automation_rules;
--   SELECT name, channel, language FROM message_templates;
-- =============================================================
