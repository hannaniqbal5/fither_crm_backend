/**
 * health.routes.js
 *   GET /health            public, minimal — for uptime monitors / load balancers
 *   GET /api/admin/health  admin — everything that can silently break:
 *                          database, each WhatsApp number, every scheduled job,
 *                          recent errors, stuck app events, the app backend's
 *                          event outbox, and the send-gate decisions.
 */
const express = require("express");
const auth = require("../middleware/auth.middleware");
const sequelize = require("../config/database");

const router = express.Router();
const adminOnly = (req, res, next) =>
  req.user?.role === "admin" ? next() : res.status(403).json({ error: "Admin only" });

router.get("/health", async (req, res) => {
  let db = false;
  try { await sequelize.query("SELECT 1"); db = true; } catch (_) {}
  res.status(db ? 200 : 503).json({
    status: db ? "ok" : "degraded",
    db,
    role: process.env.CRM_PROCESS || "all",
    uptime_s: Math.round(process.uptime()),
  });
});

const minutesAgo = (d) => (d ? Math.round((Date.now() - new Date(d).getTime()) / 60000) : null);

router.get("/api/admin/health", auth, adminOnly, async (req, res) => {
  const out = { checked_at: new Date().toISOString(), problems: [], warnings: [] };

  // Database
  const t0 = Date.now();
  try { await sequelize.query("SELECT 1"); out.db = { ok: true, ms: Date.now() - t0 }; }
  catch (e) { out.db = { ok: false, error: e.message }; out.problems.push("Database unreachable"); }

  // WhatsApp numbers (written every minute by the web process)
  try {
    const [[row]] = await sequelize.query("SELECT status, last_ping_at, config FROM integrations WHERE name = 'baileys_wa' LIMIT 1");
    const cfg = row && (typeof row.config === "string" ? JSON.parse(row.config || "{}") : row.config || {});
    out.whatsapp = { status: row ? row.status : "unknown", checked_min_ago: minutesAgo(row && row.last_ping_at), accounts: (cfg && cfg.accounts) || [] };
    for (const a of out.whatsapp.accounts) if (!a.connected) out.problems.push(`WhatsApp number ${a.phone_number || a.id} is disconnected`);
    if (out.whatsapp.checked_min_ago == null || out.whatsapp.checked_min_ago > 5) out.problems.push("WhatsApp status not updated in 5+ minutes (web process down?)");
  } catch (e) { out.whatsapp = { error: e.message }; }

  // Scheduled jobs
  try {
    const rows = await require("../monitor/jobs").status(sequelize);
    out.jobs = rows.map((r) => {
      const failedRecently = r.last_error_at && (!r.last_ok || new Date(r.last_error_at) > new Date(r.last_ok));
      const silent = minutesAgo(r.updated_at) > 15;
      if (failedRecently) out.warnings.push(`Job ${r.name} failed: ${r.last_error}`);
      if (silent) out.warnings.push(`Job ${r.name} (${r.role}@${r.host}) has not reported for ${minutesAgo(r.updated_at)} min`);
      return { ...r, last_ok_min_ago: minutesAgo(r.last_ok), failed_recently: !!failedRecently, silent };
    });
  } catch (e) { out.jobs = { error: e.message }; }

  // Recent errors
  try { out.errors_24h = await require("../monitor/errors").recent(sequelize, 24, 15); }
  catch (e) { out.errors_24h = { error: e.message }; }

  // App events that failed or are stuck
  try {
    const [[ev]] = await sequelize.query(
      `SELECT SUM(status = 'failed') AS failed,
              SUM(status = 'received' AND received_at < DATE_SUB(NOW(), INTERVAL 10 MINUTE)) AS stuck
         FROM app_events WHERE received_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)`
    );
    out.app_events_24h = { failed: Number(ev.failed || 0), stuck: Number(ev.stuck || 0) };
    if (out.app_events_24h.failed || out.app_events_24h.stuck) out.warnings.push(`${out.app_events_24h.failed} app event(s) failed, ${out.app_events_24h.stuck} stuck in the last 24 h`);
  } catch (e) { out.app_events_24h = { error: e.message }; }

  // The app backend's outbox (events on their way to us)
  try {
    const { partnerCall } = require("../services/partnerSigned");
    const data = await partnerCall("GET", "/internal/crm/outbox?limit=20");
    const by = data.counts || {};
    out.app_outbox = { enabled: data.enabled, by_status: by };
    if (by.dead) out.warnings.push(`${by.dead} event(s) dead in the app backend's outbox`);
  } catch (e) { out.app_outbox = { error: e.message }; out.warnings.push("Could not reach the app backend's outbox"); }

  // Send gate (what the limits blocked / would have blocked)
  try { out.send_gate_7d = await require("../services/sendGate").report(7); }
  catch (e) { out.send_gate_7d = { error: e.message }; }

  out.status = out.problems.length ? "problem" : out.warnings.length ? "warning" : "ok";
  res.json(out);
});

// Send gate review + switch (admin).
//   GET  /api/admin/send-gate/report?days=7
//   POST /api/admin/send-gate/mode   { "mode": "monitor" | "enforce" }
router.get("/api/admin/send-gate/report", auth, adminOnly, async (req, res) => {
  try { res.json(await require("../services/sendGate").report(req.query.days)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post("/api/admin/send-gate/mode", auth, adminOnly, async (req, res) => {
  try {
    const out = await require("../services/sendGate").setMode(req.body && req.body.mode);
    console.log(`[sendGate] mode set to ${out.gate_mode} by rep ${req.user.repId}`);
    res.json(out);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Nightly plan sync (src/jobs/planSync.job.js).
//   GET  /api/admin/plan-sync       last result
//   POST /api/admin/plan-sync/run   run it now (takes the same lock as the job)
router.get("/api/admin/plan-sync", auth, adminOnly, async (req, res) => {
  try { res.json(await require("../jobs/planSync.job").lastRun()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post("/api/admin/plan-sync/run", auth, adminOnly, async (req, res) => {
  const { runPlanSync } = require("../jobs/planSync.job");
  const report = await require("../monitor/jobs").wrap("plan-sync", runPlanSync, { ttlSec: 3600 })();
  if (!report) return res.status(409).json({ error: "A plan sync is already running, or it failed — see /api/admin/health" });
  res.json(report);
});

module.exports = router;
