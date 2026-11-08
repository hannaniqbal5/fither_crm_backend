/**
 * statusMap.js - bridges the new Layer System `interaction_status`
 * (24-value taxonomy) with the legacy `status` field (5 values:
 * new | interested | followup | converted | lost) that drives the
 * sidebar filter pills in SalesRepDashboard.
 *
 * Why: the dashboard's New / Interested / Converted / Lost filters
 * read `lead.status`. Without this map, every lead is frozen at
 * "new" forever no matter what the customer says.
 *
 * Rules:
 *   - Only auto-sync when the lead isn't manually marked "converted"
 *     (converted is a payment-confirmed state, sacred).
 *   - "converted" is set externally (when stage flips to "user").
 *   - "ghosted" / "will_start_later" / "callback_scheduled" map to
 *     "followup" so the rep can see "leads to chase".
 *   - Engagement + warm + objection states all roll up to "interested"
 *     (the customer is engaged, just at different points).
 *   - Dead states (not_interested, wrong_number, lost_to_competitor,
 *     opted_out) map to "lost".
 */

const MAP = {
  // Group A
  new_inbound:           "new",
  awaiting_reply:        "new",
  active_chat:           "interested",
  ghosted:               "followup",

  // Group B (warm)
  asking_about_program:  "interested",
  asking_about_price:    "interested",
  comparing_plans:       "interested",
  discussing_with_family: "interested",
  requesting_trial:      "interested",

  // Group C (objections - still engaged)
  price_negotiation:     "interested",
  price_objection:       "interested",
  timing_objection:      "interested",
  medical_concern:       "interested",
  husband_blocking:      "interested",
  will_start_later:      "followup",

  // Group D (hot)
  callback_scheduled:    "followup",
  ready_to_pay:          "interested",
  payment_link_sent:     "interested",
  payment_pending:       "interested",
  onboarded:             "converted",

  // Group E (dead)
  not_interested:        "lost",
  wrong_number:          "lost",
  lost_to_competitor:    "lost",
  opted_out:             "lost",
};

/**
 * legacyStatusFor - returns the legacy status for an interaction_status.
 * Returns null when no mapping (so callers can leave it unchanged).
 */
function legacyStatusFor(interactionStatus) {
  return MAP[interactionStatus] || null;
}

module.exports = { legacyStatusFor, MAP };
