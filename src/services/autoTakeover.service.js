/**
 * autoTakeover.service.js — Fiza auto-takeover engine.
 *
 * Runs every 5 min. For each active rule:
 *   1. Finds leads with unanswered messages where rep hasn't replied within wait_minutes
 *   2. Applies guards (cooldown, max per day, business hours)
 *   3. Either generates AI reply via Fiza, or sends fallback, or just notifies rep
 *   4. Logs everything
 */

const sequelize = require("../config/database");
const { recordOutbound } = require("./outboundMessage");
const whatsapp = require("../channels/whatsappChannel");

// ── Find leads waiting for rep reply ────────────────────────────────────────

async function findWaitingLeads(rule) {
  // Leads whose last message is from 'customer' and it's been > wait_minutes
  // with no rep reply after that message
  let stageFilter = "";
  let statusFilter = "";

  if (rule.applies_to_stage) {
    const stages = typeof rule.applies_to_stage === "string"
      ? JSON.parse(rule.applies_to_stage) : rule.applies_to_stage;
    if (stages && stages.length) {
      stageFilter = ` AND l.stage IN (${stages.map(s => sequelize.escape(s)).join(",")})`;
    }
  }

  if (rule.applies_to_status) {
    const statuses = typeof rule.applies_to_status === "string"
      ? JSON.parse(rule.applies_to_status) : rule.applies_to_status;
    if (statuses && statuses.length) {
      statusFilter = ` AND l.subscription_status IN (${statuses.map(s => sequelize.escape(s)).join(",")})`;
    }
  }

  const [leads] = await sequelize.query(`
    SELECT l.id, l.name, l.phone, l.whatsapp_jid, l.whatsapp_account_id,
           l.assigned_to, l.stage, l.subscription_status,
           l.interaction_status, l.main_goal, l.last_objection, l.lead_score,
           r.name AS rep_name,
           m.id AS last_msg_id, m.body AS last_msg_body, m.created_at AS msg_time,
           TIMESTAMPDIFF(MINUTE, m.created_at, NOW()) AS waiting_minutes
    FROM leads l
    INNER JOIN messages m ON m.lead_id = l.id
    LEFT JOIN salesreps r ON r.id = l.assigned_to
    WHERE m.id = (
      SELECT MAX(m2.id) FROM messages m2 WHERE m2.lead_id = l.id
    )
    AND m.\`from\` = 'customer'
    AND m.created_at < NOW() - INTERVAL :wait MINUTE
    AND l.assigned_to IS NOT NULL
    AND l.whatsapp_jid IS NOT NULL
    ${stageFilter}
    ${statusFilter}
    -- No rep reply after that message
    AND NOT EXISTS (
      SELECT 1 FROM messages m3
      WHERE m3.lead_id = l.id
        AND m3.\`from\` IN ('rep','system','ai')
        AND m3.created_at > m.created_at
    )
    LIMIT 30
  `, { replacements: { wait: rule.wait_minutes } });

  return leads;
}

// ── Guard checks ────────────────────────────────────────────────────────────

async function shouldSkip(rule, lead) {
  // 1. Max takeovers per lead today
  const [countRows] = await sequelize.query(
    `SELECT COUNT(*) AS cnt FROM auto_takeover_log
     WHERE lead_id = ? AND action_taken = 'replied'
       AND DATE(created_at) = CURDATE()`,
    { replacements: [lead.id] }
  );
  if ((countRows[0]?.cnt || 0) >= rule.max_takeovers_per_lead) return "max_reached";

  // 2. Cooldown
  const [cooldownRows] = await sequelize.query(
    `SELECT 1 FROM auto_takeover_log
     WHERE lead_id = ? AND action_taken = 'replied'
       AND created_at > NOW() - INTERVAL ? MINUTE
     LIMIT 1`,
    { replacements: [lead.id, rule.cooldown_minutes] }
  );
  if (cooldownRows.length > 0) return "cooldown";

  // 3. Business hours check (9am-9pm PKT = UTC+5)
  if (rule.only_during_hours) {
    const [hourRows] = await sequelize.query(
      `SELECT HOUR(CONVERT_TZ(NOW(), '+00:00', '+05:00')) AS h`
    );
    const hour = hourRows[0]?.h ?? 12;
    if (hour < 9 || hour >= 21) return "outside_hours";
  }

  // 4. DNC
  if (lead.phone) {
    const [dncRows] = await sequelize.query(
      `SELECT 1 FROM dnc_list WHERE phone = ? LIMIT 1`,
      { replacements: [lead.phone] }
    );
    if (dncRows.length > 0) return "dnc";
  }

  return null;
}

// ── Generate Fiza reply (journey-aware) ──────────────────────────────────────

async function generateFizaReply(rule, lead) {
  try {
    const { generateReply } = require("../ai/reply.service");
    const { buildJourneyContext } = require("../ai/journeyContext");

    // Build journey context for this lead
    const journeyCtx = await buildJourneyContext(lead.id);

    // Build a pseudo-person object from the lead data
    const person = {
      id: lead.id,
      name: lead.name,
      phone: lead.phone,
      stage: lead.stage,
      subscription_status: lead.subscription_status,
      interaction_status: lead.interaction_status || null,
      main_goal: lead.main_goal || null,
      last_objection: lead.last_objection || null,
      lead_score: lead.lead_score || 0,
      whatsapp_jid: lead.whatsapp_jid,
      whatsapp_account_id: lead.whatsapp_account_id,
    };

    // Manager instructions become extra context in the journey block
    let enrichedJourney = journeyCtx || "";
    if (rule.fiza_prompt) {
      enrichedJourney += "\n\n# MANAGER INSTRUCTIONS FOR THIS AUTO-REPLY\n" + rule.fiza_prompt;
    }
    enrichedJourney += "\n\n# AUTO-TAKEOVER CONTEXT\n";
    enrichedJourney += "You are auto-replying because the rep hasn't responded in " + rule.wait_minutes + " minutes.\n";
    enrichedJourney += "Be helpful but let her know her coach will also follow up.\n";
    enrichedJourney += "Keep it natural — she shouldn't feel like she's talking to a bot.";

    // Use the real AI pipeline — it picks mode, retrieves KB, builds full prompt
    // We pass journeyContext through opts so prompt.builder includes it
    const result = await generateReply(person, lead.last_msg_body || "(no message)", lead.last_msg_id, {
      journeyContext: enrichedJourney,
    });

    if (result && result.reply) return result.reply;
  } catch (e) {
    console.error("[AutoTakeover] AI reply failed, using fallback:", e.message);
  }

  // Fallback message if AI pipeline fails
  if (rule.fallback_message) {
    return rule.fallback_message
      .replace(/\{name\}/g, lead.name || "there")
      .replace(/\{rep_name\}/g, lead.rep_name || "your coach");
  }

  return `Hi ${lead.name || "there"}! ${lead.rep_name || "Your coach"} is currently busy but will get back to you shortly. Is there anything I can help with in the meantime?`;
}

// ── Process one lead ────────────────────────────────────────────────────────

async function processLead(rule, lead) {
  const skip = await shouldSkip(rule, lead);
  if (skip) {
    await sequelize.query(
      `INSERT INTO auto_takeover_log (rule_id, lead_id, rep_id, trigger_type, wait_actual_min, action_taken, skip_reason)
       VALUES (?, ?, ?, ?, ?, 'skipped', ?)`,
      { replacements: [rule.id, lead.id, lead.assigned_to, rule.trigger_type, lead.waiting_minutes, skip] }
    );
    return { acted: false, skip };
  }

  if (rule.action === "notify_rep_only") {
    // Just notify, don't send message to lead
    await sequelize.query(
      `INSERT INTO auto_takeover_log (rule_id, lead_id, rep_id, trigger_type, wait_actual_min, action_taken)
       VALUES (?, ?, ?, ?, ?, 'notified_rep')`,
      { replacements: [rule.id, lead.id, lead.assigned_to, rule.trigger_type, lead.waiting_minutes] }
    );
    // Create escalation task for rep
    try {
      const owner = require("./owner.service");
      await owner.escalate(lead.id, "ai_takeover_nudge", {
        message: `Lead ${lead.name} has been waiting ${lead.waiting_minutes} min for a reply`,
      });
    } catch (e) { /* owner service may not have this reason */ }
    return { acted: true, action: "notified_rep" };
  }

  // Generate and send reply
  const replyText = await generateFizaReply(rule, lead);

  try {
    const result = await whatsapp.send(lead, replyText, null);
    if (result.success) {
      await recordOutbound(lead, {
        text: replyText,
        channel: "whatsapp",
        externalId: result.messageId,
        from: "ai",
        mediaUrl: null,
      });

      await sequelize.query(
        `INSERT INTO auto_takeover_log (rule_id, lead_id, rep_id, trigger_type, wait_actual_min, action_taken, message_sent)
         VALUES (?, ?, ?, ?, ?, 'replied', ?)`,
        { replacements: [rule.id, lead.id, lead.assigned_to, rule.trigger_type, lead.waiting_minutes, replyText] }
      );

      // Notify rep if configured
      if (rule.action === "reply_and_notify_rep") {
        try {
          const owner = require("./owner.service");
          await owner.escalate(lead.id, "ai_auto_replied", {
            message: `Fiza auto-replied to ${lead.name} after ${lead.waiting_minutes} min wait`,
          });
        } catch (e) { /* */ }
      }

      return { acted: true, action: "replied", messageId: result.messageId };
    }
  } catch (e) {
    console.error(`[AutoTakeover] Send failed for lead ${lead.id}:`, e.message);
  }

  return { acted: false, skip: "send_failed" };
}

// ── Main tick ───────────────────────────────────────────────────────────────

async function tick() {
  const [rules] = await sequelize.query(
    `SELECT * FROM auto_takeover_rules WHERE is_active = 1`
  );
  if (!rules.length) return { rules: 0, replied: 0, notified: 0, skipped: 0 };

  let replied = 0, notified = 0, skipped = 0;

  for (const rule of rules) {
    const leads = await findWaitingLeads(rule);

    for (const lead of leads) {
      const result = await processLead(rule, lead);
      if (!result.acted) skipped++;
      else if (result.action === "replied") replied++;
      else if (result.action === "notified_rep") notified++;
    }
  }

  if (replied + notified > 0) {
    console.log(`[AutoTakeover] tick: ${rules.length} rules, ${replied} replied, ${notified} notified, ${skipped} skipped`);
  }
  return { rules: rules.length, replied, notified, skipped };
}

// ── Cron ────────────────────────────────────────────────────────────────────

function startAutoTakeoverJob() {
  const cron = require("node-cron");
  cron.schedule("*/5 * * * *", async () => {
    try { await tick(); }
    catch (e) { console.error("[AutoTakeover] tick error:", e.message); }
  });
  console.log("🤖 [AutoTakeover] Job scheduled (every 5 min)");
}

module.exports = { tick, startAutoTakeoverJob };
