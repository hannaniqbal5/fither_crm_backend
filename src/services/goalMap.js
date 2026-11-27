/**
 * goalMap.js — her goal in the CRM's words (Nov 2026).
 *
 * RULE: the goal she picked in the app is her goal. It overwrites whatever
 * the CRM guessed from chat, and the chat classifier no longer changes it
 * afterwards (ai/layer2Classifier.js, ai/intentApplier.js). A rep can still
 * set it by hand. The app's own wording stays in main_goal_app.
 *
 *   fromApp(text) → 'pcos' | 'postpartum' | 'diabetes' | 'weight_gain' |
 *                   'weight_loss' | 'general' | null (unrecognised: don't
 *                   touch main_goal on a guess)
 *   appGoalOf(lead) → the mapped app goal, when she has one
 *
 * Keep the order in step with migrations/051_app_goal_wins.sql.
 */
function fromApp(text) {
  const t = String(text || "").toLowerCase().trim();
  if (!t) return null;
  if (/pcos|pcod/.test(t)) return "pcos";
  if (/post.?partum|after (delivery|baby|pregnan)|delivery|new mom/.test(t)) return "postpartum";
  if (/diabet|sugar|insulin/.test(t)) return "diabetes";
  if (/gain/.test(t)) return "weight_gain";
  if (/lose|loss|reduc|fat|slim|weight/.test(t)) return "weight_loss";
  if (/wellness|fit|health|general|tone|toning|strength|active|energy|stress/.test(t)) return "general";
  return null;
}

const appGoalOf = (lead) => (lead ? fromApp(lead.main_goal_app) : null);

module.exports = { fromApp, appGoalOf };
