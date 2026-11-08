/**
 * aiUsage.routes.js — Phase 12. Token & cost analytics endpoints.
 *
 *   GET /api/ai-usage/summary?days=7      — totals + by operation breakdown
 *   GET /api/ai-usage/daily?days=30       — per-day series
 *   GET /api/ai-usage/hourly?date=YYYY-MM-DD
 *   GET /api/ai-usage/top-leads?days=7    — top consumers
 *   GET /api/ai-usage/recent?limit=50     — most recent log entries
 *   GET /api/ai-usage/pricing             — current price-per-1M
 *   PATCH /api/ai-usage/pricing/:key      — admin updates pricing
 */

const express = require("express");
const router  = express.Router();
const sequelize = require("../config/database");
const { reloadPricing, pricing } = require("../services/tokenUsage.service");
const auth = require("../middleware/auth.middleware");
const adminOnly      = require("../middleware/adminOnly");

// Admin-only: every endpoint below requires an authenticated admin.
router.use(auth, adminOnly);

// ────────────────────────────────────────────────────────────
router.get("/summary", async (req, res) => {
  try {
    const days = parseInt(req.query.days || "7", 10);

    const [totals] = await sequelize.query(
      `SELECT
         COUNT(*) AS calls,
         SUM(prompt_tokens) AS prompt_tokens,
         SUM(completion_tokens) AS completion_tokens,
         SUM(total_tokens) AS total_tokens,
         SUM(cost_usd) AS cost_usd,
         AVG(latency_ms) AS avg_latency_ms,
         SUM(success = 0) AS failed_calls
       FROM ai_token_usage
       WHERE called_at >= DATE_SUB(NOW(), INTERVAL ? DAY)`,
      { replacements: [days] }
    );

    const [byOp] = await sequelize.query(
      `SELECT operation,
              COUNT(*) AS calls,
              SUM(prompt_tokens) AS prompt_tokens,
              SUM(completion_tokens) AS completion_tokens,
              SUM(total_tokens) AS total_tokens,
              SUM(cost_usd) AS cost_usd
         FROM ai_token_usage
         WHERE called_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
         GROUP BY operation
         ORDER BY cost_usd DESC`,
      { replacements: [days] }
    );

    const [byModel] = await sequelize.query(
      `SELECT model,
              COUNT(*) AS calls,
              SUM(total_tokens) AS total_tokens,
              SUM(cost_usd) AS cost_usd
         FROM ai_token_usage
         WHERE called_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
         GROUP BY model
         ORDER BY cost_usd DESC`,
      { replacements: [days] }
    );

    res.json({
      window_days: days,
      totals: totals[0],
      by_operation: byOp,
      by_model: byModel,
      pricing,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────
router.get("/daily", async (req, res) => {
  try {
    const days = parseInt(req.query.days || "30", 10);
    const [rows] = await sequelize.query(
      `SELECT DATE(called_at) AS day,
              COUNT(*) AS calls,
              SUM(prompt_tokens) AS prompt_tokens,
              SUM(completion_tokens) AS completion_tokens,
              SUM(total_tokens) AS total_tokens,
              SUM(cost_usd) AS cost_usd
         FROM ai_token_usage
         WHERE called_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
         GROUP BY DATE(called_at)
         ORDER BY day ASC`,
      { replacements: [days] }
    );
    res.json({ rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────
router.get("/hourly", async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const [rows] = await sequelize.query(
      `SELECT HOUR(called_at) AS hour, operation,
              COUNT(*) AS calls,
              SUM(total_tokens) AS total_tokens,
              SUM(cost_usd) AS cost_usd
         FROM ai_token_usage
         WHERE DATE(called_at) = ?
         GROUP BY HOUR(called_at), operation
         ORDER BY hour ASC`,
      { replacements: [date] }
    );
    res.json({ date, rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────
router.get("/top-leads", async (req, res) => {
  try {
    const days = parseInt(req.query.days || "7", 10);
    const [rows] = await sequelize.query(
      `SELECT u.lead_id, l.name, l.phone,
              COUNT(*) AS calls,
              SUM(u.total_tokens) AS total_tokens,
              SUM(u.cost_usd) AS cost_usd
         FROM ai_token_usage u
         LEFT JOIN leads l ON l.id = u.lead_id
         WHERE u.called_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
           AND u.lead_id IS NOT NULL
         GROUP BY u.lead_id, l.name, l.phone
         ORDER BY cost_usd DESC
         LIMIT 25`,
      { replacements: [days] }
    );
    res.json({ rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────
router.get("/recent", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || "50", 10), 500);
    const [rows] = await sequelize.query(
      `SELECT id, called_at, operation, model,
              prompt_tokens, completion_tokens, total_tokens,
              cost_usd, latency_ms, success, error_message,
              reply_id, lead_id
         FROM ai_token_usage
         ORDER BY called_at DESC
         LIMIT ?`,
      { replacements: [limit] }
    );
    res.json({ rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────
router.get("/pricing", async (req, res) => {
  try {
    await reloadPricing();
    res.json(pricing);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch("/pricing/:key", async (req, res) => {
  try {
    const validKeys = new Set([
      "ai_price_input_per_1m_usd",
      "ai_price_output_per_1m_usd",
      "ai_price_embedding_per_1m_usd",
      "ai_usd_to_pkr_rate",
    ]);
    if (!validKeys.has(req.params.key)) return res.status(400).json({ error: "Unknown pricing key" });
    const value = req.body?.value;
    if (value === undefined) return res.status(400).json({ error: "value required" });

    await sequelize.query(
      `UPDATE layer_system_settings SET setting_value = ? WHERE setting_key = ?`,
      { replacements: [String(value), req.params.key] }
    );
    await reloadPricing();
    res.json({ ok: true, ...pricing });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
