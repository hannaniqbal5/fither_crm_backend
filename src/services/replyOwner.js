/**
 * replyOwner.js — THE ONE PLACE THAT ANSWERS "WHO REPLIES TO HER RIGHT NOW?"
 *
 * WHY THIS EXISTS
 *   Fourteen things used to decide it: assigned_to, owner_type, owner_reason,
 *   is_escalated, escalated_to, escalated_at, fizza_handled,
 *   auto_followup_paused, phone_requested_at, rep_tasks rows, three env
 *   switches (AI_COPILOT_MODE, AI_SILENT_ESCALATIONS, automation_sends_paused)
 *   and a per-campaign fizza_auto_reply. Nobody could say whether Fizza or a
 *   human was answering a given woman without reading six of them, which is
 *   why it felt unmanageable.
 *
 *   Now one function answers it, and the answer is one of two words.
 *
 * THE RULE, IN ORDER. First match wins.
 *
 *   1. She asked for a human, or Fizza flagged something sensitive
 *        → REP. Not overridable: it's a promise we made to her.
 *   2. An admin took over this chat          (leads.replying_now)
 *        → whatever they chose.
 *   3. A rep replied in the last 24 hours
 *        → REP. She is mid-conversation with a person; Fizza stays out.
 *   4. This campaign has a setting           (campaigns.replying_now)
 *        → whatever it says.
 *   5. The assigned rep's mode               (sales_reps.fiza_mode)
 *        → 'autopilot' = fiza, 'copilot' = rep. A money-moment tag
 *          (ready_to_pay / human_requested) still overrides autopilot → rep.
 *   6. The channel default                   (layer_system_settings)
 *        → 'fiza' in the app, 'rep' on WhatsApp today.
 *
 *   Separate from assigned_to on purpose. WHO IS ACCOUNTABLE for her (one rep,
 *   for credit and for whose inbox she's in) and WHO IS REPLYING this minute
 *   are different facts. Mixing them is what made owner_type confusing.
 *
 * NEVER THROWS. On any error it returns 'rep', because a human reading a
 * message she didn't need is harmless, and Fizza sending one she shouldn't
 * is not.
 */

const sequelize = require("../config/database");

const COACH_ACTIVE_HOURS = Number(process.env.COACH_ACTIVE_HOURS || 24);

// Escalation tags where Fizza must go quiet and a person must answer.
function silentEscalations() {
  return new Set(
    (process.env.AI_SILENT_ESCALATIONS || "mental_health,medical,complaint")
      .split(",").map((x) => x.trim()).filter(Boolean)
  );
}

// Money-moment tags. A LOCKED guardrail: whatever would otherwise let Fizza
// send on her own (rep autopilot, a campaign set to Auto, a channel default of
// 'fiza'), she does not close a sale or brush off a human request unsupervised
// — these go to the rep as a draft + notification. An admin who explicitly
// took over a single chat (step 2) is still obeyed.
function moneyMomentEscalations() {
  return new Set(
    (process.env.AI_MONEY_ESCALATIONS || "ready_to_pay,human_requested")
      .split(",").map((x) => x.trim()).filter(Boolean)
  );
}

// Channel defaults, cached briefly so this isn't a DB hit per message.
let _cache = { t: 0, vals: null };
async function defaults() {
  if (_cache.vals && Date.now() - _cache.t < 60 * 1000) return _cache.vals;
  const vals = { default_replier: "rep", default_replier_app: "fiza" };
  try {
    const [rows] = await sequelize.query(
      `SELECT setting_key, setting_value FROM layer_system_settings
        WHERE setting_key IN ('default_replier', 'default_replier_app')`
    );
    for (const r of rows) {
      if (r.setting_key in vals && ["fiza", "rep"].includes(r.setting_value)) {
        vals[r.setting_key] = r.setting_value;
      }
    }
  } catch (e) {
    console.warn("[replyOwner] settings load failed, using defaults:", e.message);
  }
  _cache = { t: Date.now(), vals };
  return vals;
}
function clearCache() { _cache = { t: 0, vals: null }; }

/**
 * whoReplies — the whole decision.
 *
 * @param {object} lead                   needs id; uses replying_now, channel info
 * @param {object} opts
 * @param {string} [opts.channel]         "whatsapp" | "instagram" | "facebook" | "app"
 * @param {string} [opts.escalate]        the tag reply.service returned, if any
 * @param {boolean} [opts.askedForHuman]  she typed "talk to a coach" or tapped it
 * @returns {Promise<{who: "fiza"|"rep", why: string}>}
 */
async function whoReplies(lead, { channel = "whatsapp", escalate = null, askedForHuman = false } = {}) {
  try {
    if (!lead || !lead.id) return { who: "rep", why: "no_lead" };

    // 1. A promise to her outranks every setting.
    if (askedForHuman) return { who: "rep", why: "she_asked_for_a_human" };
    if (escalate && silentEscalations().has(escalate)) {
      return { who: "rep", why: `fizza_flagged_${escalate}` };
    }

    // 2. An admin took this chat over (or handed it back).
    const row = await leadRow(lead);
    if (row && (row.replying_now === "fiza" || row.replying_now === "rep")) {
      return { who: row.replying_now, why: "admin_set_on_this_chat" };
    }
    // Legacy flag, still honoured so nothing changes before the data is moved.
    if (row && row.fizza_handled) return { who: "fiza", why: "legacy_fizza_handled" };

    // 3. A person is already talking to her.
    if (await repRepliedRecently(lead.id)) {
      return { who: "rep", why: `rep_replied_within_${COACH_ACTIVE_HOURS}h` };
    }

    // 4. The campaign she's replying to.
    const campaign = await campaignSetting(lead.id);
    if (campaign) return guardMoneyMoment({ who: campaign.who, why: campaign.why }, escalate);

    // 5. The assigned rep's own mode, set by the admin (migration 040).
    //    'autopilot' → Fizza answers this rep's routine traffic on her own;
    //    'copilot'   → Fizza drafts, the rep approves;
    //    null / no rep / column missing → fall through to the channel default.
    //    This sits BELOW the locked guardrails above, so autopilot can never
    //    reach a sensitive topic (step 1) or talk over a live rep (step 3).
    // The in-app chat is Fizza-first by design (a woman in the app gets an
    // answer at once), so a rep's level applies to WhatsApp / Instagram /
    // Facebook only. An admin's takeover, a live rep conversation, a campaign
    // setting and every guardrail above still apply in the app.
    const repMode = channel === "app" ? null : await assignedRepMode(lead);
    if (repMode === "autopilot") {
      // Money-moment guardrail: autopilot still can't close a sale or ignore a
      // "talk to a human" unsupervised — hand those to a person.
      if (escalate && moneyMomentEscalations().has(escalate)) {
        return { who: "rep", why: `autopilot_money_moment_${escalate}` };
      }
      return { who: "fiza", why: "rep_on_autopilot" };
    }
    if (repMode === "copilot") {
      return { who: "rep", why: "rep_on_copilot" };
    }

    // 6. The channel default.
    const d = await defaults();
    const who = channel === "app" ? d.default_replier_app : d.default_replier;
    return guardMoneyMoment({ who, why: `default_for_${channel}` }, escalate);
  } catch (e) {
    console.error("[replyOwner] failed, handing to a rep:", e.message);
    return { who: "rep", why: "error" };
  }
}

/**
 * guardMoneyMoment — a 'fiza' answer becomes 'rep' when she just said she wants
 * to pay or asked for a person. Any other answer passes through unchanged.
 */
function guardMoneyMoment(result, escalate) {
  if (result && result.who === "fiza" && escalate && moneyMomentEscalations().has(escalate)) {
    return { who: "rep", why: `money_moment_${escalate}_over_${result.why}` };
  }
  return result;
}

async function leadRow(lead) {
  // The caller may already hold the columns; only query when it doesn't.
  if (lead && ("replying_now" in lead || "fizza_handled" in lead)) {
    return { replying_now: lead.replying_now ?? null, fizza_handled: lead.fizza_handled ?? 0 };
  }
  try {
    const [rows] = await sequelize.query(
      "SELECT replying_now, fizza_handled FROM leads WHERE id = :id LIMIT 1",
      { replacements: { id: lead.id } }
    );
    return rows[0] || null;
  } catch (e) {
    // Migration 039 not run, or fizza_handled never added. Fall through.
    try {
      const [rows] = await sequelize.query(
        "SELECT fizza_handled FROM leads WHERE id = :id LIMIT 1",
        { replacements: { id: lead.id } }
      );
      return rows[0] ? { replying_now: null, fizza_handled: rows[0].fizza_handled } : null;
    } catch { return null; }
  }
}

/**
 * assignedRepMode — the Fiza mode of the rep this lead is assigned to.
 * Joins leads -> sales_reps so it works whether or not the caller passed the
 * rep in. Returns "autopilot" | "copilot" | null. NEVER throws: on any error
 * (including the column not existing before migration 040 is run) it returns
 * null, so the decision safely falls through to the channel default.
 */
async function assignedRepMode(lead) {
  try {
    if (!lead || !lead.id) return null;
    const [rows] = await sequelize.query(
      `SELECT sr.fiza_mode AS mode
         FROM leads l
         JOIN sales_reps sr ON sr.id = l.assigned_to
        WHERE l.id = :id
        LIMIT 1`,
      { replacements: { id: lead.id } }
    );
    const mode = rows[0]?.mode;
    return mode === "autopilot" || mode === "copilot" ? mode : null;
  } catch (e) {
    // Column missing (migration 040 not run) or any other DB error: inherit
    // the channel default rather than guessing.
    return null;
  }
}

async function repRepliedRecently(leadId) {
  try {
    const [rows] = await sequelize.query(
      `SELECT 1 FROM messages
        WHERE lead_id = :id AND direction = 'OUT' AND \`from\` = 'rep'
          AND created_at > NOW() - INTERVAL :hrs HOUR
        LIMIT 1`,
      { replacements: { id: leadId, hrs: COACH_ACTIVE_HOURS } }
    );
    return rows.length > 0;
  } catch { return false; }
}

async function campaignSetting(leadId) {
  try {
    const [rows] = await sequelize.query(
      `SELECT c.replying_now, c.fizza_auto_reply
         FROM campaign_recipients cr
         JOIN campaigns c ON c.campaign_id = cr.campaign_id
        WHERE cr.lead_id = :id
          AND cr.status IN ('sent','delivered','read','replied')
          AND c.status IN ('running','completed','paused')
        ORDER BY cr.id DESC
        LIMIT 1`,
      { replacements: { id: leadId } }
    );
    const c = rows[0];
    if (!c) return null;
    if (c.replying_now === "fiza" || c.replying_now === "rep") {
      return { who: c.replying_now, why: "campaign_setting" };
    }
    if (c.fizza_auto_reply) return { who: "fiza", why: "legacy_campaign_auto_reply" };
    return null;
  } catch {
    // Migration 039 not run yet: fall back to the legacy flag alone.
    try {
      const [rows] = await sequelize.query(
        `SELECT 1 FROM campaign_recipients cr
           JOIN campaigns c ON c.campaign_id = cr.campaign_id
          WHERE cr.lead_id = :id
            AND cr.status IN ('sent','delivered','read','replied')
            AND c.fizza_auto_reply = 1
            AND c.status IN ('running','completed','paused')
          LIMIT 1`,
        { replacements: { id: leadId } }
      );
      return rows.length ? { who: "fiza", why: "legacy_campaign_auto_reply" } : null;
    } catch { return null; }
  }
}

/**
 * setForChat — an admin takes this chat over, or hands it back to Fizza.
 * @param {number} leadId
 * @param {"fiza"|"rep"|null} who   null clears the override (back to the default)
 * @param {number} [byRepId]
 */
async function setForChat(leadId, who, byRepId = null) {
  if (who !== null && who !== "fiza" && who !== "rep") {
    throw new Error(`replying_now must be fiza, rep or null — got ${who}`);
  }
  try {
    await sequelize.query(
      `UPDATE leads
          SET replying_now = :who,
              replying_now_by = :by,
              replying_now_at = NOW()
        WHERE id = :id`,
      { replacements: { id: leadId, who, by: who ? byRepId : null } }
    );
  } catch (e) {
    // A write must NOT fail quietly — if the column isn't there the admin
    // would think they took the chat over when nothing happened. Say so.
    if (/replying_now/i.test(String(e.message || ""))) {
      throw Object.assign(
        new Error("Run migration 039 first — leads.replying_now doesn't exist yet"),
        { status: 503 }
      );
    }
    throw e;
  }
  // Taking over clears the legacy flag, so the two can't disagree.
  if (who === "rep") {
    await sequelize
      .query("UPDATE leads SET fizza_handled = 0 WHERE id = :id", { replacements: { id: leadId } })
      .catch(() => {});
  }
  return { leadId, replying_now: who };
}

module.exports = { whoReplies, setForChat, defaults, clearCache, COACH_ACTIVE_HOURS, silentEscalations, moneyMomentEscalations };
