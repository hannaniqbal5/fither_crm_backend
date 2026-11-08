/**
 * automation.routes.js — admin endpoints for managing Phase 2.
 *
 * All routes require auth + admin role.
 * Frontend can use these to build the rules/template manager in Phase 4.
 */

const express = require("express");
const auth    = require("../middleware/auth.middleware");
const { AutomationRule, AutomationLog, MessageTemplate, People } = require("../../models");
const { v4: uuidv4 } = require("uuid");

const router = express.Router();

// Fields an admin may change via PUT (mirrors the create handlers / models).
// Primary keys (rule_id / template_id) and created_by are never updatable.
const RULE_UPDATABLE     = ["name", "trigger_event", "conditions", "actions", "channel", "delay_minutes", "run_once_per_person", "active"];
const TEMPLATE_UPDATABLE = ["name", "channel", "language", "body", "media_url", "active"];

function pick(body, keys) {
  const out = {};
  for (const k of keys) {
    if (body && body[k] !== undefined) out[k] = body[k];
  }
  return out;
}

// ── Admin guard middleware ─────────────────────────────────────
const adminOnly = (req, res, next) => {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ error: "Admin only" });
  }
  next();
};

// ═══════════════════════════════════════════════════════════════
// AUTOMATION RULES
// ═══════════════════════════════════════════════════════════════

// GET /api/automation/rules
router.get("/rules", auth, adminOnly, async (req, res) => {
  try {
    const rules = await AutomationRule.findAll({ order: [["created_at", "DESC"]] });
    // MySQL JSON columns can return as strings via Sequelize — parse so the
    // client always receives actions as an array and conditions as an object.
    const parse = (v, fb) => {
      if (v == null) return fb;
      if (typeof v === "string") { try { return JSON.parse(v); } catch { return fb; } }
      return v;
    };
    res.json(
      rules.map((r) => {
        const j = r.toJSON();
        return { ...j, actions: parse(j.actions, []), conditions: parse(j.conditions, {}) };
      })
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/automation/rules
router.post("/rules", auth, adminOnly, async (req, res) => {
  try {
    const { name, trigger_event, conditions, actions, channel, delay_minutes, run_once_per_person } = req.body;

    if (!name || !trigger_event || !actions) {
      return res.status(400).json({ error: "name, trigger_event, and actions are required" });
    }

    const rule = await AutomationRule.create({
      rule_id:             uuidv4(),
      name,
      trigger_event,
      conditions:          conditions || {},
      actions:             Array.isArray(actions) ? actions : [actions],
      channel:             channel || "any",
      delay_minutes:       delay_minutes || 0,
      run_once_per_person: run_once_per_person !== undefined ? run_once_per_person : 1,
      active:              1,
      created_by:          req.user.repId,
    });

    res.status(201).json(rule);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/automation/rules/:id/toggle — enable/disable
router.patch("/rules/:id/toggle", auth, adminOnly, async (req, res) => {
  try {
    const rule = await AutomationRule.findByPk(req.params.id);
    if (!rule) return res.status(404).json({ error: "Rule not found" });

    rule.active = rule.active ? 0 : 1;
    await rule.save();

    res.json({ success: true, active: rule.active, name: rule.name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/automation/rules/:id — full update
router.put("/rules/:id", auth, adminOnly, async (req, res) => {
  try {
    const rule = await AutomationRule.findByPk(req.params.id);
    if (!rule) return res.status(404).json({ error: "Rule not found" });

    await rule.update(pick(req.body, RULE_UPDATABLE));
    res.json(rule);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/automation/rules/:id
router.delete("/rules/:id", auth, adminOnly, async (req, res) => {
  try {
    const rule = await AutomationRule.findByPk(req.params.id);
    if (!rule) return res.status(404).json({ error: "Rule not found" });

    await rule.destroy();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// MESSAGE TEMPLATES
// ═══════════════════════════════════════════════════════════════

// GET /api/automation/templates
router.get("/templates", auth, adminOnly, async (req, res) => {
  try {
    const { channel, language } = req.query;
    const where = {};
    if (channel)  where.channel  = channel;
    if (language) where.language = language;

    const templates = await MessageTemplate.findAll({
      where,
      order: [["name", "ASC"]],
    });
    res.json(templates);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/automation/templates
router.post("/templates", auth, adminOnly, async (req, res) => {
  try {
    const { name, channel, language, body, media_url } = req.body;

    if (!name || !channel || !language || !body) {
      return res.status(400).json({ error: "name, channel, language, body are required" });
    }

    const template = await MessageTemplate.create({
      template_id: uuidv4(),
      name,
      channel,
      language,
      body,
      media_url:   media_url || null,
      created_by:  req.user.repId,
    });

    res.status(201).json(template);
  } catch (err) {
    if (err.name === "SequelizeUniqueConstraintError") {
      return res.status(400).json({ error: `Template name "${req.body.name}" already exists` });
    }
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/automation/templates/:id
router.put("/templates/:id", auth, adminOnly, async (req, res) => {
  try {
    const template = await MessageTemplate.findByPk(req.params.id);
    if (!template) return res.status(404).json({ error: "Template not found" });

    await template.update(pick(req.body, TEMPLATE_UPDATABLE));
    res.json(template);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/automation/templates/:id/toggle — enable/disable without deleting
router.patch("/templates/:id/toggle", auth, adminOnly, async (req, res) => {
  try {
    const template = await MessageTemplate.findByPk(req.params.id);
    if (!template) return res.status(404).json({ error: "Template not found" });

    template.active = template.active ? 0 : 1;
    await template.save();

    res.json({ success: true, active: template.active, name: template.name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/automation/templates/:id
router.delete("/templates/:id", auth, adminOnly, async (req, res) => {
  try {
    const template = await MessageTemplate.findByPk(req.params.id);
    if (!template) return res.status(404).json({ error: "Template not found" });

    await template.destroy();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// AUTOMATION LOGS
// ═══════════════════════════════════════════════════════════════

// GET /api/automation/logs — filter by channel, status, rule
router.get("/logs", auth, adminOnly, async (req, res) => {
  try {
    const { channel, status, rule_id, limit = 100 } = req.query;
    const where = {};
    if (channel) where.channel = channel;
    if (status)  where.status  = status;
    if (rule_id) where.rule_id = rule_id;

    const logs = await AutomationLog.findAll({
      where,
      include: [
        { model: AutomationRule, attributes: ["name", "trigger_event", "channel"] },
        { model: People,         attributes: ["phone", "name", "stage", "source"] },
      ],
      order: [["executed_at", "DESC"]],
      limit:  parseInt(limit),
    });

    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/automation/logs/by-channel — aggregated stats per channel
router.get("/logs/by-channel", auth, adminOnly, async (req, res) => {
  try {
    const { sequelize } = require("../../models");
    const { QueryTypes } = require("sequelize");

    const stats = await sequelize.query(
      `SELECT channel,
              COUNT(*) as total,
              SUM(status = 'success') as success,
              SUM(status = 'failed')  as failed,
              SUM(status = 'skipped') as skipped
       FROM automation_logs
       GROUP BY channel
       ORDER BY total DESC`,
      { type: QueryTypes.SELECT }
    );

    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
