/**
 * adminOverview.routes.js — the admin Dashboard (Nov 2026).
 *
 *   GET /api/admin/overview?from=YYYY-MM-DD&to=YYYY-MM-DD   (admin only)
 *
 * One call returns everything the Dashboard shows:
 *   kpis       headline numbers for the range, plus the same-length range before it
 *   team       team reply time / unanswered / conversion (services/repAnalytics)
 *   reps       per rep: live workload right now (chats waiting, close-to-buying,
 *              tasks, pipeline) + performance in the range + how she handles
 *              campaign replies
 *   campaigns  campaigns live in the range, each split by rep: women sent to,
 *              replied, answered by the rep / only by Fiza / by nobody, waiting
 *              now, reply time, sales
 *   waiting    chats where the woman wrote last, longest wait first
 *   funnel, sources, daily
 *
 * How things are counted
 *   Waiting now     her message is the last one in the chat (last 14 days).
 *   Wait time       working hours only (rep shift, default 9 AM – 9 PM PKT), same
 *                   rule as Rep Analytics.
 *   Campaign rep    the rep the woman is assigned to now (leads.assigned_to).
 *   Answered by rep a rep message came after her campaign reply.
 *   Fiza only       Fiza replied after her campaign reply and no rep did.
 *   Campaign sale   a rep_conversions row for her dated after the campaign reached her.
 *   Times are stored in UTC; days are PKT days.
 */
const express = require("express");
const { QueryTypes } = require("sequelize");
const sequelize = require("../config/database");
const auth = require("../middleware/auth.middleware");
const adminOnly = require("../middleware/adminOnly");
const repAnalytics = require("../services/repAnalytics");
const { minutesInWindowFast, nextInWindowInstant } = require("../utils/workingHours");

const router = express.Router();

const PKT_MS = 5 * 3600 * 1000;
const DAY_MS = 86400000;
const WAITING_LOOKBACK_DAYS = 14;
const HOT_STATUSES = ["ready_to_pay", "payment_link_sent", "payment_pending", "requesting_trial"];

const q = (sql, replacements = {}) => sequelize.query(sql, { type: QueryTypes.SELECT, replacements });
const safe = (p) => p.catch((err) => { console.warn("[admin overview] optional query failed:", err.message); return []; });
const n = (v) => Number(v || 0);
const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const pct = (a, b) => (b > 0 ? round1((a / b) * 100) : null);
const pktDate = (d) => new Date(new Date(d).getTime() + PKT_MS).toISOString().slice(0, 10);
const median = (arr) => {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  return round1(s[Math.min(s.length - 1, Math.max(0, Math.ceil(0.5 * s.length) - 1))]);
};

function workMinutes(from, to, settings) {
  const start = nextInWindowInstant(new Date(from), settings.startHour, settings.endHour);
  const end = new Date(to);
  return end <= start ? 0 : minutesInWindowFast(start, end, settings.startHour, settings.endHour);
}

router.get("/overview", auth, adminOnly, async (req, res) => {
  try {
    const { from, to, rangeStart, rangeEnd } = repAnalytics.parseRange(req.query.from, req.query.to);
    const span = rangeEnd.getTime() - rangeStart.getTime();
    const prevStart = new Date(rangeStart.getTime() - span);
    const now = new Date();
    const waitingSince = new Date(now.getTime() - WAITING_LOOKBACK_DAYS * DAY_MS);
    const r = { s: rangeStart, e: rangeEnd, ps: prevStart, now, since: waitingSince, hot: HOT_STATUSES };

    const [
      perf, leadKpi, msgKpi, saleKpi, leadsDaily, inDaily, salesDaily, sources, stages, statuses,
      reps, workload, tasks, lastMsgs, conversions, campaignList,
    ] = await Promise.all([
      repAnalytics.analytics(sequelize, { from, to }),
      q(`SELECT SUM(created_at >= :s) AS cur, SUM(created_at < :s) AS prev
           FROM leads WHERE created_at >= :ps AND created_at < :e`, r),
      q(`SELECT SUM(created_at >= :s AND direction = 'IN')                 AS inbound,
                SUM(created_at <  :s AND direction = 'IN')                 AS inbound_prev,
                SUM(created_at >= :s AND direction = 'OUT' AND \`from\` = 'rep') AS rep_sent,
                SUM(created_at >= :s AND direction = 'OUT' AND \`from\` = 'bot') AS fiza_sent
           FROM messages WHERE created_at >= :ps AND created_at < :e`, r),
      q(`SELECT SUM(converted_at >= :s) AS sales, SUM(converted_at < :s) AS sales_prev,
                SUM(CASE WHEN converted_at >= :s THEN amount_paid ELSE 0 END) AS revenue,
                SUM(CASE WHEN converted_at <  :s THEN amount_paid ELSE 0 END) AS revenue_prev
           FROM rep_conversions WHERE converted_at >= :ps AND converted_at < :e`, r),
      q(`SELECT DATE(DATE_ADD(created_at, INTERVAL 5 HOUR)) AS d, COUNT(*) AS c
           FROM leads WHERE created_at >= :s AND created_at < :e GROUP BY d`, r),
      q(`SELECT DATE(DATE_ADD(created_at, INTERVAL 5 HOUR)) AS d, COUNT(*) AS c
           FROM messages WHERE direction = 'IN' AND created_at >= :s AND created_at < :e GROUP BY d`, r),
      q(`SELECT DATE(DATE_ADD(converted_at, INTERVAL 5 HOUR)) AS d, COUNT(*) AS c, SUM(amount_paid) AS rev
           FROM rep_conversions WHERE converted_at >= :s AND converted_at < :e GROUP BY d`, r),
      q(`SELECT COALESCE(source, 'unknown') AS source, COUNT(*) AS c
           FROM leads WHERE created_at >= :s AND created_at < :e GROUP BY source ORDER BY c DESC`, r),
      q(`SELECT stage, COUNT(*) AS c FROM leads GROUP BY stage`),
      q(`SELECT status, COUNT(*) AS c FROM leads GROUP BY status`),
      q(`SELECT id, name, role, status FROM sales_reps ORDER BY name`),
      q(`SELECT assigned_to AS rep_id,
                COUNT(*)                                              AS assigned,
                SUM(stage <> 'churned' AND status NOT IN ('converted','lost')) AS open_pipeline,
                SUM(status = 'new')         AS st_new,
                SUM(status = 'interested')  AS st_interested,
                SUM(status = 'followup')    AS st_followup,
                SUM(status = 'converted')   AS st_converted,
                SUM(status = 'lost')        AS st_lost,
                SUM(interaction_status IN (:hot)) AS hot,
                SUM(created_at >= :s AND created_at < :e) AS new_in_range,
                SUM(last_message_at IS NULL OR last_message_at < DATE_SUB(:now, INTERVAL 7 DAY)) AS quiet_7d
           FROM leads WHERE assigned_to IS NOT NULL GROUP BY assigned_to`, r),
      safe(q(`SELECT rep_id, SUM(status = 'open') AS open_tasks,
                     SUM(status = 'open' AND due_at < :now) AS overdue_tasks
                FROM rep_tasks GROUP BY rep_id`, r)),
      // Last message of every chat that moved in the last 14 days
      q(`SELECT l.id, l.name, l.phone, l.assigned_to, l.stage, l.interaction_status, l.replying_now,
                m.direction, m.\`from\` AS sender, m.channel, m.message_type, m.created_at AS last_at,
                LEFT(m.message, 140) AS last_text
           FROM (SELECT lead_id, MAX(id) AS mid FROM messages WHERE created_at >= :since GROUP BY lead_id) x
           JOIN messages m ON m.id = x.mid
           JOIN leads l ON l.id = x.lead_id`, r),
      q(`SELECT lead_id, rep_id, amount_paid, converted_at FROM rep_conversions`),
      q(`SELECT campaign_id FROM campaigns
          WHERE status IN ('queued','scheduled','running','paused')
             OR (status IN ('completed','aborted') AND started_at < :e
                 AND (completed_at IS NULL OR completed_at >= :s))
          ORDER BY (status = 'running') DESC, started_at DESC
          LIMIT 15`, r),
    ]);

    const settings = perf.settings;
    const repName = new Map(reps.map((x) => [x.id, x.name]));
    const nameOf = (id) => (id ? repName.get(id) || `Rep #${id}` : "Unassigned");

    // ── Conversions by lead ──
    const convByLead = new Map();
    for (const c of conversions) {
      if (!convByLead.has(c.lead_id)) convByLead.set(c.lead_id, []);
      convByLead.get(c.lead_id).push({ at: new Date(c.converted_at), amount: n(c.amount_paid) });
    }
    const lastDir = new Map(lastMsgs.map((m) => [m.id, m.direction]));

    // ── Waiting now ──
    const waitingRows = lastMsgs
      .filter((m) => m.direction === "IN")
      .map((m) => ({
        lead_id: m.id, name: m.name || null, phone: m.phone || null,
        rep_id: m.assigned_to || null, rep_name: nameOf(m.assigned_to),
        channel: m.channel, stage: m.stage, interaction_status: m.interaction_status,
        replying_now: m.replying_now,
        last_at: m.last_at,
        last_text: m.last_text || (m.message_type && m.message_type !== "text" ? `[${m.message_type}]` : ""),
        wait_work_min: Math.round(workMinutes(m.last_at, now, settings)),
        wait_total_min: Math.round((now - new Date(m.last_at)) / 60000),
        hot: HOT_STATUSES.includes(m.interaction_status),
      }))
      .sort((a, b) => b.wait_work_min - a.wait_work_min || b.wait_total_min - a.wait_total_min);

    // ── Campaigns, split by rep ──
    const campIds = campaignList.map((c) => c.campaign_id);
    let campRows = [];
    if (campIds.length) {
      campRows = await q(
        `SELECT c.campaign_id, c.name, c.status, c.started_at, c.completed_at, c.replying_now,
                cr.lead_id, cr.status AS cr_status, cr.sent_at, cr.replied_at, l.assigned_to,
                CASE WHEN cr.replied_at IS NOT NULL THEN
                  (SELECT MIN(m.created_at) FROM messages m
                    WHERE m.lead_id = cr.lead_id AND m.direction = 'OUT' AND m.\`from\` = 'rep'
                      AND m.created_at >= cr.replied_at) END AS first_rep_at,
                CASE WHEN cr.replied_at IS NOT NULL THEN
                  (SELECT MIN(m.created_at) FROM messages m
                    WHERE m.lead_id = cr.lead_id AND m.direction = 'OUT' AND m.\`from\` = 'bot'
                      AND m.created_at >= cr.replied_at) END AS first_bot_at
           FROM campaigns c
           JOIN campaign_recipients cr ON cr.campaign_id = c.campaign_id
           JOIN leads l ON l.id = cr.lead_id
          WHERE c.campaign_id IN (:ids)`,
        { ids: campIds }
      );
    }
    const blank = () => ({
      leads: 0, sent: 0, not_sent: 0, failed: 0, replied: 0, answered_by_rep: 0, fiza_only: 0,
      not_answered: 0, needs_reply: 0, sales: 0, revenue: 0, _mins: [],
    });
    const add = (acc, row) => {
      acc.leads++;
      const sent = !!row.sent_at || ["sent", "delivered", "read", "replied"].includes(row.cr_status);
      if (sent) acc.sent++;
      else if (["failed", "opted_out"].includes(row.cr_status)) acc.failed++;
      else acc.not_sent++;
      const replied = !!row.replied_at || row.cr_status === "replied";
      if (replied) {
        acc.replied++;
        if (row.first_rep_at) {
          acc.answered_by_rep++;
          if (row.replied_at) acc._mins.push(workMinutes(row.replied_at, row.first_rep_at, settings));
        } else if (row.first_bot_at) acc.fiza_only++;
        else acc.not_answered++;
        if (lastDir.get(row.lead_id) === "IN") acc.needs_reply++;
      }
      const since = row.sent_at ? new Date(row.sent_at) : row.started_at ? new Date(row.started_at) : null;
      const conv = (convByLead.get(row.lead_id) || []).filter((c) => !since || c.at >= since);
      if (conv.length) { acc.sales++; acc.revenue += conv.reduce((s, c) => s + c.amount, 0); }
    };
    const finish = (acc) => {
      const { _mins, ...rest } = acc;
      return {
        ...rest,
        revenue: Math.round(rest.revenue),
        reply_rate_pct: pct(rest.replied, rest.sent),
        rep_answer_pct: pct(rest.answered_by_rep, rest.replied),
        conversion_pct: pct(rest.sales, rest.replied),
        median_rep_reply_min: median(_mins),
      };
    };

    const campMap = new Map();
    const repCamp = new Map(); // rep_id -> totals across campaigns
    for (const row of campRows) {
      if (!campMap.has(row.campaign_id)) {
        campMap.set(row.campaign_id, {
          meta: { campaign_id: row.campaign_id, name: row.name, status: row.status, started_at: row.started_at,
                  completed_at: row.completed_at, replying_now: row.replying_now || null },
          total: blank(), byRep: new Map(),
        });
      }
      const c = campMap.get(row.campaign_id);
      const rid = row.assigned_to || 0;
      if (!c.byRep.has(rid)) c.byRep.set(rid, blank());
      add(c.total, row);
      add(c.byRep.get(rid), row);
      if (!repCamp.has(rid)) repCamp.set(rid, blank());
      add(repCamp.get(rid), row);
    }
    const campaigns = campIds.filter((id) => campMap.has(id)).map((id) => {
      const c = campMap.get(id);
      return {
        ...c.meta, ...finish(c.total),
        by_rep: [...c.byRep.entries()]
          .map(([rid, acc]) => ({ rep_id: rid || null, rep_name: nameOf(rid), ...finish(acc) }))
          .sort((a, b) => b.needs_reply - a.needs_reply || b.leads - a.leads),
      };
    });

    // ── Per rep ──
    const perfById = new Map(perf.reps.map((x) => [x.rep_id, x]));
    const wlById = new Map(workload.map((x) => [x.rep_id, x]));
    const taskById = new Map(tasks.map((x) => [x.rep_id, x]));
    const waitByRep = new Map();
    for (const w of waitingRows) {
      const k = w.rep_id || 0;
      if (!waitByRep.has(k)) waitByRep.set(k, { waiting: 0, over_1h: 0, over_24h: 0, hot_waiting: 0, oldest_work_min: 0 });
      const b = waitByRep.get(k);
      b.waiting++;
      if (w.wait_work_min > 60) b.over_1h++;
      if (w.wait_total_min > 1440) b.over_24h++;
      if (w.hot) b.hot_waiting++;
      b.oldest_work_min = Math.max(b.oldest_work_min, w.wait_work_min);
    }

    const repRows = reps
      .filter((x) => x.role === "rep" || wlById.has(x.id) || perfById.has(x.id))
      .map((x) => {
        const wl = wlById.get(x.id) || {};
        const p = perfById.get(x.id);
        const t = taskById.get(x.id) || {};
        const wt = waitByRep.get(x.id) || { waiting: 0, over_1h: 0, over_24h: 0, hot_waiting: 0, oldest_work_min: 0 };
        const cp = repCamp.get(x.id);
        return {
          rep_id: x.id, name: x.name, role: x.role, active: x.status === "active",
          workload: {
            assigned: n(wl.assigned), open_pipeline: n(wl.open_pipeline), new_in_range: n(wl.new_in_range),
            hot: n(wl.hot), quiet_7d: n(wl.quiet_7d),
            pipeline: { new: n(wl.st_new), interested: n(wl.st_interested), followup: n(wl.st_followup),
                        converted: n(wl.st_converted), lost: n(wl.st_lost) },
            ...wt,
            open_tasks: n(t.open_tasks), overdue_tasks: n(t.overdue_tasks),
          },
          perf: p ? {
            conversations: p.conversations, messages_sent: p.messages_sent, customer_turns: p.customer_turns,
            median_reply_min: p.response.median_min, within_sla_pct: p.response.within_sla_pct,
            first_reply_median_min: p.first_reply_median_min,
            unanswered: p.unanswered, answered_by_fiza_pct: p.answered_by_fiza_pct,
            sales: p.sales, revenue: p.revenue, conversion_pct: p.conversion_pct,
            lead_to_sale_pct: p.lead_to_sale_pct, active_hours: p.active_hours,
            daily_sales: p.daily.map((d) => d.sales),
          } : null,
          campaigns: cp ? finish(cp) : null,
        };
      })
      .filter((x) => x.active || x.workload.assigned || x.perf?.conversations || x.perf?.sales)
      .sort((a, b) => b.workload.waiting - a.workload.waiting || (b.perf?.sales || 0) - (a.perf?.sales || 0));

    const unassignedWait = waitByRep.get(0);

    // ── Daily series ──
    const toMap = (rows, key = "c") => new Map(rows.map((x) => [String(x.d instanceof Date ? x.d.toISOString().slice(0, 10) : x.d).slice(0, 10), n(x[key])]));
    const ld = toMap(leadsDaily), idl = toMap(inDaily), sd = toMap(salesDaily), rd = toMap(salesDaily, "rev");
    const daily = perf.days.map((d) => ({ date: d, new_leads: ld.get(d) || 0, inbound: idl.get(d) || 0, sales: sd.get(d) || 0, revenue: Math.round(rd.get(d) || 0) }));

    const k = (rows) => rows[0] || {};
    const lk = k(leadKpi), mk = k(msgKpi), sk = k(saleKpi);
    const totalWaiting = waitingRows.length;

    res.json({
      from, to, generated_at: now, settings,
      kpis: {
        new_leads: n(lk.cur), new_leads_prev: n(lk.prev),
        inbound: n(mk.inbound), inbound_prev: n(mk.inbound_prev),
        rep_sent: n(mk.rep_sent), fiza_sent: n(mk.fiza_sent),
        sales: n(sk.sales), sales_prev: n(sk.sales_prev),
        revenue: Math.round(n(sk.revenue)), revenue_prev: Math.round(n(sk.revenue_prev)),
        waiting_now: totalWaiting,
        waiting_over_1h: waitingRows.filter((w) => w.wait_work_min > 60).length,
        hot_waiting: waitingRows.filter((w) => w.hot).length,
        unassigned_waiting: unassignedWait ? unassignedWait.waiting : 0,
        open_tasks: tasks.reduce((s, t) => s + n(t.open_tasks), 0),
        overdue_tasks: tasks.reduce((s, t) => s + n(t.overdue_tasks), 0),
      },
      team: perf.team,
      reps: repRows,
      campaigns,
      waiting: waitingRows.slice(0, 30),
      funnel: {
        stages: stages.map((x) => ({ key: x.stage, count: n(x.c) })),
        statuses: statuses.map((x) => ({ key: x.status, count: n(x.c) })),
      },
      sources: sources.map((x) => ({ source: x.source, count: n(x.c) })),
      daily,
    });
  } catch (err) {
    console.error("❌ Admin overview error:", err);
    res.status(500).json({ error: "Failed to load dashboard" });
  }
});

module.exports = router;
