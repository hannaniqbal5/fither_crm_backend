/**
 * meta.routes.js — Express routes for Meta Graph API webhooks + admin endpoints.
 *
 * Public:
 *   GET  /api/webhooks/meta   — Meta verification challenge handler
 *   POST /api/webhooks/meta   — Inbound events (DMs, comments, mentions)
 *
 * Admin (auth + role=admin):
 *   GET  /api/meta/pages      — List configured Meta pages + their status
 *   POST /api/meta/pages      — Register a new Page + IG account + token
 *   PATCH /api/meta/pages/:id — Update token / status
 *   GET  /api/meta/comments   — Recent comments (optionally filter by status)
 */

const express = require("express");
const auth    = require("../middleware/auth.middleware");
const sequelize = require("../config/database");
const { verifySignature, handleWebhook } = require("../meta/webhook.handler");
const { getPageInfo } = require("../meta/graphClient");

const router = express.Router();

const adminOnly = (req, res, next) => {
  if (req.user?.role !== "admin") return res.status(403).json({ error: "Admin only" });
  next();
};

/* ==========================================================
   WEBHOOK — verification (GET) + events (POST)
   These routes are PUBLIC (no auth) — Meta calls them.
   ========================================================== */

// Meta sends a GET request with `hub.verify_token` to confirm we own the URL.
// We respond with the `hub.challenge` value if the token matches.
router.get("/webhooks/meta", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  const expected = process.env.META_VERIFY_TOKEN;

  if (mode === "subscribe" && token && expected && token === expected) {
    console.log("✅ [Meta] Webhook verified");
    return res.status(200).send(challenge);
  }

  console.warn("❌ [Meta] Webhook verification failed");
  return res.sendStatus(403);
});

/*
  POST handler — Meta sends events.
  IMPORTANT: this route requires the RAW body (Buffer) for HMAC signature verification.
  In App.js, mount express.raw({ type: 'application/json' }) BEFORE the JSON parser
  for this specific route, OR use the rawBody capture helper below.
*/
router.post("/webhooks/meta", express.raw({ type: "application/json" }), async (req, res) => {
  // 1. Always 200 first (Meta retries if we don't 200 quickly) — defer work
  // But we MUST verify signature first for security
  const signature = req.headers["x-hub-signature-256"];
  const rawBody = req.body; // Buffer because of express.raw()

  if (!verifySignature(rawBody, signature)) {
    console.warn("❌ [Meta] Webhook signature invalid");
    return res.sendStatus(403);
  }

  // Parse body now that signature is verified
  let payload;
  try {
    payload = JSON.parse(rawBody.toString("utf-8"));
  } catch (err) {
    console.error("❌ [Meta] Webhook JSON parse failed:", err.message);
    return res.sendStatus(400);
  }

  // ACK immediately — Meta has a 20-second timeout
  res.sendStatus(200);

  // Process asynchronously
  const io = req.app.get("io");
  handleWebhook(payload, io).catch((err) => {
    console.error("❌ [Meta] handleWebhook failed:", err.message, err.stack);
  });
});

/* ==========================================================
   ADMIN — Page management
   ========================================================== */

// GET /api/meta/pages — list registered Meta pages
router.get("/meta/pages", auth, adminOnly, async (req, res) => {
  try {
    const [rows] = await sequelize.query(
      `SELECT id, page_id, page_name, instagram_account_id, status,
              last_webhook_at, token_expires_at, created_at
         FROM meta_pages
        ORDER BY created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/meta/pages — register a new Meta page
// Body: { page_id, page_name?, instagram_account_id?, page_access_token }
router.post("/meta/pages", auth, adminOnly, async (req, res) => {
  try {
    const { page_id, page_name, instagram_account_id, page_access_token } = req.body || {};
    if (!page_id || !page_access_token) {
      return res.status(400).json({ error: "page_id and page_access_token are required" });
    }

    // Verify the token works by calling Graph API
    let pageInfo;
    try {
      pageInfo = await getPageInfo(page_access_token, page_id);
    } catch (err) {
      return res.status(400).json({ error: "Token verification failed", detail: err.message });
    }

    const finalIgId =
      instagram_account_id ||
      pageInfo?.instagram_business_account?.id ||
      null;

    await sequelize.query(
      `INSERT INTO meta_pages
         (page_id, page_name, instagram_account_id, page_access_token, status)
       VALUES (:page_id, :page_name, :ig_id, :token, 'active')
       ON DUPLICATE KEY UPDATE
         page_name = VALUES(page_name),
         instagram_account_id = VALUES(instagram_account_id),
         page_access_token = VALUES(page_access_token),
         status = 'active',
         updated_at = NOW()`,
      {
        replacements: {
          page_id,
          page_name: page_name || pageInfo?.name || null,
          ig_id: finalIgId,
          token: page_access_token,
        },
      }
    );

    const [row] = await sequelize.query(
      `SELECT id, page_id, page_name, instagram_account_id, status FROM meta_pages WHERE page_id = :p`,
      { replacements: { p: page_id } }
    );
    res.json({ success: true, page: row[0] });
  } catch (err) {
    console.error("❌ [Meta] register page error:", err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/meta/pages/:id — update status / token
router.patch("/meta/pages/:id", auth, adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, page_access_token } = req.body || {};
    const fields = [];
    const replacements = { id };
    if (status) { fields.push("status = :status"); replacements.status = status; }
    if (page_access_token) { fields.push("page_access_token = :token"); replacements.token = page_access_token; }
    if (fields.length === 0) return res.status(400).json({ error: "Nothing to update" });

    await sequelize.query(
      `UPDATE meta_pages SET ${fields.join(", ")}, updated_at = NOW() WHERE id = :id`,
      { replacements }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/meta/comments — recent comments
router.get("/meta/comments", auth, adminOnly, async (req, res) => {
  try {
    const { status, channel, limit = 100 } = req.query;
    const filters = [];
    const replacements = { limit: parseInt(limit, 10) };
    if (status)  { filters.push("status = :status"); replacements.status = status; }
    if (channel) { filters.push("channel = :channel"); replacements.channel = channel; }

    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const [rows] = await sequelize.query(
      `SELECT comment_id, channel, post_id, external_username, message, status, ai_handled, created_at
         FROM comments ${where}
        ORDER BY created_at DESC
        LIMIT :limit`,
      { replacements }
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
