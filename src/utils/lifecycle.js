/**
 * lifecycle.js — single unified lifecycle label for a lead.
 *
 * Combines stage + status + subscription_status into one human-readable label
 * that the dashboard and CRM→App API use. This is a COMPUTED value, not stored
 * in the DB — it's derived from the existing fields on every read.
 *
 * Lifecycle values (ordered by progression):
 *   visitor        — came in, no meaningful interaction yet
 *   engaged        — actively chatting, asking about programs
 *   trial          — on a free trial in the app
 *   negotiating    — price/timing/family objection, still in the funnel
 *   ready_to_pay   — payment link sent or ready
 *   paying         — active subscription
 *   frozen         — subscription paused
 *   churned        — subscription expired / cancelled / lost
 *   lost           — marked lost by rep (never converted)
 *   opted_out      — DNC / opted out
 */

/**
 * Compute the lifecycle label from a lead row (plain object or Sequelize instance).
 * @param {object} lead — must have: stage, status, subscription_status, interaction_status, is_dnc/opted_out
 * @returns {string} one of the lifecycle values above
 */
function computeLifecycle(lead) {
  if (!lead) return "unknown";

  const stage = lead.stage || "visitor";
  const status = lead.status || "new";
  const subStatus = lead.subscription_status || "none";
  const intent = lead.interaction_status || "";
  const isDnc = lead.is_dnc || lead.opted_out || intent === "opted_out";

  // DNC / opted out overrides everything
  if (isDnc) return "opted_out";

  // Paying customer states
  if (subStatus === "active") return "paying";
  if (subStatus === "frozen") return "frozen";
  if (subStatus === "trial") return "trial";

  // Churned (was paying, now expired/cancelled)
  if (stage === "churned" || subStatus === "expired" || subStatus === "cancelled") return "churned";

  // Rep marked as lost
  if (status === "lost" || intent === "not_interested" || intent === "lost_to_competitor") return "lost";

  // Converted but sub status not active (edge case — just paid)
  if (status === "converted" || stage === "user") return "paying";

  // Active sales funnel positions
  if (intent === "ready_to_pay" || intent === "payment_link_sent" || intent === "payment_pending") return "ready_to_pay";
  if (intent === "price_negotiation" || intent === "price_objection" || intent === "timing_objection"
      || intent === "medical_concern" || intent === "husband_blocking" || intent === "will_start_later"
      || intent === "discussing_with_family" || intent === "requesting_trial") return "negotiating";
  if (intent === "asking_about_program" || intent === "asking_about_price" || intent === "comparing_plans"
      || intent === "active_chat" || status === "interested" || status === "followup") return "engaged";

  // Default
  return "visitor";
}

/**
 * Add lifecycle to a plain lead object (mutates and returns it).
 */
function withLifecycle(lead) {
  if (!lead) return lead;
  lead.lifecycle = computeLifecycle(lead);
  return lead;
}

/**
 * Add lifecycle to an array of lead objects.
 */
function withLifecycleAll(leads) {
  if (!Array.isArray(leads)) return leads;
  return leads.map(withLifecycle);
}

module.exports = { computeLifecycle, withLifecycle, withLifecycleAll };
