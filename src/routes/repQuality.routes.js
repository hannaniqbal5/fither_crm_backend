/**
 * repQuality.routes.js — Phase 9 (F).
 *
 * Endpoints:
 *   GET  /api/rep-quality/analytics?from&to&channel&rep — rep analytics for a range (JSON or CSV)
 *   GET  /api/rep-quality/flags                       — unacknowledged flags
 *   POST /api/rep-quality/flags/:id/ack
 *   GET  /api/rep-quality/live-sessions               — reps online now
 *
 * The nightly snapshot and quality-rule jobs still run on their own
 * (src/jobs/repDailySnapshot.job.js, repQualityRules.job.js).
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
