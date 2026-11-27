/**
 * repCampaigns.routes.js — the rep's "Campaigns" tab (Nov 2026).
 *
 * A rep works the women a campaign brought in. She sees every campaign that
 * has at least one of HER women (or is assigned to her), and inside it only
 * her own women, most urgent first:
 *   needs_reply   she wrote last and nobody has answered yet
 *   replied       she answered the campaign at some point
 *   no_reply      got it, hasn't answered
 *   not_sent      still queued / skipped / failed
 * Admins see everyone's women.
 *
 *   GET /api/rep/campaigns
 *   GET /api/rep/campaigns/:id/leads?filter=needs_reply|replied|no_reply|not_sent|all
 */
const express = require("express");
const auth = require("../middleware/auth.middleware");
const sequelize = require("../config/database");

const router = express.Router();
const isAdmin = (req) => req.user?.role === "admin";

// Her last message direction: 'IN' means the ball is in our court.
const LAST_DIR = `(SELECT m.direction FROM messages m WHERE m.lead_id = l.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1)`;

// Which women this rep may see (all for an admin).
function mine(req, rep) {
  if (isAdmin(req)) return "1=1";
  rep.rep = req.user.repId;
  return "l.assigned_to = :rep";
}

let offerCols = null;
async function hasOfferCols() {
  if (offerCols !== null) return offerCols;
  const [r] = await sequelize.query(
    `SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'campaigns' AND COLUMN_NAME = 'offer_text'`
  ).catch(() => [[]]);
  offerCols = r.length > 0;
  return offerCols;
}

router.get("/campaigns", auth, async (req, res) => {
  try {
    const rep = {};
    const scope = mine(req, rep);
    const offer = (await hasOfferCols()) ? ", c.offer_text, DATE_FORMAT(c.offer_ends_at, '%Y-%m-%d') AS offer_ends_at" : "";
    const [rows] = await sequelize.query(
      `SELECT c.campaign_id, c.name, c.status, c.started_at, c.replying_now ${offer},
              COUNT(*)                                                      AS my_women,
              SUM(cr.sent_at IS NOT NULL)                                    AS sent,
              SUM(cr.status = 'replied' OR cr.replied_at IS NOT NULL)        AS replied,
              SUM((cr.status = 'replied' OR cr.replied_at IS NOT NULL) AND ${LAST_DIR} = 'IN') AS needs_reply,
              SUM(l.stage = 'user' AND l.subscription_status IN ('active','frozen')) AS paying
         FROM campaign_recipients cr
         JOIN campaigns c ON c.campaign_id = cr.campaign_id
         JOIN leads l ON l.id = cr.lead_id
        WHERE ${scope}
          AND c.status IN ('queued','scheduled','running','paused','completed')
          AND (c.completed_at IS NULL OR c.completed_at >= DATE_SUB(NOW(), INTERVAL 30 DAY))
        GROUP BY c.campaign_id
        ORDER BY (c.status = 'running') DESC, needs_reply DESC, c.started_at DESC
        LIMIT 50`,
      { replacements: rep }
    );
    const n = (v) => Number(v || 0);
    res.json(rows.map((c) => ({
      campaign_id: c.campaign_id, name: c.name, status: c.status, started_at: c.started_at,
      replies_by: c.replying_now === "fiza" ? "Fizza" : c.replying_now === "rep" ? "You" : "Your setting",
      offer_text: c.offer_text || null, offer_ends_at: c.offer_ends_at || null,
      my_women: n(c.my_women), sent: n(c.sent), replied: n(c.replied), needs_reply: n(c.needs_reply), paying: n(c.paying),
    })));
  } catch (err) {
    console.error("[rep campaigns]", err);
    res.status(500).json({ error: err.message });
  }
});

router.get("/campaigns/:id/leads", auth, async (req, res) => {
  try {
    const rep = { cid: req.params.id };
    const scope = mine(req, rep);
    const filters = {
      needs_reply: `(cr.status = 'replied' OR cr.replied_at IS NOT NULL) AND ${LAST_DIR} = 'IN'`,
      replied:     `(cr.status = 'replied' OR cr.replied_at IS NOT NULL)`,
      no_reply:    `cr.sent_at IS NOT NULL AND cr.status <> 'replied' AND cr.replied_at IS NULL`,
      not_sent:    `cr.sent_at IS NULL`,
      all:         "1=1",
    };
    const f = filters[req.query.filter] ? req.query.filter : "all";
    const [rows] = await sequelize.query(
      `SELECT l.id, l.name, l.phone, l.stage, l.status, l.source, l.subscription_status, l.subscription_plan_title,
              l.interaction_status, l.main_goal, l.last_objection, l.lead_score, l.unread_count, l.last_message_at,
              cr.status AS campaign_status, cr.sent_at, cr.replied_at, cr.error_message,
              ${LAST_DIR} AS last_direction,
              (SELECT m.message FROM messages m WHERE m.lead_id = l.id AND m.direction = 'IN'
                ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_in_text
         FROM campaign_recipients cr
         JOIN leads l ON l.id = cr.lead_id
        WHERE cr.campaign_id = :cid AND ${scope} AND (${filters[f]})
        ORDER BY (${LAST_DIR} = 'IN') DESC, cr.replied_at IS NULL, l.last_message_at DESC, cr.id ASC
        LIMIT 300`,
      { replacements: rep }
    );
    res.json(rows.map((r) => ({
      ...r,
      needs_reply: r.last_direction === "IN" && (r.campaign_status === "replied" || !!r.replied_at),
      last_in_text: r.last_in_text ? String(r.last_in_text).slice(0, 140) : null,
    })));
  } catch (err) {
    console.error("[rep campaign leads]", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
