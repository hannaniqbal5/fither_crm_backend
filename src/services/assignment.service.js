/**
 * assignment.service.js — who gets a new lead. The ONE rule for every door
 * (WhatsApp, Instagram/Facebook, app signup, Start chat, number uploads,
 * handoffs from Fiza), set by the admin in Team → "New leads go to".
 *
 *   assign_mode = 'single'       → every new lead to assign_single_rep_id
 *   assign_mode = 'round_robin'  → turn by turn among reps in the rotation
 *                                  (sales_reps.in_rotation = 1, migration 043)
 *
 * Always: only active reps with role 'rep' (admins never get leads), and
 * when a WhatsApp number is given, only reps on that number, because a rep's
 * inbox shows only her number and replies go out from it. So in 'single'
 * mode a woman who writes to ANOTHER number still goes to that number's
 * rotation (the single rep couldn't see or answer her).
 *
 * accountId null (an app signup that hasn't written on WhatsApp yet) → any
 * number; the caller puts her on the chosen rep's number.
 */
const { AssignmentState, SalesRep, sequelize } = require("../../models");

let hasRotationColumn = null; // migration 043 run?

async function settings() {
  try {
    const [rows] = await sequelize.query(
      "SELECT setting_key, setting_value FROM layer_system_settings WHERE setting_key IN ('assign_mode','assign_single_rep_id')"
    );
    const m = Object.fromEntries(rows.map((r) => [r.setting_key, r.setting_value]));
    return { mode: m.assign_mode === "single" ? "single" : "round_robin", singleRepId: parseInt(m.assign_single_rep_id, 10) || null };
  } catch (_) {
    return { mode: "round_robin", singleRepId: null };
  }
}

/** Reps who may get new leads on this number (or any number when null). */
async function eligibleReps(accountId, t) {
  const repl = { acc: accountId };
  const accSql = accountId != null ? "AND whatsapp_account_id = :acc" : "";
  if (hasRotationColumn !== false) {
    try {
      const [rows] = await sequelize.query(
        `SELECT id, name, whatsapp_account_id FROM sales_reps
          WHERE status = 'active' AND role = 'rep' AND in_rotation = 1 ${accSql}
          ORDER BY id ASC`,
        { replacements: repl, transaction: t }
      );
      hasRotationColumn = true;
      return rows;
    } catch (e) {
      if (!/in_rotation/.test(e.message)) throw e;
      hasRotationColumn = false;
      console.warn("[assignment] sales_reps.in_rotation missing — run migration 043. Using all active reps.");
    }
  }
  const [rows] = await sequelize.query(
    `SELECT id, name, whatsapp_account_id FROM sales_reps
      WHERE status = 'active' AND role = 'rep' ${accSql} ORDER BY id ASC`,
    { replacements: repl, transaction: t }
  );
  return rows;
}

/**
 * The rep for the next new lead. Name kept for the existing callers.
 * @param {number|null} accountId  WhatsApp number she arrived on; null = any.
 * @returns {Promise<SalesRep|null>} null when nobody can take her (Fiza holds her).
 */
async function getNextRepRoundRobin(accountId = null) {
  const cfg = await settings();

  if (cfg.mode === "single" && cfg.singleRepId) {
    const [[rep]] = await sequelize.query(
      "SELECT id, whatsapp_account_id FROM sales_reps WHERE id = :id AND status = 'active' AND role = 'rep'",
      { replacements: { id: cfg.singleRepId } }
    );
    if (rep && (accountId == null || Number(rep.whatsapp_account_id) === Number(accountId))) {
      return SalesRep.findByPk(rep.id);
    }
    if (!rep) console.warn(`[assignment] single-rep mode, but rep ${cfg.singleRepId} is not an active rep — using the rotation`);
  }

  const picked = await sequelize.transaction(async (t) => {
    let state = await AssignmentState.findOne({ where: { whatsapp_account_id: accountId }, lock: t.LOCK.UPDATE, transaction: t });
    if (!state) state = await AssignmentState.create({ whatsapp_account_id: accountId, last_rep_id: null }, { transaction: t });

    const reps = await eligibleReps(accountId, t);
    if (!reps.length) {
      console.warn(`[assignment] no rep in the rotation${accountId != null ? ` on number ${accountId}` : ""} — lead left for Fiza`);
      return null;
    }
    const i = state.last_rep_id ? reps.findIndex((r) => r.id === state.last_rep_id) : -1;
    const next = reps[(i + 1) % reps.length]; // -1 (left the rotation) → start over
    state.last_rep_id = next.id;
    await state.save({ transaction: t });
    return next.id;
  });
  return picked ? SalesRep.findByPk(picked) : null;
}

module.exports = { getNextRepRoundRobin, settings };
