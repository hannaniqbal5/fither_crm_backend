/**
 * journeyContext.js — Builds a journey-aware context block for Fiza.
 *
 * Enriches the AI prompt with where the lead is in her journey:
 *   - Which stage (prospect → trial → user → churned)
 *   - What just happened (signed up, started trial, froze, expired)
 *   - What should happen next
 *   - Time-sensitive info (trial days left, subscription expiry)
 *
 * Used by autoTakeover to make Fiza's auto-replies contextual,
 * and can be injected into buildSystemPrompt for any reply.
 */

const sequelize = require("../config/database");

async function buildJourneyContext(leadId) {
  const common = `l.id, l.name, l.phone, l.stage, l.source,
           l.subscription_status, l.subscription_plan_title,
           l.app_signed_up_at, l.app_onboarded_at, l.app_onboarding_step,
           l.subscription_expires_at,
           l.last_activity_at, l.interaction_status, l.main_goal,
           l.last_objection, l.lead_score,
           l.total_workouts_completed, l.total_diet_days_completed, l.target_weight_kg,
           l.main_goal_app, l.has_pcos,
           DATEDIFF(l.subscription_expires_at, NOW()) AS sub_days_left,
           DATEDIFF(NOW(), COALESCE(l.last_activity_at, l.created_at)) AS days_quiet,
           r.name AS rep_name`;
  // Trial / freeze / last class come with migration 050.
  const trial = `, l.trial_started_at, l.trial_expires_at, l.trial_classes_attended,
           l.subscription_frozen_at, l.last_class_at,
           DATEDIFF(l.trial_expires_at, NOW()) AS trial_days_left,
           DATEDIFF(NOW(), l.last_class_at) AS days_since_class`;
  const q = (cols) => sequelize.query(
    `SELECT ${cols} FROM leads l LEFT JOIN sales_reps r ON r.id = l.assigned_to WHERE l.id = ?`,
    { replacements: [leadId] }
  );
  const [rows] = await q(common + trial).catch((e) => {
    if (!/unknown column/i.test(String(e.message))) throw e;
    return q(common); // before migration 050
  });

  if (!rows.length) return null;
  const lead = rows[0];

  // Pull last 3 activities
  const [activities] = await sequelize.query(`
    SELECT activity_type, source, metadata, created_at
    FROM activities
    WHERE lead_id = ?
    ORDER BY created_at DESC LIMIT 3
  `, { replacements: [leadId] });

  // Build the context
  const lines = [];
  lines.push("# JOURNEY CONTEXT — where this woman is right now");
  lines.push(`Name: ${lead.name || "(unknown)"}`);
  lines.push(`Stage: ${lead.stage || "unknown"}`);
  lines.push(`Subscription: ${lead.subscription_status || "none"} ${lead.subscription_plan_title ? "(" + lead.subscription_plan_title + ")" : ""}`);
  lines.push(`Rep: ${lead.rep_name || "unassigned"}`);
  lines.push(`Lead score: ${lead.lead_score ?? 0}`);
  if (lead.main_goal_app) lines.push(`Her goal (she chose it in the app, this is her own goal): ${lead.main_goal_app}`);
  if (Number(lead.has_pcos) && !/pcos|pcod/i.test(String(lead.main_goal_app || ""))) {
    lines.push("She told the app she has PCOS. Keep that in mind (PCOS-friendly advice), even though her goal above is different.");
  }

  // Journey-specific context
  if (lead.app_signed_up_at && !lead.app_onboarded_at) {
    lines.push("");
    lines.push("## SHE SIGNED UP BUT HASN'T FINISHED ONBOARDING");
    lines.push(`Stuck at step: ${lead.app_onboarding_step || "unknown"}`);
    lines.push("Your job: Help her complete onboarding. Ask what's blocking her. Be encouraging.");
    lines.push("Don't pitch plans yet. Get her into the app first.");
  }

  if (lead.subscription_status === "trial") {
    lines.push("");
    lines.push("## SHE'S ON A FREE TRIAL");
    lines.push(`Trial days left: ${lead.trial_days_left ?? "unknown"}`);
    lines.push(`Trial classes attended: ${lead.trial_classes_attended ?? 0} of 3`);

    if ((lead.trial_classes_attended ?? 0) === 0) {
      lines.push("She hasn't joined any class yet. Priority: get her to her FIRST class.");
      lines.push("Share the class schedule, ask what time works for her, make it easy.");
    } else if (lead.trial_days_left != null && lead.trial_days_left <= 2) {
      lines.push("Trial ending very soon. She's tried classes, now convert.");
      lines.push("Use the spot-booking close. Mention what she'll lose when trial ends.");
    } else {
      lines.push("She's in trial and has attended classes. Check how she's finding it.");
      lines.push("Build excitement, don't rush the sell yet.");
    }
  }

  if (lead.subscription_status === "active" && lead.sub_days_left != null && lead.sub_days_left <= 7) {
    lines.push("");
    lines.push("## SUBSCRIPTION EXPIRING SOON");
    lines.push(`Days left: ${lead.sub_days_left}`);
    lines.push("Focus on renewal. Mention her progress, what she'll miss, and the renewal plan.");
    lines.push("Don't be pushy. Acknowledge her journey so far.");
  }

  if (lead.subscription_status === "frozen") {
    lines.push("");
    lines.push("## SHE FROZE HER SUBSCRIPTION");
    if (lead.subscription_frozen_at) lines.push(`Frozen since: ${new Date(lead.subscription_frozen_at).toISOString().slice(0, 10)}`);
    lines.push("Something made her pause. Find out why gently.");
    lines.push("Common reasons: Ramadan, travel, health issue, financial.");
    lines.push("Offer support, don't pressure. Let her know her spot is saved.");
  }

  // stage 'churned' too: a paid customer from the group or sheet with no app
  // account has subscription 'none' but did pay before (campaignIntake.js).
  if (lead.subscription_status === "expired" || lead.subscription_status === "cancelled" ||
      (lead.stage === "churned" && !["active", "frozen", "trial"].includes(lead.subscription_status))) {
    lines.push("");
    lines.push("## SHE'S CHURNED / EXPIRED");
    lines.push("She was a paying customer. Win her back.");
    lines.push("Acknowledge time away, ask what happened, share what's new since she left.");
    lines.push("Only mention an offer if it is listed under THE CAMPAIGN SHE REPLIED TO below and still running. Never invent one.");
  }

  if (lead.stage === "prospect" && !lead.app_signed_up_at) {
    lines.push("");
    lines.push("## FRESH PROSPECT — NOT ON THE APP YET");
    lines.push("She's interested but hasn't downloaded. Priority: get her to try the app.");
    lines.push("Share the trial link. Mention it's free, no card needed.");
    if (lead.main_goal) lines.push(`Her goal: ${lead.main_goal}`);
  }

  if (lead.days_quiet != null && lead.days_quiet > 3) {
    lines.push("");
    lines.push(`## GONE QUIET — ${lead.days_quiet} days since last activity`);
    lines.push("She may have lost interest or gotten busy. Be warm, not accusatory.");
    lines.push("Ask a simple question, share something new/interesting.");
  }

  // What she has done in the app: lets Fizza talk to HER, not a template.
  const classes = Number(lead.total_workouts_completed || 0);
  const dietDays = Number(lead.total_diet_days_completed || 0);
  if (classes || dietDays || lead.target_weight_kg) {
    lines.push("");
    lines.push("## HER ACTIVITY IN THE APP");
    if (classes) lines.push(`Classes attended: ${classes}${lead.days_since_class != null ? ` (last one ${lead.days_since_class === 0 ? "today" : `${lead.days_since_class} day(s) ago`})` : ""}`);
    if (dietDays) lines.push(`Diet days logged: ${dietDays}`);
    if (lead.target_weight_kg) lines.push(`Her target weight: ${Number(lead.target_weight_kg)} kg`);
    lines.push("Use this naturally when it fits (praise consistency, refer to her own goal). Don't list numbers at her.");
    if (["active", "frozen"].includes(lead.subscription_status) && lead.days_since_class != null && lead.days_since_class >= 7) {
      lines.push(`She hasn't joined a class for ${lead.days_since_class} days. If the moment fits, gently invite her back; no guilt.`);
    }
  }

  // Recent activity
  if (activities.length) {
    lines.push("");
    lines.push("## RECENT EVENTS");
    for (const a of activities) {
      const when = new Date(a.created_at).toLocaleDateString("en-PK");
      lines.push(`- ${when}: ${a.activity_type} (${a.source})`);
    }
  }

  // The campaign she is replying to: the exact message and its real offer
  // (or that the offer has ended). Same facts the follow-ups use.
  try {
    const campaign = await require("./followupWriter").campaignContext(leadId);
    if (campaign.length) { lines.push(""); lines.push(...campaign.map((l) => l.replace(/^# /, "## "))); }
  } catch (e) { /* no campaign context: reply as before */ }

  // Manager's extra instructions (from takeover rule)
  // This is injected by the caller if needed

  return lines.join("\n");
}

module.exports = { buildJourneyContext };
