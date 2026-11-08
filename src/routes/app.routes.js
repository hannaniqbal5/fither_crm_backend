/**
 * app.routes.js — webhook receivers for the FitHer app backend (partner_backend).
 *
 *   POST /api/webhooks/app/event             — generic event endpoint (recommended)
 *   POST /api/webhooks/app/user-signup       — typed shortcut
 *   POST /api/webhooks/app/subscription      — typed shortcut
 *   POST /api/webhooks/app/payment           — typed shortcut
 *   POST /api/webhooks/app/engagement        — class attended / diet day completed
 *
 *   GET  /api/app-events                     — admin: recent events received (debug/audit)
 *
 * All POST routes require a valid HMAC-SHA256 signature (see webhookVerifier.js).
 * They process the event BEFORE answering: 200 = done (or duplicate), 409/500 =
 * retry later. The app backend's outbox relies on this to never lose an event.
 * GET admin route requires JWT with role=admin.
 */

const express = require("express");
const auth    = require("../middleware/auth.middleware");
const sequelize = require("../config/database");
const { verifyAppWebhook } = require("../app_integration/webhookVerifier");
const { dispatchEvent } = require("../app_integration/handlers");

const router = express.Router();

const adminOnly = (req, res, next) => {
  if (req.user?.role !== "admin") return res.status(403).json({ error: "Admin only" });
  next();
};

// ── Shared: process, then answer with the real outcome ────────
// The app backend retries until it gets a 2xx, so the status code is the
// contract:
//   200  processed / duplicate / stale / skipped  → sender marks it sent
//   400  bad request (missing fields)              → sender should not retry
//   409  same event is being processed right now   → sender retries later
//   500  processing failed                         → sender retries later
async function receive(res, eventType, payload, externalEventId, mode) {
  if (!eventType || !payload) {
    return res.status(400).json({ error: "event_type and payload are required" });
  }
  // New-style (timestamped) senders must send an idempotency key so retries
  // can never double-apply a payment. Legacy senders are allowed without.
  if (mode === "v2" && !externalEventId) {
    return res.status(400).json({ error: "external_event_id is required" });
  }
  try {
    const out = await dispatchEvent(eventType, payload, externalEventId);
    if (out.status === "in_progress") {
      return res.status(409).json({ status: "in_progress", retry: true });
    }
    return res.status(200).json({
      status: out.status,
      event_id: out.eventId,
      lead_id: out.leadId ?? null,
      mapped_to: eventType,
    });
  } catch (err) {
    console.error(`❌ [/webhooks/app] ${eventType}:`, err.message);
    if (!res.headersSent) return res.status(500).json({ error: "processing_failed", retry: true });
  }
}

// ── Generic event receiver ────────────────────────────────────
// Body: { event_type, payload, external_event_id }
router.post(
  "/webhooks/app/event",
  express.raw({ type: "application/json" }),
  verifyAppWebhook,
  (req, res) => {
    const { event_type, payload, external_event_id } = req.parsedBody || {};
    return receive(res, event_type, payload, external_event_id, req.webhookMode);
  }
);

// ── Typed shortcuts ───────────────────────────────────────────
// Same effect as /event; the URL documents what's being sent.
router.post(
  "/webhooks/app/user-signup",
  express.raw({ type: "application/json" }),
  verifyAppWebhook,
  (req, res) => {
    const body = req.parsedBody || {};
    return receive(res, "user_signup", body, body.external_event_id, req.webhookMode);
  }
);

router.post(
  "/webhooks/app/subscription",
  express.raw({ type: "application/json" }),
  verifyAppWebhook,
  (req, res) => {
    const body = req.parsedBody || {};
    const eventType = body.status === "expired"   ? "subscription_expired"
                    : body.status === "frozen"    ? "subscription_frozen"
                    : body.status === "unfrozen"  ? "subscription_unfrozen"
                    : body.status === "renewed"   ? "subscription_renewed"
                    :                                "subscription_started";
    return receive(res, eventType, body, body.external_event_id, req.webhookMode);
  }
);

router.post(
  "/webhooks/app/payment",
  express.raw({ type: "application/json" }),
  verifyAppWebhook,
  (req, res) => {
    const body = req.parsedBody || {};
    const eventType = body.status === "failed" ? "payment_failed" : "payment_success";
    return receive(res, eventType, body, body.external_event_id, req.webhookMode);
  }
);

router.post(
  "/webhooks/app/engagement",
  express.raw({ type: "application/json" }),
  verifyAppWebhook,
  (req, res) => {
    const body = req.parsedBody || {};
    const eventType = body.kind === "diet_day"   ? "diet_day_completed"
                    : body.kind === "login"      ? "user_login"
                    : body.kind === "profile"    ? "profile_updated"
                    :                              "class_attended";
    return receive(res, eventType, body, body.external_event_id, req.webhookMode);
  }
);

// ── Admin: list recent events (audit / debug) ─────────────────
router.get("/app-events", auth, adminOnly, async (req, res) => {
  try {
    const { event_type, status, limit = 200 } = req.query;
    const filters = [];
    const replacements = { limit: parseInt(limit, 10) };
    if (event_type) { filters.push("event_type = :type"); replacements.type = event_type; }
    if (status)     { filters.push("status = :status");   replacements.status = status; }
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

    const [rows] = await sequelize.query(
      `SELECT event_id, app_user_id, event_type, lead_id, status, error_message,
              received_at, processed_at
         FROM app_events ${where}
        ORDER BY received_at DESC
        LIMIT :limit`,
      { replacements }
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/app-events/stats", auth, adminOnly, async (req, res) => {
  try {
    const [stats] = await sequelize.query(`
      SELECT
        COUNT(*) AS total,
        SUM(status = 'processed') AS processed,
        SUM(status = 'failed') AS failed,
        SUM(status = 'skipped') AS skipped,
        SUM(status = 'received') AS pending,
        SUM(status = 'skipped' AND error_message LIKE 'stale:%') AS stale
      FROM app_events
      WHERE received_at >= NOW() - INTERVAL 7 DAY
    `);
    const [byType] = await sequelize.query(`
      SELECT event_type, COUNT(*) AS n
        FROM app_events
       WHERE received_at >= NOW() - INTERVAL 7 DAY
       GROUP BY event_type
       ORDER BY n DESC
    `);
    const [recentFailed] = await sequelize.query(`
      SELECT event_id, external_event_id, app_user_id, event_type, error_message, received_at
        FROM app_events
       WHERE status = 'failed'
       ORDER BY received_at DESC
       LIMIT 10
    `);
    const [last] = await sequelize.query(
      `SELECT MAX(received_at) AS last_received_at FROM app_events`
    );
    res.json({
      window: "last_7_days",
      ...stats[0],
      by_type: byType,
      recent_failed: recentFailed,
      last_received_at: last[0]?.last_received_at || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
