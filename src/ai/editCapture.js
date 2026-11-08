/**
 * editCapture.js - Phase 11 helper.
 *
 * One-stop function called from /approve and /reject endpoints to:
 *   1. Compute edit distance between original AI draft and the rep's final text
 *   2. Snapshot lead context (interaction_status, main_goal, last_objection)
 *   3. Write a row to ai_reply_decisions (always)
 *   4. Write a row to ai_corrections (only for edits/rejects with content)
 *   5. Bump category_metrics decision counters (Layer 5 only)
 *
 * Safe to call from anywhere - swallows its own errors.
 */

const sequelize = require("../config/database");
const { v4: uuidv4 } = require("uuid");

/**
 * Cheap normalized Levenshtein 0..1.
 * Good enough for "how much did the rep change it" signal.
 */
function editDistance(a, b) {
  a = (a || "").trim();
  b = (b || "").trim();
  if (a === b) return 0;
  if (!a || !b) return 1;

  const m = a.length, n = b.length;
  let prev = new Array(n + 1);
  let cur  = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  const dist = prev[n];
  return Math.min(1, dist / Math.max(m, n));
}

function templateKeyFromUserMessage(userMessage) {
  // Layer 5 follow-up drafts encode the template as `[layer5_followup:<key>]`
  if (!userMessage || typeof userMessage !== "string") return null;
  const m = userMessage.match(/\[layer5_followup:([^\]]+)\]/);
  return m ? m[1] : null;
}

/**
 * captureDecision - the one function endpoints call.
 *
 * @param {object} args
 *   @param {string} args.replyId
 *   @param {object} args.draft   ai_replies row (already loaded)
 *   @param {string} args.decision   'approved' | 'edited' | 'rejected'
 *   @param {string} [args.finalText] for 'edited'
 *   @param {string} [args.rejectReason] for 'rejected'
 *   @param {number} args.repId
 *   @param {object} [args.leadContext] { interaction_status, main_goal, last_objection }
 */
async function captureDecision({
  replyId, draft, decision, finalText, rejectReason, repId, leadContext = {},
}) {
  try {
    const original = draft.ai_response || "";
    const edited   = decision === "edited" ? (finalText || "") : null;
    const dist     = decision === "edited" ? editDistance(original, edited) : 0;
    const tplKey   = templateKeyFromUserMessage(draft.user_message);

    // 1) ai_reply_decisions - always
    await sequelize.query(
      `INSERT INTO ai_reply_decisions
         (reply_id, lead_id, rep_id, decision, template_key,
          interaction_status, main_goal, last_objection, edit_distance)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      {
        replacements: [
          replyId, draft.lead_id || draft.leadId, repId, decision, tplKey,
          leadContext.interaction_status || null,
          leadContext.main_goal || null,
          leadContext.last_objection || null,
          dist,
        ],
      }
    );

    // 2) ai_corrections - only if edited or rejected with non-empty alt
    if (decision === "edited" && edited && edited !== original) {
      await sequelize.query(
        `INSERT INTO ai_corrections
           (correction_id, reply_id, rep_id, original_reply, corrected_reply,
            interaction_status, main_goal, last_objection,
            user_message, edit_distance, edit_action)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'edited')`,
        {
          replacements: [
            uuidv4(), replyId, repId, original, edited,
            leadContext.interaction_status || null,
            leadContext.main_goal || null,
            leadContext.last_objection || null,
            draft.user_message || null,
            dist,
          ],
        }
      );
    } else if (decision === "rejected") {
      await sequelize.query(
        `INSERT INTO ai_corrections
           (correction_id, reply_id, rep_id, original_reply, corrected_reply,
            interaction_status, main_goal, last_objection,
            user_message, edit_distance, edit_action, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'rejected', ?)`,
        {
          replacements: [
            uuidv4(), replyId, repId, original, "",
            leadContext.interaction_status || null,
            leadContext.main_goal || null,
            leadContext.last_objection || null,
            draft.user_message || null,
            rejectReason || null,
          ],
        }
      );
    }

    // 3) category_metrics - bump per-template DECISION counter (Layer 5 only)
    //
    // CONTRACT: this file ONLY writes to approved_count / edited_count /
    // rejected_count. It NEVER bumps total_fires - that counter is owned
    // by followupEngine.incrementCategoryMetric at draft-create time.
    // If we touched total_fires here we'd double-count fires.
    //
    // The INSERT path is for the rare edge case where a fire happened
    // close to midnight and the rep's decision lands on the next calendar
    // day - we still need a row for today, so we insert one with
    // total_fires=0 and the decision counter=1.
    if (tplKey) {
      const field =
        decision === "approved" ? "approved_count" :
        decision === "edited"   ? "edited_count"   :
        decision === "rejected" ? "rejected_count" : null;
      if (field) {
        await sequelize.query(
          `INSERT INTO category_metrics (template_key, metric_date, total_fires, ${field})
             VALUES (?, CURDATE(), 0, 1)
             ON DUPLICATE KEY UPDATE ${field} = ${field} + 1`,
          { replacements: [tplKey] }
        );
      }
    }

  } catch (err) {
    console.error("[editCapture] suppressed:", err.message);
  }
}

module.exports = { captureDecision, editDistance, templateKeyFromUserMessage };
