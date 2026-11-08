/**
 * search.routes.js — Phase 13. Universal search across leads + messages.
 *
 *   GET /api/search?q=<query>&limit=20
 *
 * Strategy:
 *   1. Identity match on leads (name LIKE, phone LIKE, email LIKE, IG username, FB name)
 *   2. Intent match (interaction_status, main_goal — exact tokens)
 *   3. FULLTEXT match on message body — returns the matching lead(s) + snippet
 *   4. Dedupe by lead_id, rank: identity > intent > message
 *   5. Filter to leads assigned to current rep (admin sees all)
 *
 * Returns up to `limit` rows with shape:
 *   { lead_id, name, phone, channel, stage, lead_score,
 *     interaction_status, main_goal,
 *     matched_via, snippet }
 */

const express = require("express");
const router  = express.Router();
const auth    = require("../middleware/auth.middleware");
const sequelize = require("../config/database");

// Map of "intent words" the rep might type, e.g. "pcos" → main_goal = pcos
const INTENT_KEYWORDS = {
  pcos: { col: "main_goal", val: "pcos" },
  pcod: { col: "main_goal", val: "pcos" },
  weight: { col: "main_goal", val: "weight_loss" },
  postpartum: { col: "main_goal", val: "postpartum" },
  diabetes: { col: "main_goal", val: "diabetes" },
  hot: { col: "lead_score", op: ">=", val: 100 },
  ghosted: { col: "interaction_status", val: "ghosted" },
  paying: { col: "interaction_status", val: "ready_to_pay" },
  pending: { col: "interaction_status", val: "payment_pending" },
};

function escapeLike(s) {
  return (s || "").replace(/[%_]/g, m => "\\" + m);
}

function snippet(body, query, max = 120) {
  if (!body) return "";
  const idx = body.toLowerCase().indexOf((query || "").toLowerCase());
  if (idx < 0) return body.slice(0, max);
  const start = Math.max(0, idx - 30);
  const end   = Math.min(body.length, idx + query.length + 50);
  return (start > 0 ? "…" : "") + body.slice(start, end) + (end < body.length ? "…" : "");
}

router.get("/", auth, async (req, res) => {
  try {
    const qRaw = String(req.query.q || "").trim();
    if (qRaw.length < 2) return res.json({ rows: [] });

    const limit = Math.min(parseInt(req.query.limit || "20", 10), 50);
    const isAdmin = req.user?.role === "admin";
    const repId   = req.user?.repId;

    const repFilter = isAdmin ? "" : "AND assigned_to = :repId";

    // ── 1. Identity match (name / phone / email / IG / FB) ──────
    const likeQ = `%${escapeLike(qRaw)}%`;
    const [identityHits] = await sequelize.query(
      `SELECT id AS lead_id, name, phone, source AS channel, stage, lead_score,
              interaction_status, main_goal, last_objection,
              'identity' AS matched_via, NULL AS snippet
         FROM leads
         WHERE (name LIKE :likeQ OR phone LIKE :likeQ OR email LIKE :likeQ
                OR instagram_username LIKE :likeQ OR facebook_name LIKE :likeQ)
           ${repFilter}
         ORDER BY lead_score DESC, last_message_at DESC
         LIMIT :limit`,
      { replacements: { likeQ, repId, limit } }
    );

    // ── 2. Intent keyword match ─────────────────────────────────
    let intentHits = [];
    const ikey = qRaw.toLowerCase();
    const rule = INTENT_KEYWORDS[ikey];
    if (rule) {
      const where = rule.op === ">="
        ? `${rule.col} >= ${Number(rule.val)}`
        : `${rule.col} = :rval`;
      const [rows] = await sequelize.query(
        `SELECT id AS lead_id, name, phone, source AS channel, stage, lead_score,
                interaction_status, main_goal, last_objection,
                'intent' AS matched_via, NULL AS snippet
           FROM leads
           WHERE ${where}
             ${repFilter}
           ORDER BY lead_score DESC
           LIMIT :limit`,
        { replacements: { rval: rule.val, repId, limit } }
      );
      intentHits = rows;
    }

    // ── 3. Full-text on message body ────────────────────────────
    const ftQuery = qRaw.split(/\s+/).filter(Boolean).map(t => `+${t}*`).join(" ");
    const [msgHits] = await sequelize.query(
      `SELECT l.id AS lead_id, l.name, l.phone, l.source AS channel, l.stage, l.lead_score,
              l.interaction_status, l.main_goal, l.last_objection,
              'message' AS matched_via, m.message AS msg_body
         FROM messages m
         JOIN leads l ON l.id = m.lead_id
         WHERE MATCH(m.message) AGAINST (:ft IN BOOLEAN MODE)
           ${isAdmin ? "" : "AND l.assigned_to = :repId"}
         ORDER BY m.created_at DESC
         LIMIT :limit`,
      { replacements: { ft: ftQuery, repId, limit } }
    );
    const msgWithSnippets = msgHits.map(r => ({
      ...r,
      snippet: snippet(r.msg_body, qRaw),
      msg_body: undefined,
    }));

    // ── Merge + dedupe ──────────────────────────────────────────
    const seen = new Set();
    const out  = [];
    for (const list of [identityHits, intentHits, msgWithSnippets]) {
      for (const row of list) {
        if (seen.has(row.lead_id)) continue;
        seen.add(row.lead_id);
        out.push(row);
        if (out.length >= limit) break;
      }
      if (out.length >= limit) break;
    }

    res.json({ rows: out, query: qRaw });
  } catch (err) {
    console.error("[search] error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
