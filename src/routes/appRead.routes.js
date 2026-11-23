/**
 * appRead.routes.js — read-only API for the app backend to query CRM data.
 *
 * These endpoints let the Flutter app show CRM-owned info:
 *   GET /api/app/lead-info/:appUserId  — coach, stage, DNC, assigned rep
 *   GET /api/app/lead-info-bulk        — same for multiple users (batch)
 *
 * Auth: HMAC-signed requests from the app backend (same key as webhooks),
 * timestamped and bound to method + URL. See verifyAppRead in
 * webhookVerifier.js. No JWT — the app backend calls these server-to-server.
 */

const express = require("express");
const router = express.Router();
const sequelize = require("../config/database");
const { verifyAppRead } = require("../app_integration/webhookVerifier");
const { computeLifecycle } = require("../utils/lifecycle");

// Every route here returns customer data: all of them must be signed.
router.use(verifyAppRead);

/**
 * GET /api/app/lead-info/:appUserId
 * Returns the CRM-side info the app needs for this user.
 */
router.get("/lead-info/:appUserId", async (req, res) => {
  try {
    const appUserId = req.params.appUserId;
    if (!appUserId) return res.status(400).json({ error: "appUserId is required" });

    const [rows] = await sequelize.query(
      `SELECT l.id, l.name, l.phone, l.email, l.stage, l.status,
              l.subscription_status, l.interaction_status,
              l.assigned_to, l.main_goal, l.main_goal_app,
              l.app_onboarded_at, l.app_signed_up_at,
              r.name AS rep_name, w.phone_number AS rep_phone
         FROM leads l
         LEFT JOIN sales_reps r ON r.id = l.assigned_to AND r.status = 'active'
         LEFT JOIN whatsapp_accounts w ON w.id = r.whatsapp_account_id
        WHERE l.app_user_id = :appUserId
          AND l.merged_into_lead_id IS NULL
        LIMIT 1`,
      { replacements: { appUserId } }
    );

    if (!rows[0]) {
      return res.json({ found: false });
    }

    const lead = rows[0];
    const lifecycle = computeLifecycle(lead);
    const isDnc = lead.interaction_status === "opted_out";

    res.json({
      found: true,
      crm_lead_id: lead.id,
      lifecycle,
      stage: lead.stage,
      is_dnc: isDnc,
      coach: lead.rep_name ? {
        name: lead.rep_name,
        whatsapp: lead.rep_phone || null,
      } : null,
      main_goal: lead.main_goal || lead.main_goal_app || null,
      subscription_status: lead.subscription_status || "none",
      onboarded: !!lead.app_onboarded_at,
    });
  } catch (err) {
    console.error("[appRead] lead-info error:", err.message);
    res.status(500).json({ error: "server_error" });
  }
});

/**
 * POST /api/app/lead-info-bulk
 * Body: { app_user_ids: ["uid1", "uid2", ...] }  (max 100)
 * Returns an object keyed by app_user_id.
 */
router.post("/lead-info-bulk", async (req, res) => {
  try {
    const ids = req.body?.app_user_ids;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: "app_user_ids array is required" });
    }
    if (ids.length > 100) {
      return res.status(400).json({ error: "max 100 ids per request" });
    }

    const [rows] = await sequelize.query(
      `SELECT l.app_user_id, l.id, l.stage, l.status,
              l.subscription_status, l.interaction_status,
              l.assigned_to,
              r.name AS rep_name, w.phone_number AS rep_phone
         FROM leads l
         LEFT JOIN sales_reps r ON r.id = l.assigned_to AND r.status = 'active'
         LEFT JOIN whatsapp_accounts w ON w.id = r.whatsapp_account_id
        WHERE l.app_user_id IN (:ids)
          AND l.merged_into_lead_id IS NULL`,
      { replacements: { ids } }
    );

    const result = {};
    for (const lead of rows) {
      result[lead.app_user_id] = {
        crm_lead_id: lead.id,
        lifecycle: computeLifecycle(lead),
        is_dnc: lead.interaction_status === "opted_out",
        coach: lead.rep_name ? { name: lead.rep_name, whatsapp: lead.rep_phone || null } : null,
        subscription_status: lead.subscription_status || "none",
      };
    }

    res.json({ results: result });
  } catch (err) {
    console.error("[appRead] bulk error:", err.message);
    res.status(500).json({ error: "server_error" });
  }
});

module.exports = router;
