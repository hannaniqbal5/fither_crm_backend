/**
 * repQuality.routes.js — Phase 9 (F).
 *
 * Endpoints:
 *   GET  /api/rep-quality/analytics?from&to&channel&rep — rep analytics for a range (JSON or CSV)
 *   GET  /api/rep-quality/scorecard?date=YYYY-MM-DD   — all reps for one day
 *   GET  /api/rep-quality/scorecard/:repId            — single rep, last 14 days
 *   GET  /api/rep-quality/scorecard/:repId/hourly?date=YYYY-MM-DD
 *   GET  /api/rep-quality/leaderboard                 — top reps by sales / response / presence
 *   GET  /api/rep-quality/flags                       — unacknowledged flags
 *   POST /api/rep-quality/flags/:id/ack
 *   POST /api/rep-quality/snapshot-now                — admin: run snapshot immediately
 *   POST /api/rep-quality/run-rules-now               — admin: evaluate rules now
 */

const express = require("express");
const router  = express.Router();
const sequelize = require("../config/database");
const auth = require("../middleware/auth.middleware");
const adminOnly      = require("../middleware/adminOnly");
const repAnalytics   = require("../services/repAnalytics");

// Admin-only: every endpoint below requires an authenticated admin.
router.use(auth, adminOnly);

// ─────────────────────────────────────────────────────────
// GET /api/rep-quality/analytics?from=YYYY-MM-DD&to=YYYY-MM-DD&channel=all&rep=ID[&format=csv]
// Response time, conversations, conversion, Fiza share per rep, read live.
router.get("/analytics", async (req, res) => {
  try {
    const data = await repAnalytics.analytics(sequelize, {
      from: req.query.from, to: req.query.to, channel: req.query.channel, repId: req.query.rep,
    });
    if (req.query.format !== "csv") return res.json(data);
    const cols = [
      ["Rep", (r) => r.name], ["Conversations", (r) => r.conversations], ["Customer messages (turns)", (r) => r.customer_turns],
      ["Median reply (min)", (r) => r.response.median_min], ["90% replied within (min)", (r) => r.response.p90_min],
      ["Within SLA %", (r) => r.response.within_sla_pct], ["First reply to new lead (min)", (r) => r.first_reply_median_min],
      ["Replied by rep %", (r) => r.replied_by_rep_pct], ["Answered by Fiza %", (r) => r.answered_by_fiza_pct],
      ["Unanswered", (r) => r.unanswered], ["New leads", (r) => r.new_leads], ["Lead to sale %", (r) => r.lead_to_sale_pct],
      ["Sales", (r) => r.sales], ["Revenue PKR", (r) => r.revenue], ["Conversion %", (r) => r.conversion_pct],
      ["Avg sale PKR", (r) => r.avg_sale], ["Messages sent", (r) => r.messages_sent], ["Msgs per conversation", (r) => r.msgs_per_conversation],
      ["Active hours", (r) => r.active_hours], ["Sales per active hour", (r) => r.sales_per_active_hour], ["Fiza mode", (r) => r.fiza_mode],
    ];
    const esc = (v) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const csv = [cols.map((c) => c[0]).join(","), ...data.reps.map((r) => cols.map((c) => esc(c[1](r))).join(","))].join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="rep-analytics_${data.from}_${data.to}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error("[rep-analytics]", err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────
router.get("/scorecard", async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const [rows] = await sequelize.query(
      `SELECT s.*, sr.name AS rep_name, sr.email AS rep_email
         FROM rep_daily_stats s
         LEFT JOIN sales_reps sr ON sr.id = s.rep_id
         WHERE s.stat_date = ?
         ORDER BY s.conversions_count DESC, s.avg_response_time_min ASC`,
      { replacements: [date] }
    );
    res.json({ date, rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────
router.get("/scorecard/:repId", async (req, res) => {
  try {
    const repId = parseInt(req.params.repId, 10);
    const days = parseInt(req.query.days || "14", 10);
    const [rows] = await sequelize.query(
      `SELECT * FROM rep_daily_stats
         WHERE rep_id = ?
           AND stat_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
         ORDER BY stat_date DESC`,
      { replacements: [repId, days] }
    );
    const [repRows] = await sequelize.query(
      `SELECT id, name, email FROM sales_reps WHERE id = ?`,
      { replacements: [repId] }
    );

    // 14-day aggregate
    const agg = rows.reduce((acc, r) => {
      acc.active_minutes += Number(r.active_minutes || 0);
      acc.messages_received += Number(r.messages_received || 0);
      acc.messages_sent += Number(r.messages_sent || 0);
      acc.conversations_handled += Number(r.conversations_handled || 0);
      acc.conversions_count += Number(r.conversions_count || 0);
      acc.revenue_attributed += Number(r.revenue_attributed || 0);
      acc.days += 1;
      acc.rtSum += Number(r.avg_response_time_min || 0);
      acc.presenceSum += Number(r.presence_pct || 0);
      return acc;
    }, { active_minutes:0, messages_received:0, messages_sent:0, conversations_handled:0,
         conversions_count:0, revenue_attributed:0, days:0, rtSum:0, presenceSum:0 });
    const avg = {
      avg_response_time_min: agg.days ? Number((agg.rtSum / agg.days).toFixed(2)) : 0,
      presence_pct: agg.days ? Number((agg.presenceSum / agg.days).toFixed(2)) : 0,
    };
    res.json({ rep: repRows[0] || null, rows, totals: agg, averages: avg });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────
router.get("/scorecard/:repId/hourly", async (req, res) => {
  try {
    const repId = parseInt(req.params.repId, 10);
    const date  = req.query.date || new Date().toISOString().slice(0,10);
    const [msgs] = await sequelize.query(
      `SELECT HOUR(m.created_at) AS hr, m.direction, COUNT(*) AS c
         FROM messages m
         JOIN leads l ON l.id = m.lead_id
         WHERE l.assigned_to = ? AND DATE(m.created_at) = ?
         GROUP BY HOUR(m.created_at), m.direction
         ORDER BY hr`,
      { replacements: [repId, date] }
    );
    res.json({ rep_id: repId, date, rows: msgs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────
router.get("/leaderboard", async (req, res) => {
  try {
    const days = parseInt(req.query.days || "7", 10);
    const [rows] = await sequelize.query(
      `SELECT s.rep_id, sr.name AS rep_name,
              SUM(s.conversions_count) AS sales_total,
              SUM(s.revenue_attributed) AS revenue_total,
              AVG(s.avg_response_time_min) AS avg_rt,
              AVG(s.presence_pct) AS avg_presence,
              SUM(s.messages_sent) AS msgs_sent,
              SUM(s.conversations_handled) AS conversations
         FROM rep_daily_stats s
         LEFT JOIN sales_reps sr ON sr.id = s.rep_id
         WHERE s.stat_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
         GROUP BY s.rep_id, sr.name
         ORDER BY sales_total DESC, avg_rt ASC`,
      { replacements: [days] }
    );
    res.json({ days, rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────
router.get("/flags", async (req, res) => {
  try {
    const days = parseInt(req.query.days || "7", 10);
    const [rows] = await sequelize.query(
      `SELECT f.*, sr.name AS rep_name
         FROM rep_quality_flags f
         LEFT JOIN sales_reps sr ON sr.id = f.rep_id
         WHERE f.flag_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
         ORDER BY f.acknowledged ASC, f.severity DESC, f.created_at DESC
         LIMIT 200`,
      { replacements: [days] }
    );
    res.json({ rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────
router.post("/flags/:id/ack", async (req, res) => {
  try {
    await sequelize.query(
      `UPDATE rep_quality_flags
         SET acknowledged = 1, acknowledged_by = ?, acknowledged_at = NOW()
         WHERE id = ?`,
      { replacements: [req.user?.repId || null, req.params.id] }
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────
router.post("/snapshot-now", async (req, res) => {
  try {
    const { runForYesterday } = require("../jobs/repDailySnapshot.job");
    const rows = await runForYesterday();
    res.json({ ok: true, rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/run-rules-now", async (req, res) => {
  try {
    const { runOnce } = require("../jobs/repQualityRules.job");
    await runOnce();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────
// GET /api/rep-quality/live-sessions — currently active sessions snapshot
router.get("/live-sessions", async (req, res) => {
  try {
    const [rows] = await sequelize.query(
      `SELECT rs.*, sr.name AS rep_name
         FROM rep_sessions rs
         LEFT JOIN sales_reps sr ON sr.id = rs.rep_id
         WHERE rs.ended_at IS NULL
         ORDER BY rs.started_at DESC`
    );
    res.json({ rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
