/**
 * autoCampaign.routes.js — CRUD for auto-campaign rules + stats.
 *
 * Routes:
 *   GET    /api/auto-campaigns          — list all rules
 *   POST   /api/auto-campaigns          — create a rule
 *   PUT    /api/auto-campaigns/:id      — update a rule
 *   DELETE /api/auto-campaigns/:id      — delete a rule
 *   GET    /api/auto-campaigns/:id/stats — sends/skips breakdown
 *   POST   /api/auto-campaigns/tick     — manually trigger engine (admin)
 */

const router = require("express").Router();
const sequelize = require("../config/database");
const { tick, TRIGGER_QUERIES } = require("../services/autoCampaign.service");

// List all rules
router.get("/auto-campaigns", async (req, res) => {
  try {
    const [rules] = await sequelize.query(
      `SELECT r.*,
              (SELECT COUNT(*) FROM auto_campaign_sends s WHERE s.rule_id = r.id AND s.status = 'sent') AS total_sent,
              (SELECT COUNT(*) FROM auto_campaign_sends s WHERE s.rule_id = r.id AND s.status = 'skipped') AS total_skipped
       FROM auto_campaign_rules r
       ORDER BY r.created_at DESC`
    );
    res.json({ rules, available_triggers: Object.keys(TRIGGER_QUERIES) });
  } catch (e) {
    console.error("[AutoCampaign] list error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Create a rule
router.post("/auto-campaigns", async (req, res) => {
  try {
    const {
      name, trigger_event, delay_hours = 24, conditions,
      channel = "whatsapp", message_template, media_url,
      max_sends_per_lead = 1, cooldown_hours = 24,
      skip_if_rep_active = true, rep_active_hours = 6,
      skip_if_lead_replied = true, is_active = true,
    } = req.body;

    if (!name || !trigger_event || !message_template) {
      return res.status(400).json({ error: "name, trigger_event, and message_template are required" });
    }

    if (!TRIGGER_QUERIES[trigger_event]) {
      return res.status(400).json({ error: `Unknown trigger: ${trigger_event}. Available: ${Object.keys(TRIGGER_QUERIES).join(", ")}` });
    }

    const [result] = await sequelize.query(
      `INSERT INTO auto_campaign_rules
         (name, trigger_event, delay_hours, conditions, channel, message_template, media_url,
          max_sends_per_lead, cooldown_hours, skip_if_rep_active, rep_active_hours,
          skip_if_lead_replied, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      {
        replacements: [
          name, trigger_event, delay_hours,
          conditions ? JSON.stringify(conditions) : null,
          channel, message_template, media_url || null,
          max_sends_per_lead, cooldown_hours,
          skip_if_rep_active ? 1 : 0, rep_active_hours,
          skip_if_lead_replied ? 1 : 0, is_active ? 1 : 0,
        ],
      }
    );

    const insertId = result?.insertId ?? result;
    res.status(201).json({ id: insertId, message: "Rule created" });
  } catch (e) {
    console.error("[AutoCampaign] create error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Update a rule
router.put("/auto-campaigns/:id", async (req, res) => {
  try {
    const allowed = [
      "name", "trigger_event", "delay_hours", "conditions",
      "channel", "message_template", "media_url",
      "max_sends_per_lead", "cooldown_hours",
      "skip_if_rep_active", "rep_active_hours",
      "skip_if_lead_replied", "is_active",
    ];

    const sets = [];
    const vals = [];

    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        let val = req.body[key];
        if (key === "conditions" && typeof val === "object") val = JSON.stringify(val);
        if (typeof val === "boolean") val = val ? 1 : 0;
        sets.push(`${key} = ?`);
        vals.push(val);
      }
    }

    if (!sets.length) return res.status(400).json({ error: "Nothing to update" });

    vals.push(req.params.id);
    await sequelize.query(
      `UPDATE auto_campaign_rules SET ${sets.join(", ")} WHERE id = ?`,
      { replacements: vals }
    );
    res.json({ message: "Rule updated" });
  } catch (e) {
    console.error("[AutoCampaign] update error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Delete a rule
router.delete("/auto-campaigns/:id", async (req, res) => {
  try {
    await sequelize.query(`DELETE FROM auto_campaign_rules WHERE id = ?`, {
      replacements: [req.params.id],
    });
    res.json({ message: "Rule deleted" });
  } catch (e) {
    console.error("[AutoCampaign] delete error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Stats for a rule
router.get("/auto-campaigns/:id/stats", async (req, res) => {
  try {
    const [byStatus] = await sequelize.query(
      `SELECT status, COUNT(*) AS count
       FROM auto_campaign_sends WHERE rule_id = ?
       GROUP BY status`,
      { replacements: [req.params.id] }
    );

    const [byDay] = await sequelize.query(
      `SELECT DATE(sent_at) AS day, status, COUNT(*) AS count
       FROM auto_campaign_sends WHERE rule_id = ?
       GROUP BY DATE(sent_at), status
       ORDER BY day DESC LIMIT 30`,
      { replacements: [req.params.id] }
    );

    const [skipReasons] = await sequelize.query(
      `SELECT skip_reason, COUNT(*) AS count
       FROM auto_campaign_sends
       WHERE rule_id = ? AND status = 'skipped'
       GROUP BY skip_reason ORDER BY count DESC`,
      { replacements: [req.params.id] }
    );

    res.json({ byStatus, byDay, skipReasons });
  } catch (e) {
    console.error("[AutoCampaign] stats error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Manual trigger (admin only)
router.post("/auto-campaigns/tick", async (req, res) => {
  try {
    const result = await tick();
    res.json(result);
  } catch (e) {
    console.error("[AutoCampaign] manual tick error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
