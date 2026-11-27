/**
 * followupEngine.js — Layer 5 cron worker.
 *
 * Runs every 15 minutes. For each non-paused lead with an interaction_status
 * that has a follow-up template:
 *   1. Check silence_hours since last_message_at
 *   2. Enforce global rules (window, gap, daily cap, max consecutive, kill switches)
 *   3. If Tier 1 + working off-hours + auto enabled → send via WhatsApp
 *      If Tier 2 OR working hours → create ai_replies draft for rep
 *
 * Soft-launch period: ALL fires are forced to drafts regardless of tier.
 */

const cron = require("node-cron");
const { Op } = require("sequelize");
const sequelize = require("../config/database");
const { People } = require("../../models");
const { keyFor, TEMPLATES, pickVariant, renderTemplate, stepsFor } = require("../ai/followupTemplates");
const { v4: uuidv4 } = require("uuid");

const PKT_OFFSET_MS = 5 * 60 * 60 * 1000; // +05:00

const FOLLOWUP_LOG_TABLE = "intent_followup_queue";


// Admin rule: women inside a campaign are left to the campaign's own ladder.
const CAMPAIGN_LADDER_SQL = "NOT " + require("../services/followupSwitches").insideCampaignSql("`People`.`id`");

// ── TEST-MODE ENV FLAGS ───────────────────────────────────────────
// FOLLOWUP_FAST_MODE=true
//   Treats every template's `silence_hours` as `silence_minutes`. So a
//   template with silence_hours=24 fires after 24 MINUTES of silence
//   instead of 24 hours. Default cron also drops to */1 * * * * so the
//   engine scans every minute. Working-hours window is also bypassed.
//   Use ONLY for local/dev testing. Prepends "[TEST] " to draft text.
//
// FOLLOWUP_FORCE_DRAFT=true
//   Belt-and-suspenders: every fire becomes a draft, never auto-send,
//   regardless of what the kill-switch settings or the template tier say.
//   Pairs well with FAST_MODE for testing without worrying about a
//   real customer accidentally getting a test message.
const FAST_MODE    = process.env.FOLLOWUP_FAST_MODE === "true";
const FORCE_DRAFT  = process.env.FOLLOWUP_FORCE_DRAFT === "true";
const TIME_UNIT_MS = FAST_MODE ? 60 * 1000 : 60 * 60 * 1000; // minute vs hour
const SCAN_DEFAULT = FAST_MODE ? "*/1 * * * *" : "*/15 * * * *";

// ──────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────

async function getSettings() {
  const [rows] = await sequelize.query("SELECT setting_key, setting_value FROM layer_system_settings");
  const map = {};
  rows.forEach(r => { map[r.setting_key] = r.setting_value; });
  return {
    globalAutoSendEnabled:  map.global_auto_send_enabled === "1",
    softLaunchMode:         map.soft_launch_mode === "1",
    softLaunchStartedAt:    map.soft_launch_started_at || null,
    maxConsecutive:         parseInt(map.max_consecutive_followups || "3", 10),
    minGapHours:            parseInt(map.min_gap_between_msgs_hours || "18", 10),
    dailyCap:               parseInt(map.daily_cap_per_lead || "2", 10),
    workStart:              parseInt(map.working_hours_start || "9", 10),
    workEnd:                parseInt(map.working_hours_end || "21", 10),
    // Admin switches (migration 052). Missing row = old behaviour (on / skip).
    followupsEnabled:       map.followups_enabled !== "0",
    skipCampaignLadder:     map.followups_skip_campaign_ladder !== "0",
  };
}

function pktHour(now = new Date()) {
  const pkt = new Date(now.getTime() + PKT_OFFSET_MS);
  return pkt.getUTCHours();
}

function isWorkingHours(settings) {
  const h = pktHour();
  return h >= settings.workStart && h < settings.workEnd;
}

async function countSystemMessagesInWindow(leadId, hours) {
  const [rows] = await sequelize.query(
    `SELECT COUNT(*) AS c FROM ${FOLLOWUP_LOG_TABLE}
       WHERE lead_id = ? AND fired_at IS NOT NULL
       AND fired_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)`,
    { replacements: [leadId, hours] }
  );
  return Number(rows[0]?.c || 0);
}

async function consecutiveFollowupsLast30d(leadId) {
  const [rows] = await sequelize.query(
    `SELECT COUNT(*) AS c FROM ${FOLLOWUP_LOG_TABLE}
       WHERE lead_id = ? AND status IN ('sent','drafted')
       AND fired_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)`,
    { replacements: [leadId] }
  );
  return Number(rows[0]?.c || 0);
}

// Nov 2026 sequences: where is this lead in her follow-up sequence?
// Counted from HER last message — a reply from her starts a new sequence.
async function sequenceState(person) {
  const [[r]] = await sequelize.query(
    "SELECT MAX(created_at) AS t FROM messages WHERE lead_id = :id AND direction = 'IN'",
    { replacements: { id: person.id } }
  );
  const lastInboundAt = (r && r.t) ? new Date(r.t) : new Date(person.created_at || person.last_message_at || Date.now());
  const [[d]] = await sequelize.query(
    `SELECT COUNT(*) AS c FROM ${FOLLOWUP_LOG_TABLE}
       WHERE lead_id = :id AND status IN ('sent','drafted') AND fired_at > :since`,
    { replacements: { id: person.id, since: lastInboundAt } }
  );
  // A follow-up draft the rep hasn't decided on yet → don't stack another.
  const [[p]] = await sequelize.query(
    "SELECT COUNT(*) AS c FROM ai_replies WHERE lead_id = :id AND status = 'draft' AND user_message LIKE '[layer5_followup:%'",
    { replacements: { id: person.id } }
  );
  return { lastInboundAt, stepsDone: Number(d.c || 0), pendingDraft: Number(p.c || 0) > 0 };
}

async function logFollowup(row) {
  await sequelize.query(
    `INSERT INTO ${FOLLOWUP_LOG_TABLE}
       (lead_id, trigger_status, trigger_goal, template_key, scheduled_for,
        send_tier, status, fired_at, message_id, ai_reply_id, skip_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    {
      replacements: [
        row.lead_id, row.trigger_status, row.trigger_goal || null, row.template_key,
        row.scheduled_for || new Date(), row.send_tier, row.status,
        row.fired_at || null, row.message_id || null, row.ai_reply_id || null,
        row.skip_reason || null,
      ],
    }
  );
}

/**
 * incrementCategoryMetric — bump counters in `category_metrics`.
 *
 * IMPORTANT: this function ONLY bumps `total_fires`. The decision
 * counters (approved_count / edited_count / rejected_count / auto_sent_count)
 * are owned by editCapture.js — they update when the REP actually decides,
 * not when the engine creates a draft.
 *
 * Previous bug: this function used to pre-bump `edited_count` at draft
 * creation time, which made every template's edit_rate >= 100% and
 * mathematically prevented graduation. Fixed: only `total_fires` here.
 *
 * `field` parameter retained for backward compatibility but is ignored
 * unless it is "auto_sent_count" — auto-send IS a kind of fire the engine
 * directly owns (no rep involved), so we still log it from here.
 */
async function incrementCategoryMetric(templateKey, field) {
  if (field === "auto_sent_count") {
    // Engine-owned counter: bump fires + auto_sent in one go
    await sequelize.query(
      `INSERT INTO category_metrics (template_key, metric_date, total_fires, auto_sent_count)
         VALUES (?, CURDATE(), 1, 1)
         ON DUPLICATE KEY UPDATE total_fires = total_fires + 1, auto_sent_count = auto_sent_count + 1`,
      { replacements: [templateKey] }
    );
    return;
  }

  // Default: only bump total_fires. Rep decision counters wait for editCapture.
  await sequelize.query(
    `INSERT INTO category_metrics (template_key, metric_date, total_fires)
       VALUES (?, CURDATE(), 1)
       ON DUPLICATE KEY UPDATE total_fires = total_fires + 1`,
    { replacements: [templateKey] }
  );
}

async function createAiReplyDraft(person, replyText, templateKey) {
  const replyId = uuidv4();
  await sequelize.query(
    `INSERT INTO ai_replies
       (reply_id, lead_id, message_id, user_message, ai_response,
        retrieved_chunks, confidence, escalate_reason, status)
     VALUES (?, ?, NULL, ?, ?, ?, ?, NULL, 'draft')`,
    {
      replacements: [
        replyId, person.id,
        `[layer5_followup:${templateKey}]`,
        replyText,
        JSON.stringify([]),
        0.85,
      ],
    }
  );
  return replyId;
}

async function sendWhatsAppNow(person, text) {
  try {
    const { send: sendWA } = require("../channels/whatsappChannel");
    return await sendWA(person, text);
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ──────────────────────────────────────────────────────────────────
// Main scan
// ──────────────────────────────────────────────────────────────────

let isRunning = false; // prevents overlapping scans (a slow scan + next cron tick)

async function scanAndFire(io) {
  if (isRunning) {
    console.log("[Followup] previous scan still running — skipping this tick");
    return 0;
  }
  isRunning = true;
  try {
    return await _scanAndFire(io);
  } finally {
    isRunning = false;
  }
}

let _loggedStopped = false;
async function _scanAndFire(io) {
  const settings = await getSettings();
  if (!settings.followupsEnabled) {
    if (!_loggedStopped) console.log("[Followup] general follow-ups are STOPPED by admin (followups_enabled = 0)");
    _loggedStopped = true;
    return 0;
  }
  _loggedStopped = false;
  const minGapHours = Number.isFinite(settings.minGapHours) && settings.minGapHours >= 0 ? settings.minGapHours : 18;

  // Build list of (status × silence_hours) we need to check
  const triggers = [];
  for (const [key, t] of Object.entries(TEMPLATES)) {
    const steps = stepsFor(key);
    if (!steps.length) continue; // no follow-ups for this status (e.g. rep reminders)
    triggers.push({ key, ...t, silence_hours: steps[0] });
  }

  // Group by status to query DB once per status
  const statusToHours = new Map();
  for (const t of triggers) {
    const [status] = t.key.split("__");
    if (!statusToHours.has(status)) statusToHours.set(status, Infinity);
    statusToHours.set(status, Math.min(statusToHours.get(status), t.silence_hours));
  }

  let fired = 0;
  for (const [status, minHours] of statusToHours.entries()) {
    // In FAST_MODE, minHours is interpreted as MINUTES — see top of file.
    const cutoff = new Date(Date.now() - minHours * TIME_UNIT_MS);

    if (status === "opted_out") continue; // never follow up an opt-out

    const candidates = await People.findAll({
      where: {
        [Op.and]: [
          {
            interaction_status: status,
            auto_followup_paused: false,
            // 'churned' = paid before, plan ended: she replied to a win-back
            // and went quiet, so she gets follow-ups too (written as a welcome
            // back, see ai/followupWriter.js). 'user' (paying now) never does:
            // members get care, not sales follow-ups.
            stage: { [Op.in]: ["visitor","lead","churned"] },
            last_message_at: { [Op.lt]: cutoff },
          },
          // Not on the do-not-contact list.
          sequelize.literal("NOT EXISTS (SELECT 1 FROM dnc_list d WHERE d.lead_id = `People`.`id`)"),
          // Admin rule: leave women inside a campaign to the campaign's own
          // Touch 2 / Touch 3 ladder (see CAMPAIGN_LADDER_SQL).
          ...(settings.skipCampaignLadder ? [sequelize.literal(CAMPAIGN_LADDER_SQL)] : []),
          // Not still inside the min-gap since the last fired follow-up.
          sequelize.literal(
            `NOT EXISTS (SELECT 1 FROM ${FOLLOWUP_LOG_TABLE} q
                          WHERE q.lead_id = \`People\`.\`id\` AND q.fired_at IS NOT NULL
                            AND q.fired_at >= DATE_SUB(NOW(), INTERVAL ${Math.floor(minGapHours)} HOUR))`
          ),
        ],
      },
      order: [["last_message_at", "ASC"]], // oldest silence first
      limit: 200,
    });

    for (const person of candidates) {
      const templateKey = keyFor(person.interaction_status, person.main_goal);
      if (!templateKey) continue;

      const tplDef = TEMPLATES[templateKey];

      // Sequence: which step is due, if any.
      const steps = stepsFor(templateKey);
      const seq = await sequenceState(person);
      if (seq.pendingDraft) continue;                 // rep hasn't decided the last one
      if (seq.stepsDone >= steps.length) continue;    // sequence finished — wait for her
      const hoursSilent = (Date.now() - seq.lastInboundAt.getTime()) / TIME_UNIT_MS;
      if (hoursSilent < steps[seq.stepsDone]) continue; // next step not due yet

      // Enforce min-gap, daily cap, max-consecutive. (Min-gap is already
      // filtered in the query; this re-check is a cheap safety net and is NOT
      // logged — a routine "within gap" skip would flood the log table.)
      const sentLastGap = await countSystemMessagesInWindow(person.id, minGapHours);
      if (sentLastGap > 0) continue;
      const sentToday = await countSystemMessagesInWindow(person.id, 24);
      if (sentToday >= settings.dailyCap) {
        await logFollowup({
          lead_id: person.id, trigger_status: status, trigger_goal: person.main_goal,
          template_key: templateKey, send_tier: tplDef.tier, status: "skipped",
          skip_reason: "daily_cap",
        });
        continue;
      }
      // "Consecutive" = follow-ups since HER last message (she replied → reset),
      // not every follow-up in 30 days (that silenced active leads for a month).
      const consec30d = seq.stepsDone;
      if (consec30d >= settings.maxConsecutive) {
        await logFollowup({
          lead_id: person.id, trigger_status: status, trigger_goal: person.main_goal,
          template_key: templateKey, send_tier: tplDef.tier, status: "skipped",
          skip_reason: "max_consecutive_30d",
        });
        continue;
      }

      // Fiza writes the follow-up from the real chat; the template is only a
      // fallback (and then only as a rep draft, never auto-sent).
      const { writeFollowup } = require("../ai/followupWriter");
      const written = await writeFollowup(person, templateKey, {
        stepIndex: seq.stepsDone, totalSteps: steps.length, hoursSilent,
      });
      const rendered = written || renderTemplate(pickVariant(templateKey, fired), person);
      // In FAST_MODE, prepend [TEST] so the rep knows this is a test fire.
      const text = FAST_MODE ? `[TEST] ${rendered}` : rendered;

      // Decision: tier1 auto-send vs draft
      const isWorkHrs    = isWorkingHours(settings);
      let canAutoSend  =
        !FORCE_DRAFT && // env override — kills all auto-send in testing
        settings.globalAutoSendEnabled &&
        !settings.softLaunchMode &&
        tplDef.tier === "tier1_auto" &&
        (FAST_MODE || !isWorkHrs) && // off-hours only per spec; FAST_MODE bypasses
        !!written; // a fallback template is never auto-sent

      // Master kill-switch + unified send gate. If either says no, downgrade to
      // a draft (the rep can still decide) rather than auto-blasting it.
      if (canAutoSend) {
        try {
          const { canSendProactive, isAutomationPaused } = require("../services/sendGate");
          if (await isAutomationPaused()) {
            console.log(`[Followup] automation paused — downgrading lead ${person.id} to draft`);
            canAutoSend = false;
          } else {
            const gate = await canSendProactive(person, { accountId: person.whatsapp_account_id, source: "followup" });
            if (!gate.allowed) {
              console.log(`[Followup] gate denied auto-send for lead ${person.id} (${gate.reason}) — downgrading to draft`);
              canAutoSend = false;
            }
            // Who answers her (services/replyOwner.js). An explicit "a person
            // has her" — admin took over, a rep replied in the last 24 h, her
            // rep is on Assist, a campaign on Assist — turns the follow-up into
            // a draft for the rep. The bare channel default is not a choice
            // anyone made, so then the follow-up's own rules decide, as before.
            if (canAutoSend) {
              const d = await require("../services/replyOwner").whoReplies(person, { channel: "whatsapp" });
              if (d.who === "rep" && !/^default_for_/.test(d.why)) {
                console.log(`[Followup] lead ${person.id} → rep (${d.why}) — downgrading to draft`);
                canAutoSend = false;
              }
            }
          }
        } catch (e) {
          console.error("[Followup] gate check failed (allowing):", e.message);
        }
      }

      if (canAutoSend) {
        const result = await sendWhatsAppNow(person, text);
        if (result.success) {
          // Persist the auto-sent follow-up + bump last_message_at so the next
          // scan won't immediately re-fire and Fiza won't double up on it.
          let outMsgId = null;
          try {
            const { recordOutbound } = require("../services/outboundMessage");
            outMsgId = await recordOutbound(person, {
              text,
              channel: "whatsapp",
              externalId: result.messageId,
              repId: person.assigned_to,
              io,
              proactive: true,
              source: "followup",
              templateKey,
              from: "system", // automated — not a person talking to her
            });
          } catch (e) {
            console.error("[Followup] recordOutbound failed:", e.message);
          }
          await logFollowup({
            lead_id: person.id, trigger_status: status, trigger_goal: person.main_goal,
            template_key: templateKey, send_tier: tplDef.tier,
            status: "sent", fired_at: new Date(),
            message_id: result.messageId || outMsgId || null,
          });
          await incrementCategoryMetric(templateKey, "auto_sent_count");
          fired++;
          if (io && person.assigned_to) {
            io.to(`rep_${person.assigned_to}`).emit("followupSent", {
              lead_id: person.id, template_key: templateKey, text,
            });
          }
        } else {
          // Auto-send failed → fall back to draft
          const replyId = await createAiReplyDraft(person, text, templateKey);
          await logFollowup({
            lead_id: person.id, trigger_status: status, trigger_goal: person.main_goal,
            template_key: templateKey, send_tier: tplDef.tier,
            status: "drafted", fired_at: new Date(), ai_reply_id: replyId,
            skip_reason: `auto_send_failed:${result.error || "unknown"}`,
          });
          // Fire happened (just fell back to draft). Only bump total_fires —
          // Fire happened (just fell back to draft). Only bump total_fires --
          // decision counters are set later by editCapture when the rep decides.
          await incrementCategoryMetric(templateKey);
        }
      } else {
        // Tier 2 / soft launch / working hours / FORCE_DRAFT -> draft for rep
        const replyId = await createAiReplyDraft(person, text, templateKey);
        await logFollowup({
          lead_id: person.id, trigger_status: status, trigger_goal: person.main_goal,
          template_key: templateKey, send_tier: tplDef.tier,
          status: "drafted", fired_at: new Date(), ai_reply_id: replyId,
        });
        // Fire happened. Only bump total_fires -- decision counters
        // (approved / edited / rejected) are set later by editCapture.
        await incrementCategoryMetric(templateKey);
        fired++;
        if (io && person.assigned_to) {
          io.to(`rep_${person.assigned_to}`).emit("aiDraftReady", {
            reply_id: replyId, lead_id: person.id, draft: text,
            confidence: 0.85, source: "layer5_followup", template_key: templateKey,
          });
        }
      }
    }
  }

  if (fired > 0) console.log(`[Followup] Fired ${fired} follow-up(s) in this scan`);
  return fired;
}

function startFollowupEngine(io) {
  sequelize.query(
    `INSERT IGNORE INTO layer_system_settings (setting_key, setting_value, description) VALUES
      ('followups_enabled', '1', 'General follow-ups on (1) or stopped (0). Campaign follow-ups are separate.'),
      ('followups_skip_campaign_ladder', '1', 'Skip women inside a campaign (queued, Touch 2/3 pending, or campaign message in last 7 days with no reply).')`
  ).catch((e) => console.warn("[FollowupEngine] could not seed switches:", e.message));
  const schedule = process.env.FOLLOWUP_CRON || SCAN_DEFAULT;
  cron.schedule(schedule, require("../monitor/jobs").wrap("followups", () => scanAndFire(io)));
  console.log(`[FollowupEngine] Scheduled (cron: ${schedule})`);
  if (FAST_MODE)   console.log("[FollowupEngine] FAST_MODE - silence_hours interpreted as MINUTES");
  if (FORCE_DRAFT) console.log("[FollowupEngine] FORCE_DRAFT - all fires become drafts (no auto-send)");
}

module.exports = { startFollowupEngine, scanAndFire };
