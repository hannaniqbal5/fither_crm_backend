/**
 * autoCampaign.service.js — Automated trigger-based campaign engine.
 *
 * Runs on a cron (every 30 min). For each active rule:
 *   1. Finds leads matching the trigger condition
 *   2. Applies guard rails (cooldown, rep active, lead replied, max sends, DNC)
 *   3. Sends message via WhatsApp (and/or app push)
 *   4. Logs the send in auto_campaign_sends
 *
 * Trigger events and their SQL conditions are defined in TRIGGER_QUERIES.
 */

const sequelize = require("../config/database");
const { recordOutbound } = require("./outboundMessage");
const whatsapp = require("../channels/whatsappChannel");

// ── Template variables ──────────────────────────────────────────────────────

function renderTemplate(template, lead, rule) {
  const vars = {
    name: lead.name || "there",
    phone: lead.phone || "",
    rep_name: lead.rep_name || "your coach",
    plan_name: lead.subscription_plan_title || "your plan",
    trial_days_left: lead.trial_days_left != null ? String(lead.trial_days_left) : "a few",
    days_quiet: lead.days_quiet != null ? String(lead.days_quiet) : "a while",
  };
  let out = template;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replace(new RegExp(`\\{${k}\\}`, "g"), v);
  }
  return out;
}

// ── Trigger queries ─────────────────────────────────────────────────────────
// Each returns leads matching the trigger, with extra computed columns.
// :delay_hours is injected from the rule.

const TRIGGER_QUERIES = {
  // Signed up on app, didn't finish onboarding
  onboarding_stalled: `
    SELECT l.id, l.name, l.phone, l.whatsapp_jid, l.whatsapp_account_id,
           l.assigned_to, r.name AS rep_name,
           l.app_onboarding_step, l.subscription_plan_title
    FROM leads l
    LEFT JOIN sales_reps r ON r.id = l.assigned_to
    WHERE l.app_signed_up_at IS NOT NULL
      AND l.app_onboarded_at IS NULL
      AND l.app_signed_up_at < NOW() - INTERVAL :delay_hours HOUR
      AND l.stage != 'churned'
  `,

  // Trial started, no class joined after X hours
  trial_no_class: `
    SELECT l.id, l.name, l.phone, l.whatsapp_jid, l.whatsapp_account_id,
           l.assigned_to, r.name AS rep_name,
           DATEDIFF(NOW(), l.trial_started_at) AS trial_days_left,
           l.subscription_plan_title
    FROM leads l
    LEFT JOIN sales_reps r ON r.id = l.assigned_to
    WHERE l.trial_started_at IS NOT NULL
      AND l.subscription_status = 'trial'
      AND l.trial_classes_attended = 0
      AND l.trial_started_at < NOW() - INTERVAL :delay_hours HOUR
  `,

  // Trial ending soon (within 48h), hasn't paid
  trial_ending: `
    SELECT l.id, l.name, l.phone, l.whatsapp_jid, l.whatsapp_account_id,
           l.assigned_to, r.name AS rep_name,
           DATEDIFF(l.trial_expires_at, NOW()) AS trial_days_left,
           l.subscription_plan_title
    FROM leads l
    LEFT JOIN sales_reps r ON r.id = l.assigned_to
    WHERE l.subscription_status = 'trial'
      AND l.trial_expires_at IS NOT NULL
      AND l.trial_expires_at BETWEEN NOW() AND NOW() + INTERVAL 48 HOUR
      AND l.stage != 'user'
  `,

  // Subscription expiring within 5 days
  subscription_expiring: `
    SELECT l.id, l.name, l.phone, l.whatsapp_jid, l.whatsapp_account_id,
           l.assigned_to, r.name AS rep_name,
           DATEDIFF(l.subscription_expires_at, NOW()) AS trial_days_left,
           l.subscription_plan_title
    FROM leads l
    LEFT JOIN sales_reps r ON r.id = l.assigned_to
    WHERE l.subscription_status = 'active'
      AND l.subscription_expires_at BETWEEN NOW() AND NOW() + INTERVAL 5 DAY
  `,

  // Lead gone quiet — no messages in X days
  gone_quiet: `
    SELECT l.id, l.name, l.phone, l.whatsapp_jid, l.whatsapp_account_id,
           l.assigned_to, r.name AS rep_name,
           DATEDIFF(NOW(), COALESCE(l.last_activity_at, l.created_at)) AS days_quiet,
           l.subscription_plan_title
    FROM leads l
    LEFT JOIN sales_reps r ON r.id = l.assigned_to
    WHERE l.stage NOT IN ('churned', 'user')
      AND COALESCE(l.last_activity_at, l.created_at) < NOW() - INTERVAL :delay_hours HOUR
  `,

  // Post-signup welcome (first 24h)
  post_signup: `
    SELECT l.id, l.name, l.phone, l.whatsapp_jid, l.whatsapp_account_id,
           l.assigned_to, r.name AS rep_name,
           l.subscription_plan_title
    FROM leads l
    LEFT JOIN sales_reps r ON r.id = l.assigned_to
    WHERE l.app_signed_up_at IS NOT NULL
      AND l.app_signed_up_at BETWEEN NOW() - INTERVAL :delay_hours HOUR - INTERVAL 30 MINUTE
                                   AND NOW() - INTERVAL :delay_hours HOUR + INTERVAL 30 MINUTE
  `,
};

// ── Guard checks ────────────────────────────────────────────────────────────

async function shouldSkip(rule, lead) {
  // 1. Max sends per lead reached?
  const [sentRows] = await sequelize.query(
    `SELECT COUNT(*) AS cnt FROM auto_campaign_sends
     WHERE rule_id = ? AND lead_id = ? AND status != 'skipped'`,
    { replacements: [rule.id, lead.id] }
  );
  if ((sentRows[0]?.cnt || 0) >= rule.max_sends_per_lead) {
    return "max_reached";
  }

  // 2. Cooldown — any auto-campaign sent to this lead recently?
  const [cooldownRows] = await sequelize.query(
    `SELECT 1 FROM auto_campaign_sends
     WHERE lead_id = ? AND status != 'skipped'
       AND sent_at > NOW() - INTERVAL ? HOUR
     LIMIT 1`,
    { replacements: [lead.id, rule.cooldown_hours] }
  );
  if (cooldownRows.length > 0) return "cooldown";

  // 3. Rep messaged recently?
  if (rule.skip_if_rep_active) {
    const [repRows] = await sequelize.query(
      `SELECT 1 FROM messages
       WHERE lead_id = ? AND \`from\` = 'rep'
         AND created_at > NOW() - INTERVAL ? HOUR
       LIMIT 1`,
      { replacements: [lead.id, rule.rep_active_hours] }
    );
    if (repRows.length > 0) return "rep_active";
  }

  // 4. Lead replied recently?
  if (rule.skip_if_lead_replied) {
    const [replyRows] = await sequelize.query(
      `SELECT 1 FROM messages
       WHERE lead_id = ? AND direction = 'IN'
         AND created_at > NOW() - INTERVAL ? HOUR
       LIMIT 1`,
      { replacements: [lead.id, rule.rep_active_hours] }
    );
    if (replyRows.length > 0) return "lead_replied";
  }

  // 5. DNC list?
  if (lead.phone) {
    const [dncRows] = await sequelize.query(
      `SELECT 1 FROM dnc_list WHERE phone = ? LIMIT 1`,
      { replacements: [lead.phone] }
    );
    if (dncRows.length > 0) return "dnc";
  }

  // 6. No WhatsApp JID?
  if (rule.channel !== "app_push" && !lead.whatsapp_jid) {
    return "no_jid";
  }

  return null; // all clear
}

// ── Send one message ────────────────────────────────────────────────────────

async function sendCampaignMessage(rule, lead) {
  const skip = await shouldSkip(rule, lead);
  if (skip) {
    await sequelize.query(
      `INSERT INTO auto_campaign_sends (rule_id, lead_id, channel, status, skip_reason)
       VALUES (?, ?, ?, 'skipped', ?)`,
      { replacements: [rule.id, lead.id, rule.channel, skip] }
    );
    return { sent: false, skip };
  }

  const text = renderTemplate(rule.message_template, lead, rule);

  // Send via WhatsApp
  if (rule.channel === "whatsapp" || rule.channel === "both") {
    try {
      const result = await whatsapp.send(lead, text, rule.media_url || null);
      if (result.success) {
        // Log in messages table so rep sees it in chat
        await recordOutbound(lead, {
          text,
          channel: "whatsapp",
          externalId: result.messageId,
          from: "system",
          mediaUrl: rule.media_url || null,
        });

        await sequelize.query(
          `INSERT INTO auto_campaign_sends
             (rule_id, lead_id, channel, message_sent, media_url, status, wa_message_id)
           VALUES (?, ?, 'whatsapp', ?, ?, 'sent', ?)`,
          { replacements: [rule.id, lead.id, text, rule.media_url || null, result.messageId || null] }
        );
        return { sent: true, messageId: result.messageId };
      } else {
        await sequelize.query(
          `INSERT INTO auto_campaign_sends
             (rule_id, lead_id, channel, message_sent, status, skip_reason)
           VALUES (?, ?, 'whatsapp', ?, 'failed', ?)`,
          { replacements: [rule.id, lead.id, text, result.error || "send_failed"] }
        );
        return { sent: false, skip: result.error };
      }
    } catch (e) {
      console.error(`[AutoCampaign] WhatsApp send failed for lead ${lead.id}:`, e.message);
      return { sent: false, skip: e.message };
    }
  }

  // TODO: app_push channel via partner_backend
  return { sent: false, skip: "channel_not_implemented" };
}

// ── Main engine tick ────────────────────────────────────────────────────────

async function tick() {
  const [rules] = await sequelize.query(
    `SELECT * FROM auto_campaign_rules WHERE is_active = 1`
  );

  if (!rules.length) return { rules: 0, sent: 0, skipped: 0 };

  let totalSent = 0;
  let totalSkipped = 0;

  for (const rule of rules) {
    const queryTemplate = TRIGGER_QUERIES[rule.trigger_event];
    if (!queryTemplate) {
      console.warn(`[AutoCampaign] Unknown trigger: ${rule.trigger_event}`);
      continue;
    }

    // Apply extra JSON conditions
    let extraWhere = "";
    if (rule.conditions) {
      const conds = typeof rule.conditions === "string" ? JSON.parse(rule.conditions) : rule.conditions;
      if (conds.subscription_status) extraWhere += ` AND l.subscription_status = ${sequelize.escape(conds.subscription_status)}`;
      if (conds.stage) extraWhere += ` AND l.stage = ${sequelize.escape(conds.stage)}`;
      if (conds.source) extraWhere += ` AND l.source = ${sequelize.escape(conds.source)}`;
    }

    const query = queryTemplate + extraWhere + " LIMIT 50";

    const [leads] = await sequelize.query(query, {
      replacements: { delay_hours: rule.delay_hours },
    });

    for (const lead of leads) {
      const result = await sendCampaignMessage(rule, lead);
      if (result.sent) totalSent++;
      else totalSkipped++;
    }
  }

  console.log(`[AutoCampaign] tick: ${rules.length} rules, ${totalSent} sent, ${totalSkipped} skipped`);
  return { rules: rules.length, sent: totalSent, skipped: totalSkipped };
}

// ── Cron starter ────────────────────────────────────────────────────────────

function startAutoCampaignJob() {
  const cron = require("node-cron");
  // Run every 30 minutes
  cron.schedule("*/30 * * * *", require("../monitor/jobs").wrap("auto-campaign", () => tick()));
  console.log("📣 [AutoCampaign] Job scheduled (every 30 min)");
}

module.exports = { tick, startAutoCampaignJob, renderTemplate, TRIGGER_QUERIES };
