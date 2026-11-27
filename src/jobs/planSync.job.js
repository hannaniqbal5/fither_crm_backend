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


/**
 * The exact text MySQL would store for a date, written the way every CRM write
 * writes it (Sequelize's own formatting). Comparing this with the column's raw
 * text means we only "fix" an expiry when the write would actually change it.
 * (Comparing JS Dates mixed up time zones: it rewrote 5 leads with the value
 * they already had, every night.)
 */
const asStored = (d) => (d ? sequelize.escape(new Date(d)).replace(/^'|'$/g, "").slice(0, 19) : null);

/** What to change on one lead, given the app's truth. Pure — easy to test. */
function diff(lead, truth, stored = asStored) {
  const changes = {};
  const status = truth.status || "none";
  if ((lead.subscription_status || "none") !== status) changes.subscription_status = status;
  if (truth.plan_title && truth.plan_title !== lead.subscription_plan_title) changes.subscription_plan_title = truth.plan_title;
  if (truth.expires_at) {
    const want = stored(truth.expires_at);
    const have = lead.expires_raw !== undefined ? lead.expires_raw : (lead.subscription_expires_at ? stored(lead.subscription_expires_at) : null);
    if (want && want !== have) changes.subscription_expires_at = new Date(truth.expires_at);
  }
  // Trial, freeze and classes (migration 050). Only when this lead row has
  // those columns (lead.trial_classes_attended !== undefined).
  if (lead.trial_classes_attended !== undefined) {
    const dateField = (col, val) => {
      const want = val ? stored(val) : null;
      const have = lead[`${col}_raw`] !== undefined ? lead[`${col}_raw`] : (lead[col] ? stored(lead[col]) : null);
      if (want !== have && (want || col === "subscription_frozen_at")) changes[col] = val ? new Date(val) : null;
    };
    dateField("trial_started_at", truth.trial_started_at);
    dateField("trial_expires_at", truth.trial_expires_at);
    dateField("subscription_frozen_at", truth.frozen_at);
    if (truth.trial_classes_attended != null && Number(truth.trial_classes_attended) > Number(lead.trial_classes_attended || 0)) {
      changes.trial_classes_attended = Number(truth.trial_classes_attended);
    }
    // Classes only ever go up (live events may already be ahead of the app's count).
    if (truth.classes_total != null && Number(truth.classes_total) > Number(lead.total_workouts_completed || 0)) {
      changes.total_workouts_completed = Number(truth.classes_total);
    }
    if (truth.last_class_at) {
      const want = stored(truth.last_class_at);
      const have = lead.last_class_at_raw !== undefined ? lead.last_class_at_raw : (lead.last_class_at ? stored(lead.last_class_at) : null);
      if (!have || want > have) changes.last_class_at = new Date(truth.last_class_at);
    }
  }
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
    const base = `id, app_user_id, stage, subscription_status, subscription_plan_title, subscription_expires_at,
              DATE_FORMAT(subscription_expires_at, '%Y-%m-%d %H:%i:%s') AS expires_raw`;
    const extra = `, trial_classes_attended, total_workouts_completed,
              DATE_FORMAT(trial_started_at, '%Y-%m-%d %H:%i:%s') AS trial_started_at_raw,
              DATE_FORMAT(trial_expires_at, '%Y-%m-%d %H:%i:%s') AS trial_expires_at_raw,
              DATE_FORMAT(subscription_frozen_at, '%Y-%m-%d %H:%i:%s') AS subscription_frozen_at_raw,
              DATE_FORMAT(last_class_at, '%Y-%m-%d %H:%i:%s') AS last_class_at_raw`;
    const q = (cols) => sequelize.query(
      `SELECT ${cols} FROM leads WHERE app_user_id IN (:ids) AND merged_into_lead_id IS NULL`,
      { replacements: { ids } }
    );
    // Before migration 050 the trial / class columns don't exist: plans only.
    const [leads] = await q(base + extra).catch((e) => {
      if (!/unknown column/i.test(String(e.message))) throw e;
      if (!report.needs_migration_050) console.warn("[PlanSync] run migration 050_trial_and_class_data.sql to sync trial and class data");
      report.needs_migration_050 = true;
      return q(base);
    });
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
            { replacements: { at: runAt, lead: lead.id, f, o: (lead[f] ?? lead[`${f}_raw`]) == null ? null : String(lead[f] ?? lead[`${f}_raw`]).slice(0, 200), n: String(changes[f]).slice(0, 200) } }
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
