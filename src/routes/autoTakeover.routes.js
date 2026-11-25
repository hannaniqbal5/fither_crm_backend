/**
 * autoTakeover.routes.js — CRUD for Fiza auto-takeover rules + logs.
 */

const router = require("express").Router();
const sequelize = require("../config/database");
const { tick } = require("../services/autoTakeover.service");

const TRIGGER_TYPES = ["rep_slow", "no_reply", "outside_hours", "lead_urgent"];
const ACTIONS = ["reply", "reply_and_notify_rep", "notify_rep_only"];

// List rules
router.get("/auto-takeover", async (req, res) => {
  try {
    const [rules] = await sequelize.query(`
      SELECT r.*,
        (SELECT COUNT(*) FROM auto_takeover_log t WHERE t.rule_id = r.id AND t.action_taken = 'replied') AS total_replied,
        (SELECT COUNT(*) FROM auto_takeover_log t WHERE t.rule_id = r.id AND t.action_taken = 'skipped') AS total_skipped
      FROM auto_takeover_rules r ORDER BY r.created_at DESC
    `);
    res.json({ rules, trigger_types: TRIGGER_TYPES, actions: ACTIONS });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Create rule
router.post("/auto-takeover", async (req, res) => {
  try {
    const {
      name, trigger_type = "rep_slow", wait_minutes = 15,
      applies_to_stage, applies_to_status,
      action = "reply_and_notify_rep", fiza_prompt, fallback_message,
      max_takeovers_per_lead = 3, cooldown_minutes = 30,
      only_during_hours = false, notify_manager = true, is_active = true,
    } = req.body;

    if (!name) return res.status(400).json({ error: "name is required" });

    const [result] = await sequelize.query(
      `INSERT INTO auto_takeover_rules
         (name, trigger_type, wait_minutes, applies_to_stage, applies_to_status,
          action, fiza_prompt, fallback_message,
          max_takeovers_per_lead, cooldown_minutes, only_during_hours, notify_manager, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      { replacements: [
        name, trigger_type, wait_minutes,
        applies_to_stage ? JSON.stringify(applies_to_stage) : null,
        applies_to_status ? JSON.stringify(applies_to_status) : null,
        action, fiza_prompt || null, fallback_message || null,
        max_takeovers_per_lead, cooldown_minutes,
        only_during_hours ? 1 : 0, notify_manager ? 1 : 0, is_active ? 1 : 0,
      ]}
    );
    res.status(201).json({ id: result?.insertId ?? result, message: "Rule created" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Update rule
router.put("/auto-takeover/:id", async (req, res) => {
  try {
    const allowed = [
      "name", "trigger_type", "wait_minutes", "applies_to_stage", "applies_to_status",
      "action", "fiza_prompt", "fallback_message",
      "max_takeovers_per_lead", "cooldown_minutes",
      "only_during_hours", "notify_manager", "is_active",
    ];
    const sets = [], vals = [];
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        let val = req.body[key];
        if ((key === "applies_to_stage" || key === "applies_to_status") && typeof val === "object") val = JSON.stringify(val);
        if (typeof val === "boolean") val = val ? 1 : 0;
        sets.push(`${key} = ?`);
        vals.push(val);
      }
    }
    if (!sets.length) return res.status(400).json({ error: "Nothing to update" });
    vals.push(req.params.id);
    await sequelize.query(`UPDATE auto_takeover_rules SET ${sets.join(", ")} WHERE id = ?`, { replacements: vals });
    res.json({ message: "Updated" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete rule
router.delete("/auto-takeover/:id", async (req, res) => {
  try {
    await sequelize.query(`DELETE FROM auto_takeover_rules WHERE id = ?`, { replacements: [req.params.id] });
    res.json({ message: "Deleted" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Logs for a rule
router.get("/auto-takeover/:id/logs", async (req, res) => {
  try {
    const [logs] = await sequelize.query(
      `SELECT t.*, l.name AS lead_name, r.name AS rep_name
       FROM auto_takeover_log t
       LEFT JOIN leads l ON l.id = t.lead_id
       LEFT JOIN sales_reps r ON r.id = t.rep_id
       WHERE t.rule_id = ?
       ORDER BY t.created_at DESC LIMIT 50`,
      { replacements: [req.params.id] }
    );
    res.json({ logs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Manual trigger
router.post("/auto-takeover/tick", async (req, res) => {
  try { res.json(await tick()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
