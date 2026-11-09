/**
 * repAttribution.service.js — Phase 9 (C).
 *
 * Logs a row in `rep_conversions` whenever a lead converts.
 * Called from:
 *   1. Magic-link payment OCR approval handler
 *   2. Manual admin slip-approval handler
 *   3. App webhook handler (when partner_backend confirms a subscription)
 *
 * The "rep_id" attributed is whoever was `assigned_to` on the lead at the moment
 * of conversion. This is the simplest, fairest model. Future enhancement:
 * weight attribution by who replied most in the last N messages.
 */

const sequelize = require("../config/database");
const { getLiveSessionId } = require("./repSession.service");

/**
 * recordConversion — insert a single conversion row + bump lead stage.
 *
 * @param {object} opts
 *   @param {object} opts.lead           Sequelize People row (or POJO with id, assigned_to)
 *   @param {object} opts.payment        { amount, currency, plan_name, plan_duration_months,
 *                                          source: 'magic_link'|'manual_slip'|'app_webhook'|'manual_admin' }
 *   @param {number} [opts.paymentAccountId]
 *   @param {string} [opts.notes]
 * @returns {Promise<number|null>} insertId
 */
async function recordConversion({ lead, payment = {}, paymentAccountId, notes }) {
  try {
    if (!lead || !lead.id) {
      console.warn("[RepAttribution] Skipped — no lead");
      return null;
    }

    const repId = lead.assigned_to;
    if (!repId) {
      console.warn(`[RepAttribution] Lead ${lead.id} has no assigned rep — conversion logged without attribution`);
    }

    const sessionId = repId ? getLiveSessionId(repId) : null;

    const [result] = await sequelize.query(
      `INSERT IGNORE INTO rep_conversions
         (rep_id, lead_id, plan_name, plan_duration_months, amount_paid, currency,
          payment_account_id, conversion_source, converted_at, attributed_session_id, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?)`,
      {
        replacements: [
          repId || 0,
          lead.id,
          payment.plan_name || null,
          payment.plan_duration_months || null,
          payment.amount || null,
          payment.currency || "PKR",
          paymentAccountId || null,
          payment.source || "manual_admin",
          sessionId || null,
          notes || null,
        ],
      }
    );

    const insertId = require("../utils/insertId").insertIdOf(result);
    console.log(
      `💰 [RepAttribution] Conversion #${insertId} — lead ${lead.id} → rep ${repId || "unassigned"} ` +
      `${payment.amount || "?"} ${payment.currency || "PKR"} (${payment.source})`
    );

    // Update lead stage
    if (lead.update) {
      await lead.update({ stage: "user" });
    } else {
      await sequelize.query("UPDATE leads SET stage='user' WHERE id = ?", { replacements: [lead.id] });
    }

    return insertId;
  } catch (err) {
    console.error("[RepAttribution] recordConversion failed:", err.message);
    return null;
  }
}

/**
 * Bulk recompute attribution for a date range — used when admin wants
 * to backfill / fix conversion counts after a data correction.
 */
async function recomputeAttribution({ fromDate, toDate, repId }) {
  // Future hook — for now just return count
  const [rows] = await sequelize.query(
    `SELECT COUNT(*) AS c FROM rep_conversions
       WHERE converted_at BETWEEN ? AND ?
       ${repId ? "AND rep_id = " + Number(repId) : ""}`,
    { replacements: [fromDate, toDate] }
  );
  return rows[0]?.c || 0;
}

module.exports = { recordConversion, recomputeAttribution, reverseConversion };

/**
 * reverseConversion — mark a conversion row as reversed when a subscription
 * is frozen, cancelled or expired before its term.
 *
 * Soft-reverse: sets `reversed_at` and `reverse_reason` on the LATEST
 * un-reversed conversion for the lead, so historical data stays intact.
 * Idempotent: does nothing if already reversed.
 *
 * @param {number} leadId
 * @param {string} reason  e.g. "subscription_frozen", "subscription_expired"
 * @returns {Promise<boolean>} true if a row was reversed
 */
async function reverseConversion(leadId, reason) {
  try {
    const [result] = await sequelize.query(
      `UPDATE rep_conversions
          SET reversed_at = NOW(),
              reverse_reason = :reason
        WHERE lead_id = :leadId
          AND reversed_at IS NULL
        ORDER BY converted_at DESC
        LIMIT 1`,
      { replacements: { leadId, reason } }
    );
    const affected = result?.affectedRows ?? result ?? 0;
    if (affected > 0) {
      console.log(`[RepAttribution] Reversed conversion for lead ${leadId}: ${reason}`);
    }
    return affected > 0;
  } catch (e) {
    console.error(`[RepAttribution] reverseConversion failed for lead ${leadId}:`, e.message);
    return false;
  }
}

