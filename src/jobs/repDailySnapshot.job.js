/**
 * repDailySnapshot.job.js — Phase 9 (D).
 *
 * Nightly cron (default 11:55 PM PKT). For every rep, write a row to
 * rep_daily_stats with the rolled-up metrics for that day.
 *
 * Source data:
 *   - rep_sessions  (active_minutes, background_minutes, idle_minutes)
 *   - messages      (workload, response time)
 *   - rep_conversions (sales count, revenue)
 *
 * All metrics are scoped to the 9 AM – 9 PM PKT working window.
 */

const cron = require("node-cron");
const sequelize = require("../config/database");
const { QueryTypes } = require("sequelize");
const { minutesInWindowFast, nextInWindowInstant, pktDayStart, pktDayEnd } = require("../utils/workingHours");

async function getSettings() {
  const [rows] = await sequelize.query(
    `SELECT setting_key, setting_value FROM layer_system_settings
       WHERE setting_key IN
         ('rep_shift_start_hour','rep_shift_end_hour','rep_sla_response_minutes')`
  );
  const m = {};
  rows.forEach(r => { m[r.setting_key] = r.setting_value; });
  return {
    startHour: parseInt(m.rep_shift_start_hour || "9", 10),
    endHour:   parseInt(m.rep_shift_end_hour || "21", 10),
    slaMin:    parseInt(m.rep_sla_response_minutes || "5", 10),
  };
}

async function snapshotForDate(targetDate, settings) {
  const dayStart = pktDayStart(targetDate, settings.startHour);
  const dayEnd   = pktDayEnd(targetDate, settings.endHour);
  const shiftMinutes = Math.round((dayEnd - dayStart) / 60000);

  // 1. Presence — sum of active/background/idle minutes per rep for the day
  const [presence] = await sequelize.query(
    `SELECT rep_id,
            SUM(active_minutes)     AS active_minutes,
            SUM(background_minutes) AS background_minutes,
            SUM(idle_minutes)       AS idle_minutes
       FROM rep_sessions
       WHERE in_window = 1
         AND started_at >= ?
         AND started_at <  ?
       GROUP BY rep_id`,
    { replacements: [dayStart, dayEnd] }
  );

  // 2. Workload — message counts per rep
  const [workload] = await sequelize.query(
    `SELECT l.assigned_to AS rep_id,
            SUM(m.direction = 'IN') AS messages_received,
            SUM(m.direction = 'OUT') AS messages_sent,
            COUNT(DISTINCT m.lead_id) AS conversations_handled
       FROM messages m
       JOIN leads l ON l.id = m.lead_id
       WHERE m.created_at >= ?
         AND m.created_at <  ?
         AND l.assigned_to IS NOT NULL
       GROUP BY l.assigned_to`,
    { replacements: [dayStart, dayEnd] }
  );

  // 3. Response time — JS-side (need working-hours clamp)
  const inboundRows = await sequelize.query(
    `SELECT l.assigned_to AS rep_id, in_msg.lead_id, in_msg.created_at AS in_at,
            (SELECT MIN(out_msg.created_at) FROM messages out_msg
              WHERE out_msg.lead_id = in_msg.lead_id
                AND out_msg.direction = 'OUT'
                AND out_msg.created_at > in_msg.created_at) AS out_at
       FROM messages in_msg
       JOIN leads l ON l.id = in_msg.lead_id
       WHERE in_msg.direction = 'IN'
         AND l.assigned_to IS NOT NULL
         AND in_msg.created_at >= ?
         AND in_msg.created_at <  ?`,
    { replacements: [dayStart, dayEnd], type: QueryTypes.SELECT }
  );

  const rtPerRep = new Map();
  inboundRows.forEach(r => {
    if (!rtPerRep.has(r.rep_id)) rtPerRep.set(r.rep_id, { totalRt: 0, samples: 0, onTime: 0, missed: 0 });
    const bucket = rtPerRep.get(r.rep_id);
    if (!r.out_at) { bucket.missed += 1; return; }
    const clampedStart = nextInWindowInstant(r.in_at, settings.startHour, settings.endHour);
    const rt = new Date(r.out_at) <= clampedStart
      ? 0
      : minutesInWindowFast(clampedStart, new Date(r.out_at), settings.startHour, settings.endHour);
    bucket.totalRt += rt;
    bucket.samples += 1;
    if (rt <= settings.slaMin) bucket.onTime += 1; else bucket.missed += 1;
  });

  // 4. Conversions — count + revenue per rep
  const [conv] = await sequelize.query(
    `SELECT rep_id,
            COUNT(*) AS conversions_count,
            SUM(amount_paid) AS revenue_attributed
       FROM rep_conversions
       WHERE converted_at >= ? AND converted_at < ?
       GROUP BY rep_id`,
    { replacements: [dayStart, dayEnd] }
  );

  // 5. Leads assigned today
  const [assigned] = await sequelize.query(
    `SELECT assigned_to AS rep_id, COUNT(*) AS leads_assigned
       FROM leads
       WHERE assigned_to IS NOT NULL
         AND created_at >= ? AND created_at < ?
       GROUP BY assigned_to`,
    { replacements: [dayStart, dayEnd] }
  );

  // Merge all keys
  const repIds = new Set();
  presence.forEach(r => repIds.add(r.rep_id));
  workload.forEach(r => repIds.add(r.rep_id));
  for (const k of rtPerRep.keys()) repIds.add(k);
  conv.forEach(r => repIds.add(r.rep_id));
  assigned.forEach(r => repIds.add(r.rep_id));

  const presenceMap = new Map(presence.map(r => [r.rep_id, r]));
  const workloadMap = new Map(workload.map(r => [r.rep_id, r]));
  const convMap     = new Map(conv.map(r => [r.rep_id, r]));
  const assignedMap = new Map(assigned.map(r => [r.rep_id, r]));

  const stamps = [];
  for (const repId of repIds) {
    const p = presenceMap.get(repId) || {};
    const w = workloadMap.get(repId) || {};
    const rt = rtPerRep.get(repId) || { totalRt: 0, samples: 0, onTime: 0, missed: 0 };
    const c = convMap.get(repId) || {};
    const a = assignedMap.get(repId) || {};

    const active = Number(p.active_minutes || 0);
    const background = Number(p.background_minutes || 0);
    const idle = Number(p.idle_minutes || 0);
    const presencePct = shiftMinutes > 0 ? (active / shiftMinutes) * 100 : 0;
    const avgRt = rt.samples > 0 ? rt.totalRt / rt.samples : 0;
    const onTimePct = rt.samples > 0 ? (rt.onTime / rt.samples) * 100 : 0;

    stamps.push({
      rep_id: repId,
      stat_date: new Date(dayStart.getTime()).toISOString().slice(0,10),
      active_minutes: active,
      background_minutes: background,
      idle_minutes: idle,
      shift_minutes: shiftMinutes,
      presence_pct: Number(presencePct.toFixed(2)),
      messages_received: Number(w.messages_received || 0),
      messages_sent: Number(w.messages_sent || 0),
      conversations_handled: Number(w.conversations_handled || 0),
      leads_assigned: Number(a.leads_assigned || 0),
      avg_response_time_min: Number(avgRt.toFixed(2)),
      on_time_pct: Number(onTimePct.toFixed(2)),
      missed_replies: rt.missed,
      escalations: 0, // future: pull from is_escalated history
      conversions_count: Number(c.conversions_count || 0),
      revenue_attributed: Number(c.revenue_attributed || 0),
    });
  }

  // Upsert into rep_daily_stats
  for (const s of stamps) {
    await sequelize.query(
      `INSERT INTO rep_daily_stats
         (rep_id, stat_date, active_minutes, background_minutes, idle_minutes, shift_minutes,
          presence_pct, messages_received, messages_sent, conversations_handled,
          leads_assigned, avg_response_time_min, on_time_pct, missed_replies, escalations,
          conversions_count, revenue_attributed)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         active_minutes=VALUES(active_minutes),
         background_minutes=VALUES(background_minutes),
         idle_minutes=VALUES(idle_minutes),
         shift_minutes=VALUES(shift_minutes),
         presence_pct=VALUES(presence_pct),
         messages_received=VALUES(messages_received),
         messages_sent=VALUES(messages_sent),
         conversations_handled=VALUES(conversations_handled),
         leads_assigned=VALUES(leads_assigned),
         avg_response_time_min=VALUES(avg_response_time_min),
         on_time_pct=VALUES(on_time_pct),
         missed_replies=VALUES(missed_replies),
         escalations=VALUES(escalations),
         conversions_count=VALUES(conversions_count),
         revenue_attributed=VALUES(revenue_attributed)`,
      { replacements: [
        s.rep_id, s.stat_date, s.active_minutes, s.background_minutes, s.idle_minutes, s.shift_minutes,
        s.presence_pct, s.messages_received, s.messages_sent, s.conversations_handled,
        s.leads_assigned, s.avg_response_time_min, s.on_time_pct, s.missed_replies, s.escalations,
        s.conversions_count, s.revenue_attributed,
      ] }
    );
  }
  console.log(`📊 [RepSnapshot] Wrote ${stamps.length} rows for ${stamps[0]?.stat_date || "no-data"}`);
  return stamps;
}

async function runForYesterday() {
  const settings = await getSettings();
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return snapshotForDate(yesterday, settings);
}

function startDailySnapshotJob() {
  // Default: 11:55 PM PKT every day = 18:55 UTC
  const schedule = process.env.REP_SNAPSHOT_CRON || "55 18 * * *";
  cron.schedule(schedule, require("../monitor/jobs").wrap("rep-daily-snapshot", () => runForYesterday(), { ttlSec: 3600 }));
  console.log(`✅ [RepSnapshot] Scheduled (cron: ${schedule})`);
}

module.exports = { startDailySnapshotJob, runForYesterday, snapshotForDate };
