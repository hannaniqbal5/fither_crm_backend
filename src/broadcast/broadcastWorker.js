/**
 * broadcastWorker.js — paced sending engine for marketing campaigns.
 *
 * SAFETY FEATURES (anti-ban):
 *   - Randomized delay between sends (8–15 sec by default, configurable per campaign)
 *   - Per-WA-account daily cap (defaults to 400 sends/day)
 *   - Time window enforcement (defaults to 09:00–21:00 Asia/Karachi)
 *   - DNC list check before every send
 *   - Personalization (placeholders break content uniformity)
 *   - Auto-pause for recipients who reply during the campaign
 *   - Kill switch — set campaign.status = 'aborted' and worker stops
 *
 * One worker process handles all 'running' campaigns.
 * startBroadcastWorker() is called once from App.js.
 */

const sequelize = require("../config/database");
const { whatsappChannel } = (() => {
  // Lazy-import shape — also lets tests stub
  return { whatsappChannel: require("../channels/whatsappChannel") };
})();

const POLL_INTERVAL_MS = 5 * 1000; // 5s — when nothing to do
const TIMEZONE = "Asia/Karachi";

// Frequency cap: minimum days before the SAME number may receive another
// campaign message (across all campaigns). Default 7; set CAMPAIGN_COOLDOWN_DAYS=0
// in .env to disable. Prevents re-blasting someone who reappears in a new group.
const COOLDOWN_DAYS = (() => {
  const n = parseInt(process.env.CAMPAIGN_COOLDOWN_DAYS, 10);
  return Number.isFinite(n) && n >= 0 ? n : 7;
})();

// Numbers permanently excluded from EVERY campaign (admin / internal numbers).
// Matched on the last 10 digits. Default includes the admin number; add more via
// CAMPAIGN_EXCLUDED_PHONES (comma-separated). Keep in sync with campaign.routes.js.
const phoneLast10 = (p) => String(p || "").replace(/\D/g, "").slice(-10);
const EXCLUDED_PHONES = (() => {
  const set = new Set(["3055124674"]); // 03055124674 — admin's own number
  (process.env.CAMPAIGN_EXCLUDED_PHONES || "").split(",").forEach((p) => {
    const d = String(p).replace(/\D/g, "");
    if (d.length >= 10) set.add(d.slice(-10));
  });
  return set;
})();

let workerRunning = false;

// ─── Helpers ──────────────────────────────────────────────────

function nowInKarachi() {
  // Use Intl to get HH:MM in PKT
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = fmt.format(new Date()); // "HH:MM"
  return parts;
}

function todayInKarachi() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
  });
  return fmt.format(new Date()); // "YYYY-MM-DD"
}

function isInWindow(startHM, endHM) {
  const now = nowInKarachi();
  return now >= startHM && now <= endHM;
}

function randomDelayMs(minSec, maxSec) {
  const ms = (minSec + Math.random() * (maxSec - minSec)) * 1000;
  return Math.floor(ms);
}

function fillPlaceholders(body, lead, extra = {}) {
  const vars = {
    name: lead.name || lead.instagram_username || lead.facebook_name || "aapi",
    phone: lead.phone || "",
    email: lead.email || "",
    stage: lead.stage || "",
    lead_score: lead.lead_score || 0,
    ...extra,
  };
  return body.replace(/\{\{(\w+)\}\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));
}

async function getQuotaForToday(accountId) {
  const today = todayInKarachi();
  const [rows] = await sequelize.query(
    `SELECT sent_today FROM wa_account_daily_quota
      WHERE whatsapp_account_id = :acc AND quota_date = :date`,
    { replacements: { acc: accountId, date: today } }
  );
  return rows[0]?.sent_today || 0;
}

async function bumpQuota(accountId) {
  const today = todayInKarachi();
  await sequelize.query(
    `INSERT INTO wa_account_daily_quota (whatsapp_account_id, quota_date, sent_today)
     VALUES (:acc, :date, 1)
     ON DUPLICATE KEY UPDATE sent_today = sent_today + 1`,
    { replacements: { acc: accountId, date: today } }
  );
}

async function pickWAAccount(preferredId, campaignId = null) {
  // 1. Campaign pinned to a specific account → use it.
  if (preferredId) return preferredId;

  // 2. No account set: derive it from THIS campaign's own recipients rather
  //    than blindly defaulting to the first active account. With multiple
  //    connected numbers, recipients belong to the account that captured them,
  //    so sending from that same number is correct (and keeps the conversation
  //    on the right line). A campaign is sent from a single account, so we pick
  //    the account the majority of its recipients belong to.
  if (campaignId) {
    const [rows] = await sequelize.query(
      `SELECT l.whatsapp_account_id AS acc, COUNT(*) AS n
         FROM campaign_recipients cr
         JOIN leads l ON l.id = cr.lead_id
        WHERE cr.campaign_id = :cid AND l.whatsapp_account_id IS NOT NULL
        GROUP BY l.whatsapp_account_id
        ORDER BY n DESC
        LIMIT 1`,
      { replacements: { cid: campaignId } }
    );
    if (rows[0]?.acc) return rows[0].acc;
  }

  // 3. Last resort (e.g. no recipients yet): first active account.
  const [fallback] = await sequelize.query(
    `SELECT id FROM whatsapp_accounts WHERE status = 'active' ORDER BY id LIMIT 1`
  );
  return fallback[0]?.id || null;
}

// Phase 19b — Shared quota helpers
async function getAccountSettings(accountId) {
  const [rows] = await sequelize.query(
    `SELECT id, shared_daily_cap, paused_until
       FROM whatsapp_accounts WHERE id = :id LIMIT 1`,
    { replacements: { id: accountId } }
  );
  return rows[0] || { id: accountId, shared_daily_cap: 400, paused_until: null };
}

/**
 * Returns total messages sent today across ALL campaigns on this WA account.
 * Used as the HARD ceiling to prevent bursts when multiple campaigns are running.
 */
// Start of the current Asia/Karachi day (UTC+5, no DST) as a UTC Date.
function karachiDayStartUtc() {
  const [y, m, d] = todayInKarachi().split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) - 5 * 60 * 60 * 1000);
}

async function getCampaignSentToday(campaignId) {
  const [rows] = await sequelize.query(
    `SELECT COUNT(*) AS c FROM campaign_recipients
      WHERE campaign_id = :cid
        AND sent_at IS NOT NULL
        AND sent_at >= :since`,
    { replacements: { cid: campaignId, since: karachiDayStartUtc() } }
  );
  return Number(rows[0]?.c || 0);
}

// Slow start (migration 045): "100,200,350,400" → today's cap is the entry
// for this campaign's Nth sending day (days it actually sent before today,
// + 1); the last value repeats. No ramp → the fixed daily_cap.
function parseRamp(v) {
  return String(v || "").split(/[,\s]+/).map((x) => parseInt(x, 10)).filter((n) => n > 0);
}
async function getCampaignSendingDay(campaignId) {
  const [rows] = await sequelize.query(
    `SELECT COUNT(DISTINCT DATE(sent_at + INTERVAL 5 HOUR)) AS d FROM campaign_recipients
      WHERE campaign_id = :cid AND sent_at IS NOT NULL AND sent_at < :since`,
    { replacements: { cid: campaignId, since: karachiDayStartUtc() } }
  );
  return Number(rows[0]?.d || 0) + 1;
}
async function getCampaignCapToday(c) {
  const ramp = parseRamp(c.ramp_caps);
  if (!ramp.length) return { cap: c.daily_cap ? Number(c.daily_cap) : null, day: null, ramp: [] };
  const day = await getCampaignSendingDay(c.campaign_id);
  return { cap: ramp[Math.min(day, ramp.length) - 1], day, ramp };
}

async function getAccountSentToday(accountId) {
  // Reuse the existing quota counter — it's already maintained per-account
  return getQuotaForToday(accountId);
}

// ─── Core worker ──────────────────────────────────────────────

// Phase 18d — Auto-throttle on opt-out spike
async function loadThrottleSettings() {
  try {
    const [rows] = await sequelize.query(
      `SELECT setting_key, setting_value FROM layer_system_settings
        WHERE setting_key IN
          ('campaign_optout_threshold_pct',
           'campaign_optout_min_sample',
           'campaign_optout_window_minutes')`
    );
    const m = {};
    rows.forEach(r => { m[r.setting_key] = r.setting_value; });
    return {
      thresholdPct: parseFloat(m.campaign_optout_threshold_pct || "3.0"),
      minSample:    parseInt(m.campaign_optout_min_sample || "30", 10),
      windowMin:    parseInt(m.campaign_optout_window_minutes || "60", 10),
    };
  } catch {
    return { thresholdPct: 3.0, minSample: 30, windowMin: 60 };
  }
}

/**
 * Returns { triggered, rate, sent, optouts } — does NOT modify the campaign.
 * Caller decides whether to pause based on `triggered`.
 */
async function checkOptOutSpike(campaignId) {
  const settings = await loadThrottleSettings();
  // Sent in window
  const [sentRows] = await sequelize.query(
    `SELECT COUNT(*) AS c
       FROM campaign_recipients
      WHERE campaign_id = :cid AND status IN ('sent','replied')
        AND sent_at >= DATE_SUB(NOW(), INTERVAL :w MINUTE)`,
    { replacements: { cid: campaignId, w: settings.windowMin } }
  );
  const sent = Number(sentRows[0]?.c || 0);
  if (sent < settings.minSample) {
    return { triggered: false, rate: 0, sent, optouts: 0, threshold: settings.thresholdPct, sample: settings.minSample };
  }
  // Opt-outs from those recipients in same window
  const [optRows] = await sequelize.query(
    `SELECT COUNT(*) AS c
       FROM campaign_recipients cr
       JOIN dnc_list d ON d.lead_id = cr.lead_id
      WHERE cr.campaign_id = :cid
        AND cr.sent_at >= DATE_SUB(NOW(), INTERVAL :w MINUTE)
        AND d.created_at >= DATE_SUB(NOW(), INTERVAL :w MINUTE)`,
    { replacements: { cid: campaignId, w: settings.windowMin } }
  );
  const optouts = Number(optRows[0]?.c || 0);
  const rate = (optouts / sent) * 100;
  return {
    triggered: rate > settings.thresholdPct,
    rate, sent, optouts,
    threshold: settings.thresholdPct,
    sample: settings.minSample,
  };
}

async function autoPauseCampaign(campaignId, reason, evt) {
  await sequelize.query(
    `UPDATE campaigns
        SET status = 'paused',
            auto_paused_reason = :reason,
            auto_paused_at = NOW()
      WHERE campaign_id = :id AND status = 'running'`,
    { replacements: { id: campaignId, reason: reason.slice(0, 200) } }
  );
  await sequelize.query(
    `INSERT INTO campaign_auto_pause_events
       (campaign_id, event_type, reason, metric_value, threshold_value, sent_in_window, optouts_in_window)
     VALUES (:id, 'opt_out_spike', :reason, :metric, :threshold, :sent, :optouts)`,
    {
      replacements: {
        id: campaignId, reason,
        metric: evt?.rate || null,
        threshold: evt?.threshold || null,
        sent: evt?.sent || null,
        optouts: evt?.optouts || null,
      },
    }
  );
  // Push to founder admin
  try {
    const { sendPushToSalesRep } = require("../services/notificationService");
    const adminRepId = parseInt(process.env.ADMIN_REP_ID || "1", 10);
    sendPushToSalesRep(
      adminRepId,
      "⚠️ Campaign auto-paused",
      `Opt-out rate ${(evt?.rate || 0).toFixed(1)}% (${evt?.optouts}/${evt?.sent} in last ${60}min)`,
      { campaign_id: String(campaignId), event: "opt_out_spike" }
    ).catch(() => {});
  } catch {}
  console.log(`⚠️  [broadcastWorker] Auto-paused campaign ${campaignId} — ${reason}`);
}



async function processOneCampaign(campaign) {
  // Re-fetch the campaign in case its status changed (kill switch)
  const [latest] = await sequelize.query(
    `SELECT * FROM campaigns WHERE campaign_id = :id LIMIT 1`,
    { replacements: { id: campaign.campaign_id } }
  );
  const c = latest[0];
  if (!c || c.status !== "running") return false;

  // Time window
  if (!isInWindow(c.send_window_start || "09:00", c.send_window_end || "21:00")) {
    return false; // wait until window opens
  }

  // Account
  const accountId = await pickWAAccount(c.whatsapp_account_id, c.campaign_id);
  if (!accountId) {
    console.warn(`⚠️  [broadcastWorker] No active WA account for campaign ${c.campaign_id}`);
    return false;
  }

  // Phase 19b — check account-wide pause
  const acctSettings = await getAccountSettings(accountId);
  if (acctSettings.paused_until && new Date(acctSettings.paused_until) > new Date()) {
    return false; // account globally paused
  }

  // Phase 19b — HARD ceiling: shared daily cap across all campaigns on this account.
  // This is the anti-ban guard. If 3 campaigns are running on account #1 and the
  // shared cap is 400, they collectively cannot exceed 400 sends per day.
  const accountSentToday = await getAccountSentToday(accountId);
  const sharedCap = Number(acctSettings.shared_daily_cap || 400);
  if (accountSentToday >= sharedCap) {
    console.log(`🛑 [broadcastWorker] WA #${accountId} hit shared daily cap (${accountSentToday}/${sharedCap}) — campaign ${c.campaign_id} waiting`);
    return false; // wait until tomorrow (cap resets per day)
  }

  // Soft cap: per-campaign daily cap (subset of shared cap) — counts THIS
  // campaign's sends today (PKT day), not the whole account's.
  // (or today's step of its slow-start ramp).
  const { cap: capToday } = await getCampaignCapToday(c);
  if (capToday) {
    const campaignSentToday = await getCampaignSentToday(c.campaign_id);
    if (campaignSentToday >= capToday) {
      return false; // campaign-level cap reached
    }
  }

  // Phase 18d — Opt-out spike check (auto-pause if rate exceeds threshold)
  try {
    const spike = await checkOptOutSpike(c.campaign_id);
    if (spike.triggered) {
      const reason = `Opt-out spike: ${spike.rate.toFixed(1)}% (${spike.optouts}/${spike.sent}) exceeds ${spike.threshold}% threshold`;
      await autoPauseCampaign(c.campaign_id, reason, spike);
      return false;
    }
  } catch (e) {
    console.warn("[broadcastWorker] opt-out spike check failed:", e.message);
  }

  // Pick the next queued recipient that's NOT on DNC
  const [next] = await sequelize.query(
    `SELECT cr.*, l.id AS leadId, l.phone, l.name, l.whatsapp_jid, l.whatsapp_account_id,
            l.stage, l.email, l.lead_score, l.instagram_username, l.facebook_name,
            l.interaction_status,
            l.source, l.meta_page_id, l.instagram_psid, l.facebook_psid
       FROM campaign_recipients cr
       JOIN leads l ON l.id = cr.lead_id
      WHERE cr.campaign_id = :cid
        AND cr.status = 'queued'
        AND NOT EXISTS (SELECT 1 FROM dnc_list d WHERE d.lead_id = l.id)
      ORDER BY cr.id ASC
      LIMIT 1`,
    { replacements: { cid: c.campaign_id } }
  );

  if (next.length === 0) {
    // Queue empty for this campaign — mark complete
    await sequelize.query(
      `UPDATE campaigns
          SET status = 'completed', completed_at = NOW()
        WHERE campaign_id = :id AND status = 'running'`,
      { replacements: { id: c.campaign_id } }
    );
    console.log(`✅ [broadcastWorker] Campaign ${c.campaign_id} (${c.name}) completed`);
    return false;
  }

  const recipient = next[0];

  // ── Permanent exclusion (admin / internal numbers) ────────────
  // Final safety net at send time, even if such a number slipped into the queue.
  if (EXCLUDED_PHONES.has(phoneLast10(recipient.phone))) {
    await sequelize.query(
      `UPDATE campaign_recipients SET status = 'skipped', error_message = 'Excluded number'
        WHERE id = :id`,
      { replacements: { id: recipient.id } }
    );
    console.log(`⛔ [broadcastWorker] Lead #${recipient.leadId} skipped — excluded number`);
    return true; // did work — move on to the next recipient
  }

  // ── Frequency cap (cooldown) ──────────────────────────────────
  // Skip if this number already received a campaign message in the last
  // COOLDOWN_DAYS days from ANY other campaign. This is the hard guard for the
  // "same number reappears in a new group/campaign the next day" case.
  if (COOLDOWN_DAYS > 0) {
    const [recent] = await sequelize.query(
      `SELECT cr.campaign_id, cr.sent_at
         FROM campaign_recipients cr
        WHERE cr.lead_id = :lid
          AND cr.campaign_id <> :cid
          AND cr.status IN ('sent','delivered','read','replied')
          AND cr.sent_at IS NOT NULL
          AND cr.sent_at >= DATE_SUB(NOW(), INTERVAL ${COOLDOWN_DAYS} DAY)
        LIMIT 1`,
      { replacements: { lid: recipient.leadId, cid: c.campaign_id } }
    );
    if (recent.length > 0) {
      await sequelize.query(
        `UPDATE campaign_recipients
            SET status = 'skipped',
                error_message = :msg
          WHERE id = :id`,
        { replacements: { id: recipient.id, msg: `Cooldown: messaged within ${COOLDOWN_DAYS}d` } }
      );
      console.log(`⏸️  [broadcastWorker] Lead #${recipient.leadId} skipped — within ${COOLDOWN_DAYS}d cooldown`);
      return true; // did work — move on to the next recipient
    }
  }

  // Phase 19a — Cross-campaign dedup by priority.
  // If this lead is ALSO queued/sent in another active campaign on the same
  // WA account, the higher-scoring campaign wins. We use health_score if set,
  // otherwise reply_count as a proxy (newer campaigns with no replies tie-break
  // by created_at ASC so the older campaign "wins" by default).
  const [conflicts] = await sequelize.query(
    `SELECT c2.campaign_id, c2.name,
            COALESCE(c2.health_score, 0) AS health_score,
            c2.replied_count, c2.created_at
       FROM campaign_recipients cr2
       JOIN campaigns c2 ON c2.campaign_id = cr2.campaign_id
      WHERE cr2.lead_id = :lid
        AND cr2.campaign_id <> :cid
        AND cr2.status IN ('queued','sending')
        AND c2.status = 'running'
        AND (c2.whatsapp_account_id = :wa OR c2.whatsapp_account_id IS NULL)`,
    { replacements: { lid: recipient.leadId, cid: c.campaign_id, wa: accountId } }
  );

  if (conflicts.length > 0) {
    // Score this campaign vs the best competitor
    const myScore = Number(c.health_score || 0);
    const myCreated = c.created_at ? new Date(c.created_at).getTime() : Date.now();
    const winner = conflicts.reduce((best, x) => {
      const xScore = Number(x.health_score || 0);
      const xCreated = x.created_at ? new Date(x.created_at).getTime() : Date.now();
      if (xScore > best.score) return { score: xScore, created: xCreated, name: x.name, id: x.campaign_id };
      if (xScore === best.score && xCreated < best.created) return { score: xScore, created: xCreated, name: x.name, id: x.campaign_id };
      return best;
    }, { score: myScore, created: myCreated, name: c.name, id: c.campaign_id });

    if (winner.id !== c.campaign_id) {
      // Another campaign owns this lead — skip her here
      await sequelize.query(
        `UPDATE campaign_recipients
            SET status = 'deduped_by_higher_priority',
                error_message = :msg
          WHERE id = :id`,
        {
          replacements: {
            id: recipient.id,
            msg: `Skipped — lead is also in higher-priority campaign "${winner.name}"`,
          },
        }
      );
      console.log(`🔀 [broadcastWorker] Lead #${recipient.leadId} deduped — won by campaign ${winner.id} (${winner.name})`);
      return true; // counts as "did work" so the tick continues to next recipient quickly
    }
    // We won — proceed
    console.log(`🏆 [broadcastWorker] Lead #${recipient.leadId} kept on this campaign (${conflicts.length} competitor(s) lost)`);
  }

  // Unified send gate — combined per-contact frequency + per-number total load.
  // (Campaign already excludes DNC in its query; the gate adds the cross-sender
  // budget so a campaign + follow-up + automation can't pile onto one contact.)
  try {
    const { canSendProactive } = require("../services/sendGate");
    const gate = await canSendProactive(
      { id: recipient.leadId, interaction_status: recipient.interaction_status },
      { accountId, source: "campaign" }
    );
    if (!gate.allowed) {
      await sequelize.query(
        `UPDATE campaign_recipients SET status = 'skipped', error_message = :msg WHERE id = :id`,
        { replacements: { id: recipient.id, msg: `Gate: ${gate.reason}` } }
      );
      console.log(`🚦 [broadcastWorker] Lead #${recipient.leadId} skipped by send gate (${gate.reason})`);
      return true; // counts as work done — continue to next recipient
    }
  } catch (e) {
    console.error("[broadcastWorker] gate check failed (allowing):", e.message);
  }

  // Mark as sending
  await sequelize.query(
    `UPDATE campaign_recipients SET status = 'sending' WHERE id = :id`,
    { replacements: { id: recipient.id } }
  );

  try {
    return await sendToRecipient(c, recipient, accountId);
  } catch (err) {
    // Never leave a recipient stuck in 'sending' after an unexpected throw.
    try {
      const [res] = await sequelize.query(
        `UPDATE campaign_recipients
            SET status = 'failed', error_message = :err, scheduled_at = NOW()
          WHERE id = :id AND status = 'sending'`,
        { replacements: { id: recipient.id, err: `Worker error: ${String(err?.message || err)}`.slice(0, 500) } }
      );
      if (res && res.affectedRows) {
        await sequelize.query(
          `UPDATE campaigns SET failed_count = failed_count + 1 WHERE campaign_id = :id`,
          { replacements: { id: c.campaign_id } }
        );
      }
    } catch (e2) {
      console.error(`❌ [broadcastWorker] could not mark recipient ${recipient.id} failed:`, e2.message);
    }
    throw err;
  }
}

async function sendToRecipient(c, recipient, accountId) {

  // Pick a random (body, media) variant pair. body_variants is a JSON array
  // of alternative bodies; media_variants is a parallel JSON array of media
  // URLs (one per variant). Index 0 = legacy c.body + c.media_url.
  let chosenBody = c.body;
  let chosenMedia = c.media_url || null;
  try {
    let variants = c.body_variants;
    if (typeof variants === "string") variants = JSON.parse(variants);

    let mediaVariants = c.media_variants;
    if (typeof mediaVariants === "string") mediaVariants = JSON.parse(mediaVariants);
    if (!Array.isArray(mediaVariants)) mediaVariants = [];

    // Build the full pool: variant 0 (legacy body + media_url) + extra variants
    const pool = [{ body: c.body, media: c.media_url || null }];
    if (Array.isArray(variants)) {
      variants.forEach((b, i) => {
        if (typeof b === "string" && b.trim().length > 0) {
          const m = (typeof mediaVariants[i] === "string" && mediaVariants[i].trim().length > 0)
            ? mediaVariants[i].trim()
            : null;
          pool.push({ body: b, media: m });
        }
      });
    }
    const picked = pool[Math.floor(Math.random() * pool.length)];
    chosenBody = picked.body;
    chosenMedia = picked.media;
  } catch (e) {
    console.warn("[broadcastWorker] variants parse failed, falling back to legacy body+media_url:", e.message);
  }

  // Build personalized body
  const personalized = fillPlaceholders(chosenBody, recipient);

  // Send via the right channel adapter (currently WhatsApp; channel router supports IG/FB too)
  const personLike = {
    id: recipient.leadId,
    phone: recipient.phone,
    whatsapp_jid: recipient.whatsapp_jid,
    whatsapp_account_id: accountId,
    instagram_psid: recipient.instagram_psid,
    facebook_psid: recipient.facebook_psid,
    meta_page_id: recipient.meta_page_id,
    source: recipient.source,
    name: recipient.name,
  };

  // Force the channel to the campaign's channel
  const channelRouter = require("../channels/channelRouter");
  const result = await channelRouter.send(personLike, personalized, c.channel || "whatsapp", chosenMedia);

  if (result.success) {
    await sequelize.query(
      `UPDATE campaign_recipients
          SET status = 'sent',
              external_message_id = :mid,
              rendered_body = :body,
              sent_at = NOW()
        WHERE id = :id`,
      {
        replacements: {
          id: recipient.id,
          mid: result.messageId || null,
          body: personalized,
        },
      }
    );
    await sequelize.query(
      `UPDATE campaigns SET sent_count = sent_count + 1 WHERE campaign_id = :id`,
      { replacements: { id: c.campaign_id } }
    );
    await bumpQuota(accountId);

    // Mirror the campaign send into the unified message log + reset the
    // silence clock. This makes campaign messages appear in the rep's chat
    // history AND lets the follow-up engine back off any lead a campaign just
    // contacted (last_message_at moves forward) — closing the last
    // double-messaging gap. Campaign's own quota/cooldown ledgers are separate
    // tables and are unaffected.
    try {
      const { recordOutbound } = require("../services/outboundMessage");
      await recordOutbound(personLike, {
        text: personalized,
        channel: result.channel || c.channel || "whatsapp",
        externalId: result.messageId,
        mediaUrl: chosenMedia,
        proactive: true,
        source: "campaign",
      });
    } catch (e) {
      console.error("[broadcastWorker] recordOutbound failed:", e.message);
    }
  } else {
    await sequelize.query(
      `UPDATE campaign_recipients
          SET status = 'failed',
              error_message = :err,
              rendered_body = :body,
              scheduled_at = NOW()  -- when it was tried (number-health counts recent failures)
        WHERE id = :id`,
      {
        replacements: {
          id: recipient.id,
          err: (result.error || "send failed").slice(0, 500),
          body: personalized,
        },
      }
    );
    await sequelize.query(
      `UPDATE campaigns SET failed_count = failed_count + 1 WHERE campaign_id = :id`,
      { replacements: { id: c.campaign_id } }
    );
  }

  // Pace before next send
  const delayMs = randomDelayMs(c.delay_min_seconds || 8, c.delay_max_seconds || 15);
  console.log(`⏳ [broadcastWorker] Sleeping ${(delayMs/1000).toFixed(1)}s before next send`);
  await new Promise((r) => setTimeout(r, delayMs));

  return true;
}

async function tick() {
  if (workerRunning) return;
  workerRunning = true;

  try {
    // Phase 19c — promote any scheduled campaigns whose start time has arrived
    const [promoted] = await sequelize.query(
      `UPDATE campaigns
          SET status = 'running',
              started_at = COALESCE(started_at, NOW())
        WHERE status = 'scheduled'
          AND scheduled_start_at IS NOT NULL
          AND scheduled_start_at <= NOW()`
    );
    if (promoted && (promoted.affectedRows || promoted.changedRows)) {
      const n = promoted.affectedRows || promoted.changedRows;
      console.log(`⏰ [broadcastWorker] Promoted ${n} scheduled campaign(s) to running`);
    }

    // Find all running campaigns
    // Phase 19d — fetch with current_weight for weighted selection
    const [campaigns] = await sequelize.query(
      `SELECT campaign_id, current_weight, whatsapp_account_id
         FROM campaigns
        WHERE status = 'running'
        ORDER BY started_at ASC`
    );

    // Weighted shuffle: campaigns with higher current_weight are MORE likely
    // to be processed first this tick. Cold campaigns (weight=NULL) default
    // to 0.5 so they still get tested.
    campaigns.sort((a, b) => {
      const wa = (a.current_weight == null ? 0.5 : Number(a.current_weight));
      const wb = (b.current_weight == null ? 0.5 : Number(b.current_weight));
      // Add jitter so equal-weight campaigns don't starve each other
      return (wb + Math.random() * 0.05) - (wa + Math.random() * 0.05);
    });

    if (campaigns.length > 0) {
      console.log(`🔄 [broadcastWorker] tick — ${campaigns.length} running campaign(s)`);
    }

    for (const row of campaigns) {
      // Re-fetch full row (status may have changed)
      const [fresh] = await sequelize.query(
        `SELECT * FROM campaigns WHERE campaign_id = :id LIMIT 1`,
        { replacements: { id: row.campaign_id } }
      );
      const c = fresh[0];
      if (!c || c.status !== "running") continue;

      try {
        const didWork = await processOneCampaign(c);
        if (!didWork) {
          console.log(`⏸  [broadcastWorker] campaign ${c.campaign_id} skipped this tick (window/cap/no-queue/dnc)`);
        }
      } catch (err) {
        console.error(`❌ [broadcastWorker] campaign ${c.campaign_id} error:`, err.message);
      }
    }
  } catch (err) {
    console.error("❌ [broadcastWorker] tick error:", err.message);
  } finally {
    workerRunning = false;
  }
}

function startBroadcastWorker() {
  // Locked + heartbeated (src/monitor/jobs.js).
  setInterval(require("../monitor/jobs").wrap("broadcast", tick, { ttlSec: 120 }), 5000);
  console.log("🚀 [broadcastWorker] started — polling every 5s");
}

module.exports = {
  getCampaignCapToday,
  parseRamp, startBroadcastWorker, tick };
