/**
 * aiLearning.routes.js — Phase 11.
 *
 * Endpoints for the Fiza Learning Loop:
 *   GET    /api/ai-learning/inbox                  — recent edits/rejects awaiting admin review
 *   POST   /api/ai-learning/edits/:id/promote      — admin promotes this as a few-shot example
 *   POST   /api/ai-learning/edits/:id/dismiss      — admin dismisses (not useful)
 *   POST   /api/ai-learning/edits/:id/notes        — admin annotates (free-text)
 *   GET    /api/ai-learning/examples               — list of currently-promoted examples
 *   GET    /api/ai-learning/report/weekly          — Monday digest: top edited categories, KB gaps
 *   GET    /api/ai-learning/stats                  — high-level metrics
 */

const express = require("express");
const router  = express.Router();
const sequelize = require("../config/database");
const auth = require("../middleware/auth.middleware");
const adminOnly      = require("../middleware/adminOnly");

const { invalidateCache } = require("../ai/aiFeedback.service");

// Admin-only: every endpoint below requires an authenticated admin.
router.use(auth, adminOnly);

// ───────────────────────────────────────────────────────────────
// Inbox — recent edits/rejects not yet promoted or dismissed
// ───────────────────────────────────────────────────────────────
router.get("/inbox", async (req, res) => {
  try {
    const limit  = parseInt(req.query.limit || "50", 10);
    const action = req.query.action; // 'edited' | 'rejected' | 'all'

    const where = ["dismissed = 0", "promoted = 0"];
    const repls = [];
    if (action && action !== "all") { where.push("edit_action = ?"); repls.push(action); }
    repls.push(limit);

    const [rows] = await sequelize.query(
      `SELECT c.correction_id, c.reply_id, c.rep_id, c.user_message,
              c.original_reply, c.corrected_reply,
              c.interaction_status, c.main_goal, c.last_objection,
              c.edit_distance, c.edit_action, c.created_at, c.notes,
              sr.name AS rep_name,
              l.id AS lead_id, l.name AS lead_name, l.phone AS lead_phone
         FROM ai_corrections c
         LEFT JOIN sales_reps sr ON sr.id = c.rep_id
         LEFT JOIN ai_replies r  ON r.reply_id = c.reply_id
         LEFT JOIN leads l       ON l.id = r.lead_id
         WHERE ${where.join(" AND ")}
         ORDER BY c.created_at DESC
         LIMIT ?`,
      { replacements: repls }
    );
    res.json({ rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ───────────────────────────────────────────────────────────────
// Promote — admin marks this edit as a "good" few-shot example
// ───────────────────────────────────────────────────────────────
router.post("/edits/:id/promote", async (req, res) => {
  try {
    await sequelize.query(
      `UPDATE ai_corrections
         SET promoted = 1, promoted_at = NOW(), promoted_by = ?
         WHERE correction_id = ?`,
      { replacements: [req.user?.repId || null, req.params.id] }
    );
    invalidateCache();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ───────────────────────────────────────────────────────────────
// Dismiss — admin reviewed but doesn't want as an example
// ───────────────────────────────────────────────────────────────
router.post("/edits/:id/dismiss", async (req, res) => {
  try {
    await sequelize.query(
      `UPDATE ai_corrections
         SET dismissed = 1, dismissed_at = NOW()
         WHERE correction_id = ?`,
      { replacements: [req.params.id] }
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/edits/:id/notes", async (req, res) => {
  try {
    const notes = String(req.body?.notes || "").slice(0, 500);
    await sequelize.query(
      `UPDATE ai_corrections SET notes = ? WHERE correction_id = ?`,
      { replacements: [notes, req.params.id] }
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ───────────────────────────────────────────────────────────────
// Examples — all currently-promoted edits
// ───────────────────────────────────────────────────────────────
router.get("/examples", async (req, res) => {
  try {
    const [rows] = await sequelize.query(
      `SELECT correction_id, interaction_status, main_goal, last_objection,
              user_message, corrected_reply, promoted_at, notes
         FROM ai_corrections
         WHERE promoted = 1 AND dismissed = 0
         ORDER BY promoted_at DESC`
    );
    res.json({ rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/examples/:id/unpromote", async (req, res) => {
  try {
    await sequelize.query(
      `UPDATE ai_corrections
         SET promoted = 0, promoted_at = NULL
         WHERE correction_id = ?`,
      { replacements: [req.params.id] }
    );
    invalidateCache();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ───────────────────────────────────────────────────────────────
// Weekly report — Monday digest
// ───────────────────────────────────────────────────────────────
router.get("/report/weekly", async (req, res) => {
  try {
    // Top edited categories (interaction_status + main_goal) in last 7 days
    const [topEdited] = await sequelize.query(
      `SELECT interaction_status, main_goal,
              COUNT(*) AS total,
              SUM(edit_action = 'edited')   AS edits,
              SUM(edit_action = 'rejected') AS rejects,
              AVG(edit_distance)            AS avg_distance
         FROM ai_corrections
         WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
         GROUP BY interaction_status, main_goal
         ORDER BY total DESC
         LIMIT 10`
    );

    // Heaviest rewrites (top 5 by distance) — likely "Fiza was very wrong here"
    const [heaviestRewrites] = await sequelize.query(
      `SELECT correction_id, interaction_status, main_goal,
              user_message, original_reply, corrected_reply, edit_distance, created_at
         FROM ai_corrections
         WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
           AND edit_action = 'edited'
         ORDER BY edit_distance DESC
         LIMIT 5`
    );

    // Most-rejected categories — possible KB gaps
    const [rejects] = await sequelize.query(
      `SELECT interaction_status, main_goal, COUNT(*) AS rejects
         FROM ai_corrections
         WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
           AND edit_action = 'rejected'
         GROUP BY interaction_status, main_goal
         ORDER BY rejects DESC
         LIMIT 5`
    );

    // Aggregate
    const [agg] = await sequelize.query(
      `SELECT
         COUNT(*) AS total_decisions,
         SUM(edit_action = 'edited')   AS edits,
         SUM(edit_action = 'rejected') AS rejects,
         AVG(edit_distance) AS avg_edit_distance,
         (SELECT COUNT(*) FROM ai_replies
           WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
             AND status IN ('sent','edited')) AS drafts_sent
       FROM ai_corrections
       WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)`
    );

    res.json({
      window: "last_7_days",
      summary: agg[0],
      top_edited_categories: topEdited,
      heaviest_rewrites: heaviestRewrites,
      most_rejected: rejects,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ───────────────────────────────────────────────────────────────
// Stats — header tile counts
// ───────────────────────────────────────────────────────────────
router.get("/stats", async (req, res) => {
  try {
    const [stats] = await sequelize.query(
      `SELECT
         COUNT(*) AS total_corrections,
         SUM(promoted = 1)  AS promoted,
         SUM(dismissed = 1) AS dismissed,
         SUM(promoted = 0 AND dismissed = 0) AS pending
       FROM ai_corrections`
    );
    res.json(stats[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
