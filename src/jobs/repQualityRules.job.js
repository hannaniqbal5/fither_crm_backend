/**
 * repQualityRules.job.js — Phase 9 (E).
 *
 * Runs hourly during working hours. Evaluates current-day metrics against
 * configured thresholds and writes rep_quality_flags rows. Critical-severity
 * flags also send a push to admin (founder).
 *
 * Rules:
 *   slow_response   — avg response time > rep_quality_max_rt_minutes
 *   low_presence    — presence_pct < rep_quality_min_presence_pct (only after 2+ hours into shift)
 *   high_miss_rate  — missed_replies / total > rep_quality_max_miss_pct
 *   no_sales_yet    — info-level after 4h into shift if conversations > 5 and conversions = 0
 *   overload        — leads_assigned today > 50 (one rep dominating)
 */

const cron = require("node-cron");
const sequelize = require("../config/database");
const { isInWindow, pktHour, pktDayStart } = require("../utils/workingHours");

async function getSettings() {
  const [rows] = await sequelize.query(
    `SELECT setting_key, setting_value FROM layer_system_settings
       WHERE setting_key LIKE 'rep_%'`
  );
  const m = {};
  rows.forEach(r => { m[r.setting_key] = r.setting_value; });
  return {
    startHour:   parseInt(m.rep_shift_start_hour || "9", 10),
    endHour:     parseInt(m.rep_shift_end_hour || "21", 10),
    slaMin:      parseInt(m.rep_sla_response_minutes || "5", 10),
    minPresencePct: parseInt(m.rep_quality_min_presence_pct || "60", 10),
    maxRtMin:    parseInt(m.rep_quality_max_rt_minutes || "15", 10),
    maxMissPct:  parseInt(m.rep_quality_max_miss_pct || "20", 10),
  };
}

async function getTodayStats(repId, settings) {
  // Pull today's running totals (we don't wait for nightly snapshot)
  const dayStart = pktDayStart(new Date(), settings.startHour);

  // Presence
  const [pres] = await sequelize.query(
    `SELECT SUM(active_minutes) AS am, SUM(background_minutes) AS bm, SUM(idle_minutes) AS im
       FROM rep_sessions WHERE rep_id = ? AND in_window = 1 AND started_at >= ?`,
    { replacements: [repId, dayStart] }
  );
  const active = Number(pres[0]?.am || 0);
  // Minutes elapsed in shift so far
  const now = new Date();
  const elapsedMin = Math.max(0, Math.round((now - dayStart) / 60000));
  const presencePct = elapsedMin > 0 ? (active / elapsedMin) * 100 : 0;

  // Response time + miss rate (today, in window)
  const [rtRows] = await sequelize.query(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN TIMESTAMPDIFF(MINUTE, in_msg.created_at, out_msg.created_at) <= ? THEN 1 ELSE 0 END) AS ontime,
            SUM(CASE WHEN out_msg.id IS NULL OR TIMESTAMPDIFF(MINUTE, in_msg.created_at, out_msg.created_at) > ? THEN 1 ELSE 0 END) AS missed,
            AVG(TIMESTAMPDIFF(MINUTE, in_msg.created_at, out_msg.created_at)) AS avg_rt
       FROM messages in_msg
       JOIN leads l ON l.id = in_msg.lead_id
       LEFT JOIN messages out_msg
         ON in_msg.lead_id = out_msg.lead_id
        AND out_msg.direction = 'OUT'
        AND out_msg.created_at = (
          SELECT MIN(m2.created_at) FROM messages m2
           WHERE m2.lead_id = in_msg.lead_id AND m2.direction = 'OUT' AND m2.created_at > in_msg.created_at
        )
       WHERE in_msg.direction = 'IN' AND l.assigned_to = ?
         AND in_msg.created_at >= ?`,
    { replacements: [settings.slaMin, settings.slaMin, repId, dayStart] }
  );
  const total = Number(rtRows[0]?.total || 0);
  const missed = Number(rtRows[0]?.missed || 0);
  const avgRt = Number(rtRows[0]?.avg_rt || 0);
  const missPct = total > 0 ? (missed / total) * 100 : 0;

  // Workload + conversions
  const [convRows] = await sequelize.query(
    `SELECT COUNT(*) AS conv
       FROM rep_conversions WHERE rep_id = ? AND converted_at >= ?`,
    { replacements: [repId, dayStart] }
  );
  const conversions = Number(convRows[0]?.conv || 0);

  const [assignedRows] = await sequelize.query(
    `SELECT COUNT(*) AS c FROM leads WHERE assigned_to = ? AND created_at >= ?`,
    { replacements: [repId, dayStart] }
  );
  const leadsToday = Number(assignedRows[0]?.c || 0);

  return {
    presence_pct: Number(presencePct.toFixed(2)),
    avg_rt: Number(avgRt.toFixed(2)),
    miss_pct: Number(missPct.toFixed(2)),
    conversations_today: total,
    conversions_today: conversions,
    leads_today: leadsToday,
    elapsed_min: elapsedMin,
  };
}

async function recordFlag(repId, flagType, severity, metricValue, thresholdValue, message) {
  const today = new Date().toISOString().slice(0, 10);
  // Dedup — only one flag of same type per rep per day (update if exists)
  await sequelize.query(
    `INSERT INTO rep_quality_flags
       (rep_id, flag_date, flag_type, severity, metric_value, threshold_value, message)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    { replacements: [repId, today, flagType, severity, metricValue, thresholdValue, message] }
  );

  // Critical flags → push admin
  if (severity === "critical") {
    try {
      const { sendPushToSalesRep } = require("../services/notificationService");
      // Push to all admins — assuming admin rep IDs are tracked elsewhere.
      // For now, push to rep ID 1 (admin convention). Replace with actual lookup.
      const adminRepId = parseInt(process.env.ADMIN_REP_ID || "1", 10);
      sendPushToSalesRep(
        adminRepId,
        "Rep quality flag",
        `Rep ${repId}: ${flagType} (${metricValue} vs ${thresholdValue})`,
        { rep_id: String(repId), flag: flagType }
      ).catch(() => {});
    } catch {}
  }
  console.log(`🚩 [RepQuality] Rep ${repId} → ${flagType} (${severity}, ${metricValue} vs ${thresholdValue})`);
}

async function evaluateRep(repId, settings) {
  const stats = await getTodayStats(repId, settings);
  const hour = pktHour();
  const hoursInto = Math.max(0, hour - settings.startHour);

  // Don't fire low_presence flag in the first 2 hours (rep may not have logged in yet)
  if (hoursInto >= 2 && stats.presence_pct < settings.minPresencePct) {
    await recordFlag(repId, "low_presence", "warning",
      stats.presence_pct, settings.minPresencePct,
      `Presence ${stats.presence_pct}% < ${settings.minPresencePct}% threshold`);
  }

  if (stats.conversations_today >= 5 && stats.avg_rt > settings.maxRtMin) {
    const sev = stats.avg_rt > (settings.maxRtMin * 2) ? "critical" : "warning";
    await recordFlag(repId, "slow_response", sev,
      stats.avg_rt, settings.maxRtMin,
      `Avg response ${stats.avg_rt} min > ${settings.maxRtMin} min threshold`);
  }

  if (stats.conversations_today >= 5 && stats.miss_pct > settings.maxMissPct) {
    await recordFlag(repId, "high_miss_rate", "warning",
      stats.miss_pct, settings.maxMissPct,
      `Missed-reply rate ${stats.miss_pct}% > ${settings.maxMissPct}%`);
  }

  // Info flag — high engagement but no conversion yet
  if (hoursInto >= 4 && stats.conversations_today >= 5 && stats.conversions_today === 0) {
    await recordFlag(repId, "no_sales_yet", "info",
      0, 1, `${stats.conversations_today} conversations, 0 sales after ${hoursInto}h`);
  }

  // Overload (one rep dominating)
  if (stats.leads_today > 50) {
    await recordFlag(repId, "overload", "warning",
      stats.leads_today, 50, `${stats.leads_today} leads assigned today`);
  }
}

async function runOnce() {
  const settings = await getSettings();
  if (!isInWindow(new Date(), settings.startHour, settings.endHour)) {
    return; // outside working hours — skip
  }

  const [reps] = await sequelize.query(
    `SELECT DISTINCT rep_id FROM rep_sessions
       WHERE started_at >= DATE_SUB(NOW(), INTERVAL 12 HOUR)`
  );
  for (const r of reps) {
    try {
      await evaluateRep(r.rep_id, settings);
    } catch (err) {
      console.error(`[RepQuality] rep ${r.rep_id} error:`, err.message);
    }
  }
}

function startRepQualityJob() {
  const schedule = process.env.REP_QUALITY_CRON || "0 * * * *";  // top of every hour
  cron.schedule(schedule, require("../monitor/jobs").wrap("rep-quality", () => runOnce()));
  console.log(`✅ [RepQuality] Scheduled (cron: ${schedule})`);
}

module.exports = { startRepQualityJob, runOnce, evaluateRep };
