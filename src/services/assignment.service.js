
const { AssignmentState, SalesRep, sequelize } = require("../../models");

/**
 * Round-robin the next active sales rep — scoped to a WhatsApp account.
 *
 * Each WhatsApp account keeps its OWN pointer row in assignment_state, and
 * only reps belonging to that account are eligible. This is what makes
 * multi-account work: a lead that messages in on account B is only ever
 * handed to a rep on account B (otherwise the rep's account-filtered inbox
 * would never show the lead, and replies would go out from the wrong number).
 *
 * @param {number|null} accountId  WhatsApp account the inbound arrived on.
 *                                  null → legacy/global pointer (single-account installs).
 * @returns {Promise<SalesRep|null>}  null when there are no active reps for the account.
 */
async function getNextRepRoundRobin(accountId = null) {
  return await sequelize.transaction(async (t) => {
    // Per-account pointer row (lock for the duration of the advance).
    let state = await AssignmentState.findOne({
      where: { whatsapp_account_id: accountId },
      lock: t.LOCK.UPDATE,
      transaction: t,
    });

    if (!state) {
      state = await AssignmentState.create(
        { whatsapp_account_id: accountId, last_rep_id: null },
        { transaction: t }
      );
      console.log(`🆕 AssignmentState created for account ${accountId}`);
    }

    // Only reps on this account are eligible (when an account is given).
    const where = { status: "active" };
    if (accountId != null) where.whatsapp_account_id = accountId;

    const reps = await SalesRep.findAll({
      where,
      order: [["id", "ASC"]],
      transaction: t,
    });

    console.log(`👥 [acct ${accountId}] Active reps:`, reps.map((r) => r.id));
    console.log("🔁 Last rep used:", state.last_rep_id);

    if (!reps.length) return null;

    let nextRep;
    if (!state.last_rep_id) {
      nextRep = reps[0];
    } else {
      const index = reps.findIndex((r) => r.id === state.last_rep_id);
      // index === -1 (last rep no longer active/on this account) → start over
      nextRep = reps[(index + 1) % reps.length];
    }

    state.last_rep_id = nextRep.id;
    await state.save({ transaction: t });

    console.log(`✅ [acct ${accountId}] Assigned next rep:`, nextRep.id);
    console.log("--------------------------------");

    return nextRep;
  });
}

module.exports = { getNextRepRoundRobin };
