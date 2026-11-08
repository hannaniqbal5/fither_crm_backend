/**
 * messagingAnalytics.routes.js — admin view of reactive vs proactive messaging.
 *
 * GET /api/messaging-analytics?days=14   (auth + admin)
 *
 * Reactive  = outbound messages that aren't logged as proactive (Fiza replies,
 *             rep replies, direct-from-WhatsApp). i.e. total OUT − proactive.
 * Proactive = campaign / follow-up / automation sends (proactive_send_log).
 *
 * Surfaces the combined per-number load (the ban-risk number) and a watchlist
 * of the contacts being proactively messaged most.
 */

const express = require("express");
const auth    = require("../middleware/auth.middleware");
const sequelize = require("../config/database");

const router = express.Router();

const adminOnly = (req, res, next) => {
  if (req.user?.role !== "admin") return res.status(403).json({ error: "Admin only" });
  next();
};

// Start of the current PKT day as a UTC Date (matches the send gate).
function pktDayStart() {
  const OFF = 5 * 60 * 60 * 1000;
  const nowPkt = new Date(Date.now() + OFF);
  return new Date(Date.UTC(nowPkt.getUTCFullYear(), nowPkt.getUTCMonth(), nowPkt.getUTCDate()) - OFF);
}

router.get("/", auth, adminOnly, async (req, res) => {
  try {
    let days = parseInt(req.query.days, 10);
    if (!Number.isFinite(days) || days < 1) days = 14;
    if (days > 90) days = 90;

    const dayStart = pktDayStart();

    // ── Totals over the range ──────────────────────────────────────────
    const [[msgTotals]] = await sequelize.query(
      `SELECT
         SUM(direction = 'IN')  AS inbound,
         SUM(direction = 'OUT') AS outbound
       FROM messages
       WHERE created_at >= DATE_SUB(NOW(), INTERVAL :days DAY)`,
      { replacements: { days } }
    );
    const [[proTotals]] = await sequelize.query(
      `SELECT COUNT(*) AS proactive
       FROM proactive_send_log
       WHERE created_at >= DATE_SUB(NOW(), INTERVAL :days DAY)`,
      { replacements: { days } }
    );

    const inbound   = Number(msgTotals?.inbound  || 0);
    const outbound  = Number(msgTotals?.outbound || 0);
    const proactive = Number(proTotals?.proactive || 0);
    const reactive  = Math.max(0, outbound - proactive);

    // ── Proactive by source ────────────────────────────────────────────
    const [bySource] = await sequelize.query(
      `SELECT source, COUNT(*) AS c
       FROM proactive_send_log
       WHERE created_at >= DATE_SUB(NOW(), INTERVAL :days DAY)
       GROUP BY source ORDER BY c DESC`,
      { replacements: { days } }
    );

    // ── Daily trend (inbound / proactive / reactive) ────────────────────
    const [msgDaily] = await sequelize.query(
      `SELECT DATE(created_at) AS d,
              SUM(direction = 'IN')  AS inbound,
              SUM(direction = 'OUT') AS outbound
       FROM messages
       WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL :days DAY)
       GROUP BY DATE(created_at)`,
      { replacements: { days } }
    );
    const [proDaily] = await sequelize.query(
      `SELECT DATE(created_at) AS d, COUNT(*) AS c
       FROM proactive_send_log
       WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL :days DAY)
       GROUP BY DATE(created_at)`,
      { replacements: { days } }
    );
    const dayMap = {};
    const keyOf = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
    msgDaily.forEach((r) => {
      dayMap[keyOf(r.d)] = { inbound: Number(r.inbound || 0), outbound: Number(r.outbound || 0), proactive: 0 };
    });
    proDaily.forEach((r) => {
      const k = keyOf(r.d);
      if (!dayMap[k]) dayMap[k] = { inbound: 0, outbound: 0, proactive: 0 };
      dayMap[k].proactive = Number(r.c || 0);
    });
    const daily = [];
    for (let i = days - 1; i >= 0; i--) {
      const dt = new Date(Date.now() - i * 86400000);
      const k = dt.toISOString().slice(0, 10);
      const row = dayMap[k] || { inbound: 0, outbound: 0, proactive: 0 };
      daily.push({
        date: k,
        inbound: row.inbound,
        proactive: row.proactive,
        reactive: Math.max(0, row.outbound - row.proactive),
      });
    }

    // ── Per-number combined load TODAY (the ban-risk metric) ────────────
    const [perNumberRows] = await sequelize.query(
      `SELECT a.id AS account_id, a.phone_number, a.status,
              COALESCE(t.out_today, 0) AS out_today
       FROM whatsapp_accounts a
       LEFT JOIN (
         SELECT whatsapp_account_id, COUNT(*) AS out_today
         FROM messages
         WHERE direction = 'OUT' AND created_at >= :dayStart
         GROUP BY whatsapp_account_id
       ) t ON t.whatsapp_account_id = a.id
       ORDER BY out_today DESC`,
      { replacements: { dayStart } }
    );

    // ── Watchlist: most proactively-messaged contacts (last 7d) ─────────
    const [watchlist] = await sequelize.query(
      `SELECT p.lead_id, l.name, l.phone, p.c AS proactive_7d
       FROM (
         SELECT lead_id, COUNT(*) AS c
         FROM proactive_send_log
         WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
         GROUP BY lead_id ORDER BY c DESC LIMIT 10
       ) p
       JOIN leads l ON l.id = p.lead_id
       ORDER BY p.c DESC`
    );

    // ── DNC + gate settings ─────────────────────────────────────────────
    const [[dnc]] = await sequelize.query(`SELECT COUNT(*) AS c FROM dnc_list`);
    const [settingsRows] = await sequelize.query(
      `SELECT setting_key, setting_value FROM layer_system_settings
        WHERE setting_key = 'gate_mode'
           OR setting_key = 'number_total_daily_softcap'
           OR setting_key = 'automation_sends_paused'
           OR setting_key LIKE 'proactive_%'`
    );
    const settings = {};
    settingsRows.forEach((r) => { settings[r.setting_key] = r.setting_value; });
    const softcap = Number(settings.number_total_daily_softcap || 800);

    res.json({
      range_days: days,
      totals: { inbound, outbound, proactive, reactive },
      proactive_by_source: bySource.map((r) => ({ source: r.source, count: Number(r.c || 0) })),
      daily,
      per_number: perNumberRows.map((r) => {
        const out = Number(r.out_today || 0);
        return {
          account_id: r.account_id,
          phone: r.phone_number,
          status: r.status,
          out_today: out,
          softcap,
          pct: softcap > 0 ? Math.round((out / softcap) * 100) : 0,
        };
      }),
      watchlist: watchlist.map((r) => ({
        lead_id: r.lead_id,
        name: r.name || null,
        phone: r.phone || null,
        proactive_7d: Number(r.proactive_7d || 0),
      })),
      dnc_count: Number(dnc?.c || 0),
      automation_paused: settings.automation_sends_paused === "1",
      gate: {
        mode: settings.gate_mode || "monitor",
        max_per_contact_day: Number(settings.proactive_max_per_contact_day || 1),
        max_per_contact_7d: Number(settings.proactive_max_per_contact_7d || 3),
        min_gap_hours: Number(settings.proactive_min_gap_hours || 24),
        stop_after_no_reply: Number(settings.proactive_stop_after_no_reply || 2),
        number_daily_softcap: softcap,
      },
    });
  } catch (err) {
    console.error("❌ [messaging-analytics] failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/messaging-analytics/automation-pause  { paused: true|false }
// Master kill-switch: pause/resume all AUTOMATED sends (Fiza auto-reply,
// follow-up auto-send, automation-rule sends). Campaigns and rep messages
// are NOT affected.
router.post("/automation-pause", auth, adminOnly, async (req, res) => {
  try {
    const paused = req.body?.paused ? "1" : "0";
    await sequelize.query(
      `INSERT INTO layer_system_settings (setting_key, setting_value)
       VALUES ('automation_sends_paused', :v)
       ON DUPLICATE KEY UPDATE setting_value = :v`,
      { replacements: { v: paused } }
    );
    res.json({ success: true, automation_paused: paused === "1" });
  } catch (err) {
    console.error("❌ [automation-pause] failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
