/**
 * numberHealth.routes.js — how each WhatsApp number is doing (Nov 2026).
 *
 *   GET /api/admin/number-health
 *
 * WhatsApp Web (Baileys) gives no official "quality rating", so this builds
 * one from our own data for the last 24h, per number:
 *   - delivered rate   (sends ≥15 min old that reached her phone)
 *   - failed sends, opt-outs, replies
 *   - connected / paused, today's sends vs the number's daily cap
 *   - each running campaign: slow-start day, today's cap, sent, left
 * health: "good" | "watch" | "bad" with the reasons, so an admin can pause
 * a number (or halve its campaign) before WhatsApp restricts it.
 */
const express = require("express");
const sequelize = require("../config/database");
const auth = require("../middleware/auth.middleware");
const adminOnly = require("../middleware/adminOnly");
const { isAccountConnected } = require("../whatsapp/baileysClient");

const router = express.Router();
const MIN_SAMPLE = 30; // below this, rates are too noisy to judge

const pct = (a, b) => (b > 0 ? Math.round((1000 * a) / b) / 10 : null);

function judge(n) {
  const red = [];
  const amber = [];
  if (!n.connected) red.push("Not connected");
  if (n.paused_until && new Date(n.paused_until) > new Date()) amber.push("Paused");
  if (n.sent_24h >= MIN_SAMPLE) {
    if (n.failed_pct >= 10) red.push(`${n.failed_pct}% of sends failed`);
    else if (n.failed_pct >= 5) amber.push(`${n.failed_pct}% of sends failed`);
    if (n.optout_pct >= 3) red.push(`${n.optout_pct}% opted out`);
    else if (n.optout_pct >= 1.5) amber.push(`${n.optout_pct}% opted out`);
  }
  if (n.settled_24h >= MIN_SAMPLE && n.delivered_pct !== null) {
    if (n.delivered_pct < 70) red.push(`Only ${n.delivered_pct}% delivered`);
    else if (n.delivered_pct < 85) amber.push(`Only ${n.delivered_pct}% delivered`);
  }
  if (red.length) return { health: "bad", reasons: [...red, ...amber], advice: "Pause this number for 24 hours, then halve its campaign's daily limit." };
  if (amber.length) return { health: "watch", reasons: amber, advice: "Keep an eye on it; slow the campaign down if it gets worse." };
  return { health: "good", reasons: [], advice: null };
}

router.get("/number-health", auth, adminOnly, async (req, res) => {
  try {
    const { getCampaignCapToday } = require("../broadcast/broadcastWorker");
    const [accounts] = await sequelize.query(
      `SELECT * FROM whatsapp_accounts WHERE phone_number NOT LIKE 'pending-%' ORDER BY id`
    );
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(new Date());
    // Which number a campaign message went from: the campaign's own number,
    // else the number her lead belongs to (round-robin campaigns).
    const ACC = "COALESCE(c.whatsapp_account_id, l.whatsapp_account_id)";
    const [stats] = await sequelize.query(
      `SELECT ${ACC} AS acc,
              SUM(cr.sent_at IS NOT NULL) AS sent,
              SUM(cr.sent_at IS NOT NULL AND cr.sent_at < NOW() - INTERVAL 15 MINUTE) AS settled,
              SUM(cr.sent_at IS NOT NULL AND cr.sent_at < NOW() - INTERVAL 15 MINUTE
                  AND (cr.delivered_at IS NOT NULL OR cr.read_at IS NOT NULL OR cr.status IN ('delivered','read','replied'))) AS delivered,
              SUM(cr.read_at IS NOT NULL OR cr.status IN ('read','replied')) AS read_n,
              SUM(cr.replied_at IS NOT NULL OR cr.status = 'replied') AS replied,
              SUM(cr.status = 'failed') AS failed,
              SUM(cr.status = 'opted_out') AS opted_out
         FROM campaign_recipients cr
         JOIN campaigns c ON c.campaign_id = cr.campaign_id
         JOIN leads l ON l.id = cr.lead_id
        WHERE COALESCE(cr.sent_at, cr.scheduled_at) >= NOW() - INTERVAL 24 HOUR
        GROUP BY acc`
    ).catch(() => [[]]);
    const [optouts] = await sequelize.query(
      `SELECT l.whatsapp_account_id AS acc, COUNT(*) AS n
         FROM dnc_list d JOIN leads l ON l.id = d.lead_id
        WHERE d.created_at >= NOW() - INTERVAL 24 HOUR
        GROUP BY l.whatsapp_account_id`
    ).catch(() => [[]]);
    const [quota] = await sequelize.query(
      "SELECT whatsapp_account_id AS acc, sent_today FROM wa_account_daily_quota WHERE quota_date = :d",
      { replacements: { d: today } }
    ).catch(() => [[]]);
    const [running] = await sequelize.query(
      `SELECT c.*,
              (SELECT COUNT(*) FROM campaign_recipients r WHERE r.campaign_id = c.campaign_id) AS total,
              (SELECT COUNT(*) FROM campaign_recipients r WHERE r.campaign_id = c.campaign_id AND r.sent_at IS NOT NULL) AS sent_total,
              (SELECT COUNT(*) FROM campaign_recipients r WHERE r.campaign_id = c.campaign_id AND r.status = 'queued') AS left_n,
              (SELECT COUNT(*) FROM campaign_recipients r WHERE r.campaign_id = c.campaign_id AND r.status = 'replied') AS replied_total
         FROM campaigns c WHERE c.status IN ('running','paused','scheduled')`
    ).catch(() => [[]]);
    const [[dayStart]] = await sequelize.query(
      "SELECT CONVERT_TZ(CONCAT(:d, ' 00:00:00'), '+05:00', '+00:00') AS t", { replacements: { d: today } }
    ).catch(() => [[{ t: null }]]);

    const by = (rows, k = "acc") => Object.fromEntries((rows || []).map((r) => [String(r[k]), r]));
    const S = by(stats), O = by(optouts), Q = by(quota);

    const numbers = [];
    for (const a of accounts) {
      const s = S[String(a.id)] || {};
      const sent = Number(s.sent || 0);
      const settled = Number(s.settled || 0);
      const failed = Number(s.failed || 0);
      const optedOut = Math.max(Number(s.opted_out || 0), Number(O[String(a.id)]?.n || 0));
      const campaigns = [];
      for (const c of running.filter((c) => Number(c.whatsapp_account_id) === Number(a.id) || (!c.whatsapp_account_id && accounts.length === 1))) {
        let capInfo = { cap: c.daily_cap ? Number(c.daily_cap) : null, day: null, ramp: [] };
        try { capInfo = await getCampaignCapToday(c); } catch (_) { /* old DB */ }
        const [[t]] = await sequelize.query(
          "SELECT COUNT(*) AS n FROM campaign_recipients WHERE campaign_id = :id AND sent_at >= :since",
          { replacements: { id: c.campaign_id, since: dayStart?.t || new Date(Date.now() - 864e5) } }
        );
        campaigns.push({
          campaign_id: c.campaign_id, name: c.name, status: c.status,
          slow_start_day: capInfo.day, ramp: capInfo.ramp, cap_today: capInfo.cap,
          sent_today: Number(t.n || 0),
          sent_total: Number(c.sent_total || 0), total: Number(c.total || 0), left: Number(c.left_n || 0),
          replied_total: Number(c.replied_total || 0),
          window: `${c.send_window_start || "09:00"}–${c.send_window_end || "21:00"}`,
        });
      }
      const n = {
        id: a.id,
        phone: a.phone_number,
        connected: isAccountConnected(a.id),
        paused_until: a.paused_until || null,
        sent_today: Number(Q[String(a.id)]?.sent_today || 0),
        daily_cap: Number(a.shared_daily_cap || 400),
        sent_24h: sent,
        settled_24h: settled,
        delivered_pct: pct(Number(s.delivered || 0), settled),
        read_pct: pct(Number(s.read_n || 0), sent),
        replied_24h: Number(s.replied || 0),
        replied_pct: pct(Number(s.replied || 0), sent),
        failed_24h: failed,
        failed_pct: pct(failed, sent + failed) || 0,
        optouts_24h: optedOut,
        optout_pct: pct(optedOut, sent) || 0,
        campaigns,
      };
      numbers.push({ ...n, ...judge(n) });
    }
    res.json({ generated_at: new Date().toISOString(), numbers });
  } catch (err) {
    console.error("[number-health]", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
