/**
 * planSync.job.js — nightly check that the CRM's copy of every member's plan
 * matches the app backend (the source of truth).
 *
 * The CRM learns about plans through events. If one is lost or rejected, the
 * CRM keeps a wrong plan — and Fiza may pitch a plan to a paying member.
 * This job asks the app backend for every customer's current plan state
 * (GET /internal/crm/subscriptions, signed) and:
 *   • corrects subscription_status / plan title / expiry where they differ;
 *   • moves a woman with a live paid plan to stage 'user' (paying member);
 *   • does NOT fire events or automations (no WhatsApp, no win-back) —
 *     it only fixes the record;
 *   • does NOT downgrade a stage: a 'user' lead with no live plan in the app
 *     is listed for a person to check (she may have paid another way).
 * Every change is written to plan_sync_log; the last run's summary is kept
 * for the admin page.
 */
const cron = require("node-cron");
const sequelize = require("../config/database");

const PAGE = 500;
let lastReport = null;

async function ensureLog() {
  await sequelize.query(`CREATE TABLE IF NOT EXISTS plan_sync_log (
    id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    run_at     DATETIME     NOT NULL,
    lead_id    INT UNSIGNED NOT NULL,
    field      VARCHAR(40)  NOT NULL,
    old_value  VARCHAR(200) NULL,
    new_value  VARCHAR(200) NULL,
    INDEX idx_run (run_at), INDEX idx_lead (lead_id)
  )`);
}

const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

/** What to change on one lead, given the app's truth. Pure — easy to test. */
function diff(lead, truth) {
  const changes = {};
  const status = truth.status || "none";
  if ((lead.subscription_status || "none") !== status) changes.subscription_status = status;
  if (truth.plan_title && truth.plan_title !== lead.subscription_plan_title) changes.subscription_plan_title = truth.plan_title;
  if (truth.expires_at && day(truth.expires_at) !== day(lead.subscription_expires_at)) changes.subscription_expires_at = new Date(truth.expires_at);
  const paying = status === "active" || status === "frozen";
  if (paying && lead.stage !== "user") changes.stage = "user";
  const checkByHand = !paying && lead.stage === "user";
  return { changes, checkByHand };
}

async function runPlanSync() {
  const { partnerCall } = require("../services/partnerSigned");
  await ensureLog();
  const runAt = new Date();
  const report = { started_at: runAt.toISOString(), checked: 0, matched: 0, fixed: 0, became_member: 0, no_lead: 0, check_by_hand: [], errors: 0 };

  for (let offset = 0; ; offset += PAGE) {
    const data = await partnerCall("GET", `/internal/crm/subscriptions?limit=${PAGE}&offset=${offset}`);
    const subs = data.subscriptions || [];
    if (!subs.length) break;
    const ids = subs.map((s) => String(s.app_user_id));
    const [leads] = await sequelize.query(
      `SELECT id, app_user_id, stage, subscription_status, subscription_plan_title, subscription_expires_at
         FROM leads WHERE app_user_id IN (:ids) AND merged_into_lead_id IS NULL`,
      { replacements: { ids } }
    );
    const byApp = new Map(leads.map((l) => [String(l.app_user_id), l]));

    for (const truth of subs) {
      report.checked++;
      const lead = byApp.get(String(truth.app_user_id));
      if (!lead) { if (truth.status !== "none") report.no_lead++; continue; }
      const { changes, checkByHand } = diff(lead, truth);
      if (checkByHand && report.check_by_hand.length < 200) {
        report.check_by_hand.push({ lead_id: lead.id, app_user_id: lead.app_user_id, app_status: truth.status });
      }
      const fields = Object.keys(changes);
      if (!fields.length) { report.matched++; continue; }
      try {
        const sets = fields.map((f) => `${f} = :${f}`).join(", ");
        await sequelize.query(
          `UPDATE leads SET ${sets}, app_synced_at = NOW() WHERE id = :id`,
          { replacements: { ...changes, id: lead.id } }
        );
        for (const f of fields) {
          await sequelize.query(
            "INSERT INTO plan_sync_log (run_at, lead_id, field, old_value, new_value) VALUES (:at, :lead, :f, :o, :n)",
            { replacements: { at: runAt, lead: lead.id, f, o: lead[f] == null ? null : String(lead[f]).slice(0, 200), n: String(changes[f]).slice(0, 200) } }
          );
        }
        report.fixed++;
        if (changes.stage === "user") report.became_member++;
      } catch (e) {
        report.errors++;
        console.error(`[PlanSync] lead ${lead.id} not updated:`, e.message);
      }
    }
    if (subs.length < (data.limit || PAGE)) break;
  }

  report.finished_at = new Date().toISOString();
  lastReport = report;
  console.log(`🔄 [PlanSync] checked ${report.checked}, fixed ${report.fixed} (${report.became_member} now members), ${report.check_by_hand.length} to check by hand, ${report.no_lead} with a plan but no CRM lead`);
  return report;
}

async function lastRun() {
  await ensureLog();
  const [[last]] = await sequelize.query("SELECT MAX(run_at) AS at, COUNT(DISTINCT lead_id) AS leads FROM plan_sync_log WHERE run_at = (SELECT MAX(run_at) FROM plan_sync_log)");
  return { this_process_last_report: lastReport, last_run_with_changes: last };
}

function startPlanSyncJob() {
  const schedule = process.env.PLAN_SYNC_CRON || "20 3 * * *"; // 03:20 PKT
  cron.schedule(schedule, require("../monitor/jobs").wrap("plan-sync", runPlanSync, { ttlSec: 3600 }), { timezone: "Asia/Karachi" });
  console.log(`🔄 [PlanSync] Scheduled (cron: ${schedule}, Asia/Karachi)`);
}

module.exports = { startPlanSyncJob, runPlanSync, diff, lastRun };
