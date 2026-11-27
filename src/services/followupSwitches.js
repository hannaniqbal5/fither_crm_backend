/**
 * followupSwitches.js — admin switches for GENERAL follow-ups (migration 052).
 *
 *   followups_enabled               '0' = general follow-ups stopped
 *   followups_skip_campaign_ladder  '1' = leave women inside a campaign alone
 *
 * "General follow-ups" = the Layer 5 follow-up engine (jobs/followupEngine.js)
 * and automation rules fired by inactivity (inactivity_24h / inactivity_7d).
 * Campaign follow-ups (Touch 2 / Touch 3, broadcastWorker) are NOT affected,
 * and neither are Fiza's replies or a rep's own messages.
 */
const sequelize = require("../config/database");

// A woman is "inside a campaign" when she is queued for Touch 1 in a live
// campaign, her Touch 2 / Touch 3 is still due, or a campaign messaged her in
// the last 7 days and she hasn't replied. Once she replies, normal rules apply.
// leadRef = SQL expression for the lead id (a column or a :placeholder).
function insideCampaignSql(leadRef) {
  return `EXISTS (
  SELECT 1 FROM campaign_recipients cr JOIN campaigns c ON c.campaign_id = cr.campaign_id
   WHERE cr.lead_id = ${leadRef}
     AND (
       cr.next_step_at IS NOT NULL
       OR (cr.status IN ('queued','sending') AND c.status IN ('queued','scheduled','running','paused'))
       OR (cr.replied_at IS NULL AND cr.status <> 'replied'
           AND GREATEST(COALESCE(cr.sent_at, '1970-01-01'), COALESCE(cr.last_step_sent_at, '1970-01-01'))
               >= DATE_SUB(NOW(), INTERVAL 7 DAY))
     ))`;
}

async function getSwitches() {
  try {
    const [rows] = await sequelize.query(
      `SELECT setting_key, setting_value FROM layer_system_settings
        WHERE setting_key IN ('followups_enabled','followups_skip_campaign_ladder')`
    );
    const m = Object.fromEntries(rows.map((r) => [r.setting_key, String(r.setting_value)]));
    return { enabled: m.followups_enabled !== "0", skipCampaign: m.followups_skip_campaign_ladder !== "0" };
  } catch (e) {
    return { enabled: true, skipCampaign: true };
  }
}

/**
 * For an automation-rule send. Returns a skip reason, or null to allow.
 * Only inactivity-triggered rules count as follow-ups for the stop switch;
 * the campaign rule applies to every automated rule send.
 */
async function automationBlock(leadId, eventType) {
  const sw = await getSwitches();
  if (!sw.enabled && /^inactivity_/.test(String(eventType || ""))) return "general follow-ups stopped by admin";
  if (sw.skipCampaign && leadId) {
    try {
      const [[r]] = await sequelize.query(`SELECT ${insideCampaignSql(":lid")} AS inside`, { replacements: { lid: leadId } });
      if (r && Number(r.inside)) return "inside a campaign (campaign follow-ups handle her)";
    } catch (e) {
      console.error("[followupSwitches] campaign check failed (allowing):", e.message);
    }
  }
  return null;
}

module.exports = { insideCampaignSql, getSwitches, automationBlock };
