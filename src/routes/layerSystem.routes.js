/**
 * layerSystem.routes.js — REST endpoints for the Layer System.
 *
 * ── Access control ──
 *   Every endpoint requires `auth`.
 *
 *   ADMINS (role=admin) get the full cross-team view: all leads,
 *   all reps' analytics, kill switches, graduation, audit log.
 *
 *   REPS (role=rep) get a SELF-SCOPED view: only leads where
 *   assigned_to = their repId. They can override intent on their
 *   own leads but cannot touch settings / graduation / audit.
 *
 *   ANONYMOUS users get 401 on every route.
 *
 * Endpoints:
 *   GET    /enums                              — picker values (any logged-in user)
 *   GET    /leads                              — list leads (rep-scoped or all)
 *   PATCH  /leads/:id/intent                   — override intent (admin-any, rep-own)
 *   POST   /leads/:id/pause                    — pause follow-ups (admin-any, rep-own)
 *   GET    /leads/:id/history                  — intent history (admin-any, rep-own)
 *   GET    /funnel-counts                      — top-bar widget (rep-scoped or all)
 *   GET    /analytics/intent-distribution      — chart data (rep-scoped or all)
 *   GET    /analytics/hot-leads                — hot/urgent leads (rep-scoped or all)
 *   GET    /settings                           — kill switches  [ADMIN]
 *   PATCH  /settings/:key                      — update setting [ADMIN]
 *   GET    /analytics/followup-performance     — template KPIs  [ADMIN]
 *   POST   /analytics/graduate                 — graduate tpl   [ADMIN]
 *   GET    /analytics/override-audit           — global audit   [ADMIN]
 */

const express = require("express");
const router  = express.Router();
const { Op }  = require("sequelize");
const sequelize = require("../config/database");
const { People, SalesRep } = require("../../models");
const { funnelStageFor }   = require("../ai/intentDetector");
const { loadHistory }     = require("../ai/intentHistory");
const { TEMPLATES, keyFor, pickVariant, renderTemplate } = require("../ai/followupTemplates");
const { withLifecycleAll } = require("../utils/lifecycle");
const auth = require("../middleware/auth.middleware");

// ── Auth applied to EVERY endpoint in this router ────────────────
router.use(auth);

// ── Role helpers ─────────────────────────────────────────────────
function isAdmin(req) {
  return req.user?.role === "admin";
}

function adminOnly(req, res, next) {
  if (!isAdmin(req)) return res.status(403).json({ error: "Admin access required" });
  next();
}

/**
 * scopeToOwnedLeads — merges `{ assigned_to: req.user.repId }` into a
 * Sequelize `where` clause for non-admin callers. Admins get the
 * clause untouched.
 */
function scopeToOwnedLeads(req, where = {}) {
  if (isAdmin(req)) return where;
  return { ...where, assigned_to: req.user?.repId ?? -1 };
}

/**
 * assertOwnsOr403 — used on per-lead routes. Returns true if the
 * caller may operate on this lead; otherwise sends 403 and returns false.
 */
function assertOwnsOr403(req, res, lead) {
  if (isAdmin(req)) return true;
  if (lead && Number(lead.assigned_to) === Number(req.user?.repId)) return true;
  res.status(403).json({ error: "Not your lead" });
  return false;
}

// ── Picker values (must mirror migration 009 ENUMs) ──────────────
const INTERACTION_STATUSES = [
  "new_inbound","awaiting_reply","active_chat","ghosted",
  "asking_about_program","asking_about_price","comparing_plans","discussing_with_family","requesting_trial",
  "price_negotiation","price_objection","timing_objection","medical_concern","husband_blocking","will_start_later",
  "callback_scheduled","ready_to_pay","payment_link_sent","payment_pending","onboarded",
  "not_interested","wrong_number","lost_to_competitor","opted_out",
];
const MAIN_GOALS    = ["pcos","weight_loss","weight_gain","postpartum","diabetes","general"];
const OBJECTIONS    = ["price","timing","family","medical","fit","none"];
const FUNNEL_STAGES = [1,2,3,4,5];

const STATUS_GROUPS = {
  engagement: ["new_inbound","awaiting_reply","active_chat","ghosted"],
  warm:       ["asking_about_program","asking_about_price","comparing_plans","discussing_with_family","requesting_trial"],
  objection:  ["price_negotiation","price_objection","timing_objection","medical_concern","husband_blocking","will_start_later"],
  closing:    ["callback_scheduled","ready_to_pay","payment_link_sent","payment_pending","onboarded"],
  dead:       ["not_interested","wrong_number","lost_to_competitor","opted_out"],
};

// ──────────────────────────────────────────────────────────────────
// GET /api/layer-system/enums
// ──────────────────────────────────────────────────────────────────
router.get("/enums", (req, res) => {
  res.json({
    interaction_statuses: INTERACTION_STATUSES,
    main_goals: MAIN_GOALS,
    objections: OBJECTIONS,
    funnel_stages: FUNNEL_STAGES,
    status_groups: STATUS_GROUPS,
  });
});

// ──────────────────────────────────────────────────────────────────
// GET /api/layer-system/leads
//   query: ?interaction_status=ghosted&main_goal=pcos&funnel_stage=4
//          &score_min=60&assigned_to=12&limit=50&offset=0
// ──────────────────────────────────────────────────────────────────
router.get("/leads", async (req, res) => {
  try {
    const {
      interaction_status, main_goal, last_objection, funnel_stage,
      score_min, score_max, assigned_to, paused, group,
      limit = 50, offset = 0,
    } = req.query;

    let where = {};
    if (interaction_status) where.interaction_status = interaction_status;
    if (main_goal)          where.main_goal = main_goal;
    if (last_objection)     where.last_objection = last_objection;
    if (funnel_stage)       where.funnel_stage = funnel_stage;
    // Reps can NEVER filter by another rep — overwritten by scope below.
    if (assigned_to && isAdmin(req)) where.assigned_to = assigned_to;
    if (paused === "true")  where.auto_followup_paused = true;
    if (paused === "false") where.auto_followup_paused = false;
    if (score_min || score_max) {
      where.lead_score = {};
      if (score_min) where.lead_score[Op.gte] = parseInt(score_min, 10);
      if (score_max) where.lead_score[Op.lte] = parseInt(score_max, 10);
    }
    if (group && STATUS_GROUPS[group]) {
      where.interaction_status = { [Op.in]: STATUS_GROUPS[group] };
    }

    // Rep-scope: non-admins can only see leads assigned to them
    where = scopeToOwnedLeads(req, where);

    const rows = await People.findAll({
      where,
      attributes: [
        "id","name","phone","stage","status","lead_score",
        "interaction_status","main_goal","last_objection",
        "funnel_stage","auto_followup_paused",
        "last_message_at","last_intent_detected_at","assigned_to","source",
      ],
      include: [{ model: SalesRep, attributes: ["id","name","email"], required: false }],
      order: [["lead_score","DESC"], ["last_message_at","DESC"]],
      limit: parseInt(limit, 10),
      offset: parseInt(offset, 10),
    });

    const enriched = withLifecycleAll(rows.map(r => r.toJSON ? r.toJSON() : r));
    res.json({ leads: enriched, count: enriched.length });
  } catch (err) {
    console.error("[layer-system/leads]", err);
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────────
// PATCH /api/layer-system/leads/:id/intent
//   body: { interaction_status?, main_goal?, last_objection?, funnel_stage?, override_reason? }
// Logs override into intent_history.
// ──────────────────────────────────────────────────────────────────
router.patch("/leads/:id/intent", async (req, res) => {
  try {
    const lead = await People.findByPk(req.params.id);
    if (!lead) return res.status(404).json({ error: "Lead not found" });
    if (!assertOwnsOr403(req, res, lead)) return;

    const patch = {};
    const { interaction_status, main_goal, last_objection, funnel_stage, override_reason } = req.body;

    if (interaction_status !== undefined) {
      if (interaction_status && !INTERACTION_STATUSES.includes(interaction_status))
        return res.status(400).json({ error: `Invalid interaction_status: ${interaction_status}` });
      patch.interaction_status = interaction_status;
    }
    if (main_goal !== undefined) {
      if (main_goal && !MAIN_GOALS.includes(main_goal))
        return res.status(400).json({ error: `Invalid main_goal: ${main_goal}` });
      patch.main_goal = main_goal;
      if (main_goal) patch.goal_detected_at = new Date();
    }
    if (last_objection !== undefined) {
      if (last_objection && !OBJECTIONS.includes(last_objection))
        return res.status(400).json({ error: `Invalid last_objection: ${last_objection}` });
      patch.last_objection = last_objection;
    }
    if (funnel_stage !== undefined) {
      const stageNum = Number(funnel_stage);
      if (!FUNNEL_STAGES.includes(stageNum))
        return res.status(400).json({ error: `Invalid funnel_stage: ${funnel_stage}. Must be 1-5.` });
      patch.funnel_stage = stageNum;
    }

    // If status/goal changes but funnel_stage not explicitly set, recompute
    if (patch.funnel_stage === undefined && (patch.interaction_status || patch.main_goal || patch.last_objection)) {
      patch.funnel_stage = funnelStageFor({ ...lead.toJSON(), ...patch });
    }

    patch.last_intent_detected_at = new Date();

    // Append to intent_history
    const history = [...loadHistory(lead)];
    history.unshift({
      ts: new Date().toISOString(),
      source: "manual_override",
      reason: override_reason || null,
      previous: {
        interaction_status: lead.interaction_status,
        main_goal: lead.main_goal,
        last_objection: lead.last_objection,
        funnel_stage: lead.funnel_stage,
      },
      next: patch,
      rep_id: req.user?.repId || null,
      rep_source: req.user?.source || null,
    });
    patch.intent_history = history.slice(0, 10);

    await lead.update(patch);

    res.json({ ok: true, lead });
  } catch (err) {
    console.error("[layer-system/intent PATCH]", err);
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────────
// POST /api/layer-system/leads/:id/pause   body: { paused: true|false }
// ──────────────────────────────────────────────────────────────────
router.post("/leads/:id/pause", async (req, res) => {
  try {
    const lead = await People.findByPk(req.params.id);
    if (!lead) return res.status(404).json({ error: "Lead not found" });
    if (!assertOwnsOr403(req, res, lead)) return;
    await lead.update({ auto_followup_paused: !!req.body.paused });
    res.json({ ok: true, paused: lead.auto_followup_paused });
  } catch (err) {
    console.error("[layer-system/pause]", err);
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────────
// GET /api/layer-system/leads/:id/history
// ──────────────────────────────────────────────────────────────────
router.get("/leads/:id/history", async (req, res) => {
  try {
    const lead = await People.findByPk(req.params.id, {
      attributes: ["id","assigned_to","intent_history","interaction_status","main_goal","last_objection","funnel_stage","lead_score","auto_followup_paused"],
    });
    if (!lead) return res.status(404).json({ error: "Lead not found" });
    if (!assertOwnsOr403(req, res, lead)) return;
    res.json({
      current: {
        interaction_status: lead.interaction_status,
        main_goal: lead.main_goal,
        last_objection: lead.last_objection,
        funnel_stage: lead.funnel_stage,
        lead_score: lead.lead_score,
        auto_followup_paused: lead.auto_followup_paused,
      },
      history: loadHistory(lead),
    });
  } catch (err) {
    console.error("[layer-system/history]", err);
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────────
// GET /api/layer-system/settings
// ──────────────────────────────────────────────────────────────────
router.get("/settings", adminOnly, async (req, res) => {
  try {
    const [rows] = await sequelize.query(
      "SELECT setting_key, setting_value, description, updated_at FROM layer_system_settings"
    );
    res.json({ settings: rows });
  } catch (err) {
    console.error("[layer-system/settings GET]", err);
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────────
// PATCH /api/layer-system/settings/:key   body: { value }
// ──────────────────────────────────────────────────────────────────
router.patch("/settings/:key", adminOnly, async (req, res) => {
  try {
    const { key } = req.params;
    const { value } = req.body;
    if (value === undefined) return res.status(400).json({ error: "value required" });

    // The follow-up switches (migration 052) may not have a row yet: create it.
    if (["followups_enabled", "followups_skip_campaign_ladder"].includes(key)) {
      if (!["0", "1"].includes(String(value))) return res.status(400).json({ error: "value must be 0 or 1" });
      await sequelize.query(
        "INSERT IGNORE INTO layer_system_settings (setting_key, setting_value) VALUES (?, '1')",
        { replacements: [key] }
      );
    }
    await sequelize.query(
      "UPDATE layer_system_settings SET setting_value = ?, updated_by = ? WHERE setting_key = ?",
      { replacements: [String(value), req.user?.repId || null, key] }
    );
    res.json({ ok: true, key, value });
  } catch (err) {
    console.error("[layer-system/settings PATCH]", err);
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────────
// GET /api/layer-system/funnel-counts — dashboard top-bar widget
// Returns { stage_1, stage_2, stage_3, stage_4, stage_5 }
// ──────────────────────────────────────────────────────────────────
router.get("/funnel-counts", async (req, res) => {
  try {
    // Rep-scope: build the SQL filter dynamically
    const scopeSql = isAdmin(req) ? "" : "AND assigned_to = ?";
    const replacements = isAdmin(req) ? [] : [req.user?.repId ?? -1];

    const [rows] = await sequelize.query(
      `SELECT funnel_stage, COUNT(*) AS count
         FROM leads
         WHERE stage IN ('visitor','lead') ${scopeSql}
         GROUP BY funnel_stage`,
      { replacements }
    );
    const counts = { stage_1: 0, stage_2: 0, stage_3: 0, stage_4: 0, stage_5: 0 };
    rows.forEach(r => { counts[`stage_${r.funnel_stage || 1}`] = Number(r.count); });
    res.json(counts);
  } catch (err) {
    console.error("[layer-system/funnel-counts]", err);
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────────
// GET /api/layer-system/analytics/intent-distribution
// Counts of leads bucketed by interaction_status, main_goal, funnel_stage.
// ──────────────────────────────────────────────────────────────────
router.get("/analytics/intent-distribution", async (req, res) => {
  try {
    const scopeSql = isAdmin(req) ? "" : "AND assigned_to = ?";
    const replacements = isAdmin(req) ? [] : [req.user?.repId ?? -1];

    const [byStatus] = await sequelize.query(
      `SELECT interaction_status, COUNT(*) AS c
         FROM leads WHERE stage IN ('visitor','lead') ${scopeSql}
         GROUP BY interaction_status ORDER BY c DESC`,
      { replacements }
    );
    const [byGoal] = await sequelize.query(
      `SELECT main_goal, COUNT(*) AS c
         FROM leads WHERE stage IN ('visitor','lead') ${scopeSql}
         GROUP BY main_goal ORDER BY c DESC`,
      { replacements }
    );
    const [byObjection] = await sequelize.query(
      `SELECT last_objection, COUNT(*) AS c
         FROM leads WHERE stage IN ('visitor','lead') ${scopeSql}
         GROUP BY last_objection ORDER BY c DESC`,
      { replacements }
    );
    const [byFunnel] = await sequelize.query(
      `SELECT funnel_stage, COUNT(*) AS c
         FROM leads WHERE stage IN ('visitor','lead') ${scopeSql}
         GROUP BY funnel_stage ORDER BY funnel_stage`,
      { replacements }
    );
    res.json({ byStatus, byGoal, byObjection, byFunnel });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────────
// GET /api/layer-system/analytics/followup-performance
// Per-template_key metrics for soft-launch graduation review.
// ──────────────────────────────────────────────────────────────────
router.get("/analytics/followup-performance", adminOnly, async (req, res) => {
  try {
    const [rows] = await sequelize.query(
      `SELECT template_key,
              SUM(total_fires)     AS total_fires,
              SUM(approved_count)  AS approved,
              SUM(edited_count)    AS edited,
              SUM(rejected_count)  AS rejected,
              SUM(auto_sent_count) AS auto_sent,
              MAX(graduated)       AS graduated,
              MIN(graduated_at)    AS graduated_at
         FROM category_metrics
         WHERE metric_date >= DATE_SUB(CURDATE(), INTERVAL 14 DAY)
         GROUP BY template_key
         ORDER BY total_fires DESC`
    );

    const enriched = rows.map(r => {
      const total = Number(r.total_fires || 0);
      const edited = Number(r.edited || 0);
      const rejected = Number(r.rejected || 0);
      const editRate = total > 0 ? (edited / total) : 0;
      const rejectRate = total > 0 ? (rejected / total) : 0;
      const eligible = total >= 10 && editRate < 0.10 && rejectRate < 0.05;
      return { ...r, edit_rate: editRate, reject_rate: rejectRate, eligible_for_tier1: eligible };
    });
    res.json({ rows: enriched });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------------------------------------------
// POST /api/layer-system/analytics/graduate
// body: { template_key } - admin manually graduates a category to Tier 1
// ------------------------------------------------------------------
router.post("/analytics/graduate", adminOnly, async (req, res) => {
  try {
    const { template_key } = req.body;
    if (!template_key) return res.status(400).json({ error: "template_key required" });
    await sequelize.query(
      `UPDATE category_metrics
         SET graduated = 1, graduated_at = NOW()
         WHERE template_key = ?`,
      { replacements: [template_key] }
    );
    res.json({ ok: true, template_key });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------------------------------------------
// GET /api/layer-system/analytics/override-audit
// Last 100 manual overrides across all leads (for admin review)
// ------------------------------------------------------------------
router.get("/analytics/override-audit", adminOnly, async (req, res) => {
  try {
    const [rows] = await sequelize.query(
      `SELECT id, name, phone, intent_history
         FROM leads
         WHERE intent_history IS NOT NULL
         ORDER BY last_intent_detected_at DESC
         LIMIT 100`
    );
    const events = [];
    rows.forEach(r => {
      const hist = loadHistory(r);
      hist.filter(h => h.source === "manual_override").forEach(h => {
        events.push({ lead_id: r.id, name: r.name, phone: r.phone, ...h });
      });
    });
    events.sort((a, b) => new Date(b.ts) - new Date(a.ts));
    res.json({ events: events.slice(0, 100) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------------------------------------------
// GET /api/layer-system/analytics/hot-leads
//
// Replaces the old "founder WhatsApp alert at score >=150".
// Returns leads bucketed by score band so admins can monitor hot
// activity from the Layer System tab instead of getting WhatsApp pings.
//
// Buckets:
//   urgent  - score >= urgent_threshold (default 150)
//   hot     - score >= 100 and < urgent_threshold
//   warming - score >= 60  and < 100
//
// Scoped: admins see all, reps see only their own assigned leads.
// ------------------------------------------------------------------
router.get("/analytics/hot-leads", async (req, res) => {
  try {
    let urgentThreshold = 150;
    try {
      const [settingRows] = await sequelize.query(
        `SELECT setting_value FROM layer_system_settings WHERE setting_key='founder_alert_threshold'`
      );
      if (settingRows[0]) urgentThreshold = parseInt(settingRows[0].setting_value, 10) || 150;
    } catch { /* keep default */ }

    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);

    // Rep-scope: non-admins only see their own assigned leads.
    const where = scopeToOwnedLeads(req, {
      lead_score: { [Op.gte]: 60 },
      stage: { [Op.in]: ["visitor", "lead"] },
    });

    const rows = await People.findAll({
      where,
      attributes: [
        "id", "name", "phone", "stage", "status", "lead_score",
        "interaction_status", "main_goal", "last_objection",
        "funnel_stage", "auto_followup_paused",
        "last_message_at", "last_intent_detected_at",
        "assigned_to", "source", "intent_history",
      ],
      include: [{ model: SalesRep, attributes: ["id", "name", "email"], required: false }],
      order: [["lead_score", "DESC"], ["last_intent_detected_at", "DESC"]],
      limit,
    });

    const enriched = rows.map(r => {
      const json = r.toJSON();
      const score = Number(json.lead_score || 0);
      const band = score >= urgentThreshold ? "urgent" : score >= 100 ? "hot" : "warming";

      const hist = Array.isArray(json.intent_history) ? json.intent_history
                 : (typeof json.intent_history === "string"
                      ? (() => { try { return JSON.parse(json.intent_history); } catch { return []; } })()
                      : []);
      const lastPromotion = hist.find(h =>
        h.source === "layer3_promotion" && h.level === band
      );

      delete json.intent_history;

      return {
        ...json,
        band,
        score_band_since: lastPromotion?.ts || null,
      };
    });

    const counts = enriched.reduce(
      (acc, r) => { acc[r.band] = (acc[r.band] || 0) + 1; return acc; },
      { urgent: 0, hot: 0, warming: 0 }
    );

    res.json({
      urgent_threshold: urgentThreshold,
      counts,
      leads: enriched,
    });
  } catch (err) {
    console.error("[layer-system/hot-leads]", err);
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------------------------------------------
// GET /api/layer-system/leads/:id/next-followup
//
// For a single lead, compute which template would fire next + ETA.
// Used by the rep's chat view to show "Next follow-up: <template> in <eta>".
//
// Response shape:
//   {
//     lead_id, template_key, tier, silence_hours,
//     eta_minutes,            // minutes until fire (negative = overdue, fires next scan)
//     fires_at_iso,           // absolute timestamp
//     preview_text,           // rendered template the rep would send
//     paused,                 // bool — lead is paused
//     blocked: null | string  // "paused" | "opted_out" | "no_template" | "no_message_yet"
//   }
// ------------------------------------------------------------------
router.get("/leads/:id/next-followup", async (req, res) => {
  try {
    const lead = await People.findByPk(req.params.id);
    if (!lead) return res.status(404).json({ error: "Lead not found" });
    if (!assertOwnsOr403(req, res, lead)) return;

    if (lead.interaction_status === "opted_out") {
      return res.json({ lead_id: lead.id, blocked: "opted_out" });
    }
    if (lead.auto_followup_paused) {
      return res.json({ lead_id: lead.id, blocked: "paused", paused: true });
    }
    if (!lead.last_message_at) {
      return res.json({ lead_id: lead.id, blocked: "no_message_yet" });
    }

    const templateKey = keyFor(lead.interaction_status, lead.main_goal);
    if (!templateKey) {
      return res.json({ lead_id: lead.id, blocked: "no_template" });
    }

    const tpl = TEMPLATES[templateKey];
    // Nov 2026 sequences: next step is timed from HER last message.
    const { stepsFor } = require("../ai/followupTemplates");
    const steps = stepsFor(templateKey);
    const [[li]] = await sequelize.query(
      "SELECT MAX(created_at) AS t FROM messages WHERE lead_id = :id AND direction = 'IN'",
      { replacements: { id: lead.id } }
    );
    const lastMs = new Date((li && li.t) || lead.last_message_at).getTime();
    const [[dn]] = await sequelize.query(
      "SELECT COUNT(*) AS c FROM intent_followup_queue WHERE lead_id = :id AND status IN ('sent','drafted') AND fired_at > :since",
      { replacements: { id: lead.id, since: new Date(lastMs) } }
    );
    const stepsDone = Number(dn.c || 0);
    if (!steps.length || stepsDone >= steps.length) {
      return res.json({ lead_id: lead.id, template_key: templateKey, blocked: "sequence_done", steps_done: stepsDone, steps_total: steps.length });
    }
    const firesAtMs = lastMs + steps[stepsDone] * 3600 * 1000;
    const etaMinutes = Math.round((firesAtMs - Date.now()) / 60000);

    // Preview = the old template idea; the real message is written by Fiza when it fires.
    const variantText = pickVariant(templateKey, 0);
    const preview = renderTemplate(variantText, lead);

    res.json({
      lead_id: lead.id,
      template_key: templateKey,
      tier: tpl.tier,
      silence_hours: steps[stepsDone],
      step: stepsDone + 1,
      steps_total: steps.length,
      written_by: "fiza",
      eta_minutes: etaMinutes,
      fires_at_iso: new Date(firesAtMs).toISOString(),
      preview_text: preview,
      paused: false,
      blocked: null,
    });
  } catch (err) {
    console.error("[layer-system/next-followup]", err);
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------------------------------------------
// GET /api/layer-system/upcoming-followups?within_hours=24
//
// Returns the queue of follow-ups due in the next N hours.
// Rep-scoped: non-admins only see follow-ups for their own leads.
//
// Response:
//   {
//     within_hours,
//     count_total,
//     count_by_template: { "ghosted__pcos": 4, ... },
//     count_by_band: { overdue: 2, soon: 5, later: 12 },
//     leads: [{ lead_id, name, phone, template_key, eta_minutes, ... }]
//   }
// ------------------------------------------------------------------
router.get("/upcoming-followups", async (req, res) => {
  try {
    const withinHours = Math.min(parseInt(req.query.within_hours, 10) || 24, 168);

    // Pull all eligible leads (rep-scoped) and compute their next fire client-side.
    // Eligible = not opted out, not paused, has last_message_at, in visitor/lead.
    const where = scopeToOwnedLeads(req, {
      stage: { [Op.in]: ["visitor", "lead"] },
      auto_followup_paused: false,
      last_message_at: { [Op.ne]: null },
    });

    const rows = await People.findAll({
      where,
      attributes: [
        "id", "name", "phone", "interaction_status", "main_goal",
        "last_message_at", "assigned_to", "lead_score",
      ],
      limit: 1000,
    });

    const now = Date.now();
    const horizonMs = withinHours * 3600 * 1000;
    const leads = [];

    for (const r of rows) {
      if (!r.interaction_status || r.interaction_status === "opted_out") continue;
      const tplKey = keyFor(r.interaction_status, r.main_goal);
      if (!tplKey) continue;
      const tpl = TEMPLATES[tplKey];
      if (!tpl || tpl.silence_hours < 0) continue;

      const lastMs = new Date(r.last_message_at).getTime();
      const firesAtMs = lastMs + tpl.silence_hours * 3600 * 1000;
      const etaMinutes = Math.round((firesAtMs - now) / 60000);

      // Within window OR already overdue (will fire next scan)
      if (firesAtMs - now > horizonMs) continue;

      leads.push({
        lead_id: r.id,
        name: r.name,
        phone: r.phone,
        interaction_status: r.interaction_status,
        main_goal: r.main_goal,
        assigned_to: r.assigned_to,
        lead_score: r.lead_score,
        template_key: tplKey,
        tier: tpl.tier,
        silence_hours: tpl.silence_hours,
        eta_minutes: etaMinutes,
        fires_at_iso: new Date(firesAtMs).toISOString(),
      });
    }

    leads.sort((a, b) => a.eta_minutes - b.eta_minutes);

    const countByTemplate = {};
    const countByBand = { overdue: 0, soon: 0, later: 0 };
    for (const l of leads) {
      countByTemplate[l.template_key] = (countByTemplate[l.template_key] || 0) + 1;
      if (l.eta_minutes <= 0) countByBand.overdue++;
      else if (l.eta_minutes <= 120) countByBand.soon++;
      else countByBand.later++;
    }

    res.json({
      within_hours: withinHours,
      count_total: leads.length,
      count_by_template: countByTemplate,
      count_by_band: countByBand,
      leads: leads.slice(0, 500),
    });
  } catch (err) {
    console.error("[layer-system/upcoming-followups]", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
