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
 * All POST routes require valid HMAC-SHA256 signature header `x-webhook-signature`.
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

// ── Generic event receiver ────────────────────────────────────
// Body: { event_type, payload, external_event_id? }
router.post(
  "/webhooks/app/event",
  express.raw({ type: "application/json" }),
  verifyAppWebhook,
  async (req, res) => {
    try {
      const { event_type, payload, external_event_id } = req.parsedBody || {};
      if (!event_type || !payload) {
        return res.status(400).json({ error: "event_type and payload are required" });
      }
      // ACK immediately, then process — Meta-pattern (avoids retries on slow handlers)
      res.status(202).json({ accepted: true });
      dispatchEvent(event_type, payload, external_event_id).catch((err) =>
        console.error(`❌ [/webhooks/app/event] ${event_type}:`, err.message)
      );
    } catch (err) {
      console.error("❌ [/webhooks/app/event]:", err);
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  }
);

// ── Typed shortcuts ───────────────────────────────────────────
// These are convenient for the app dev — same effect as /event
// but the URL itself documents what's being sent.

router.post(
  "/webhooks/app/user-signup",
  express.raw({ type: "application/json" }),
  verifyAppWebhook,
  async (req, res) => {
    res.status(202).json({ accepted: true });
    dispatchEvent("user_signup", req.parsedBody, req.parsedBody?.external_event_id)
      .catch((err) => console.error(`❌ user-signup:`, err.message));
  }
);

router.post(
  "/webhooks/app/subscription",
  express.raw({ type: "application/json" }),
  verifyAppWebhook,
  async (req, res) => {
    const body = req.parsedBody || {};
    const eventType = body.status === "expired"   ? "subscription_expired"
                    : body.status === "frozen"    ? "subscription_frozen"
                    : body.status === "unfrozen"  ? "subscription_unfrozen"
                    : body.status === "renewed"   ? "subscription_renewed"
                    :                                "subscription_started";
    res.status(202).json({ accepted: true, mapped_to: eventType });
    dispatchEvent(eventType, body, body.external_event_id)
      .catch((err) => console.error(`❌ subscription:`, err.message));
  }
);

router.post(
  "/webhooks/app/payment",
  express.raw({ type: "application/json" }),
  verifyAppWebhook,
  async (req, res) => {
    const body = req.parsedBody || {};
    const eventType = body.status === "failed" ? "payment_failed" : "payment_success";
    res.status(202).json({ accepted: true, mapped_to: eventType });
    dispatchEvent(eventType, body, body.external_event_id)
      .catch((err) => console.error(`❌ payment:`, err.message));
  }
);

router.post(
  "/webhooks/app/engagement",
  express.raw({ type: "application/json" }),
  verifyAppWebhook,
  async (req, res) => {
    const body = req.parsedBody || {};
    const eventType = body.kind === "diet_day"   ? "diet_day_completed"
                    : body.kind === "login"      ? "user_login"
                    : body.kind === "profile"    ? "profile_updated"
                    :                              "class_attended";
    res.status(202).json({ accepted: true, mapped_to: eventType });
    dispatchEvent(eventType, body, body.external_event_id)
      .catch((err) => console.error(`❌ engagement:`, err.message));
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
        SUM(status = 'received') AS pending
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
    res.json({ window: "last_7_days", ...stats[0], by_type: byType });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
