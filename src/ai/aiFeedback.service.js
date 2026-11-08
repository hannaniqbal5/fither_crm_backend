/**
 * aiFeedback.service.js — Phase 11.
 *
 * Fetches "promoted" rep edits to use as few-shot examples in Fiza's prompt.
 *
 * Selection logic:
 *   1. Prefer exact match on (interaction_status, main_goal)
 *   2. Fall back to interaction_status alone
 *   3. Fall back to main_goal alone
 *   4. Then any recent promoted edit
 *
 * Cached in memory for 5 min so we don't hit DB on every reply.
 */

const sequelize = require("../config/database");

let cache = null;
let cacheTs = 0;
const CACHE_MS = 5 * 60 * 1000;

async function loadAllPromoted() {
  if (cache && Date.now() - cacheTs < CACHE_MS) return cache;
  try {
    const [rows] = await sequelize.query(
      `SELECT correction_id, interaction_status, main_goal, last_objection,
              user_message, original_reply, corrected_reply, promoted_at
         FROM ai_corrections
         WHERE promoted = 1 AND dismissed = 0
         ORDER BY promoted_at DESC
         LIMIT 200`
    );
    cache = rows;
    cacheTs = Date.now();
    return cache;
  } catch (err) {
    console.error("[aiFeedback] loadAllPromoted failed:", err.message);
    return [];
  }
}

function invalidateCache() {
  cache = null;
  cacheTs = 0;
}

/**
 * getExamples — pick up to N relevant few-shot examples.
 *
 * @param {object} ctx { interaction_status, main_goal, last_objection }
 * @param {number} [limit=3]
 * @returns {Promise<Array<{user_message, corrected_reply, ai_response}>>}
 */
async function getExamples(ctx = {}, limit = 3) {
  const all = await loadAllPromoted();
  if (!all.length) return [];

  const { interaction_status, main_goal } = ctx;

  // Rank: 3 = both match, 2 = status match, 1 = goal match, 0 = neither
  const scored = all.map(r => {
    let score = 0;
    if (interaction_status && r.interaction_status === interaction_status) score += 2;
    if (main_goal && r.main_goal === main_goal) score += 1;
    return { ...r, _rank: score };
  });
  scored.sort((a, b) => b._rank - a._rank);

  // Always take the top N, even if score is 0 (provides general voice/tone guidance)
  return scored.slice(0, limit).map(r => ({
    user_message: r.user_message,
    rep_reply: r.corrected_reply,
    ai_draft:  r.original_reply,
    matched_on: r._rank === 3 ? "status+goal" : r._rank === 2 ? "status" : r._rank === 1 ? "goal" : "general",
  }));
}

module.exports = { getExamples, invalidateCache };
