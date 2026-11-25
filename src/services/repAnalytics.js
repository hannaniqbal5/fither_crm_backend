/**
 * repAnalytics.js — sales rep analytics for any date range.
 *
 * Reads live from messages / leads / rep_conversions / rep_sessions, so it
 * works for any range (not only days the nightly snapshot ran).
 *
 * How things are counted
 *   Customer turn   = her first message after our last reply (a burst of 5
 *                     messages is ONE turn, not five).
 *   Reply time      = from her turn to the first reply by a REP (Fiza replies
 *                     don't count as the rep's reply). Only working hours count
 *                     (9 AM – 9 PM PKT by default): 8:55 PM → 9:05 AM = 10 min.
 *   Fiza answered   = Fiza replied first and no rep replied before her next turn.
 *   Unanswered      = nobody replied at all.
 *   Conversations   = chats where the rep sent at least one message.
 *   Conversion rate = sales ÷ conversations.
 *   Lead → sale     = new leads given to the rep in the range that have
 *                     bought by now.
 *   Turns are credited to the rep the lead is assigned to now.
 */

const { QueryTypes } = require("sequelize");
const { minutesInWindowFast, nextInWindowInstant } = require("../utils/workingHours");

const PKT_MS = 5 * 3600 * 1000;
const MAX_DAYS = 92;
const LOOKAHEAD_MS = 3 * 86400 * 1000; // replies to late turns may land after the range

const pktDate = (d) => new Date(new Date(d).getTime() + PKT_MS).toISOString().slice(0, 10);
const pktMidnightUtc = (ymd) => new Date(Date.parse(`${ymd}T00:00:00Z`) - PKT_MS);

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}
const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);
const pct = (a, b) => (b > 0 ? round1((a / b) * 100) : null);

/**
 * Pure: walk one lead's messages (sorted by time) and return its turns.
 * msgs: [{direction, from, rep_id, created_at}]
 */
function turnsForLead(msgs, { rangeStart, rangeEnd, startHour, endHour }) {
  const turns = [];
  let open = null; // current customer turn
  const close = () => { if (open) turns.push(open); open = null; };
  for (const m of msgs) {
    const at = new Date(m.created_at);
    if (m.direction === "IN") {
      if (open && open.botAt) close(); // Fiza answered; her new message is a new turn
      if (!open) open = { at, repReplyAt: null, botAt: null };
      continue;
    }
    if (!open) continue; // proactive message, not a reply
    if (m.from === "rep") {
      open.repReplyAt = at;
      close();
    } else if (m.from === "bot") {
      // Fiza replied; the turn stays open so a rep reply before her next message still counts
      open.botAt = open.botAt || at;
    }
  }
  close();
  return turns
    .filter((t) => t.at >= rangeStart && t.at < rangeEnd)
    .map((t) => {
      const outcome = t.repReplyAt ? "rep" : t.botAt ? "fiza" : "none";
      let minutes = null;
      if (t.repReplyAt) {
        const start = nextInWindowInstant(t.at, startHour, endHour);
        minutes = t.repReplyAt <= start ? 0 : minutesInWindowFast(start, t.repReplyAt, startHour, endHour);
      }
      return { at: t.at, day: pktDate(t.at), outcome, minutes };
    });
}

function summarize(minutesList, slaMin) {
  const s = minutesList.slice().sort((a, b) => a - b);
  const avg = s.length ? s.reduce((a, b) => a + b, 0) / s.length : null;
  return {
    median_min: round1(percentile(s, 50)),
    p90_min: round1(percentile(s, 90)),
    avg_min: round1(avg),
    within_sla_pct: pct(s.filter((x) => x <= slaMin).length, s.length),
  };
}

async function getSettings(sequelize) {
  const rows = await sequelize.query(
    `SELECT setting_key, setting_value FROM layer_system_settings
      WHERE setting_key IN ('rep_shift_start_hour','rep_shift_end_hour','rep_sla_response_minutes')`,
    { type: QueryTypes.SELECT }
  );
  const m = Object.fromEntries(rows.map((r) => [r.setting_key, r.setting_value]));
  return {
    startHour: parseInt(m.rep_shift_start_hour || process.env.REP_SHIFT_START_HOUR || "9", 10),
    endHour: parseInt(m.rep_shift_end_hour || process.env.REP_SHIFT_END_HOUR || "21", 10),
    slaMin: parseInt(m.rep_sla_response_minutes || "5", 10),
  };
}

function parseRange(from, to) {
  const today = pktDate(new Date());
  const toYmd = /^\d{4}-\d{2}-\d{2}$/.test(to || "") ? to : today;
  let fromYmd = /^\d{4}-\d{2}-\d{2}$/.test(from || "") ? from : pktDate(Date.parse(`${toYmd}T00:00:00Z`) - 6 * 86400000);
  if (fromYmd > toYmd) fromYmd = toYmd;
  const days = Math.round((Date.parse(toYmd) - Date.parse(fromYmd)) / 86400000) + 1;
  if (days > MAX_DAYS) fromYmd = pktDate(Date.parse(`${toYmd}T00:00:00Z`) - (MAX_DAYS - 1) * 86400000);
  const rangeStart = pktMidnightUtc(fromYmd);
  const rangeEnd = new Date(pktMidnightUtc(toYmd).getTime() + 86400000);
  return { from: fromYmd, to: toYmd, rangeStart, rangeEnd };
}

/**
 * Main entry. opts: { from, to, channel ('all'|'whatsapp'|'instagram'|'facebook'|'app'), repId }
 */
async function analytics(sequelize, opts = {}) {
  const settings = await getSettings(sequelize);
  const { from, to, rangeStart, rangeEnd } = parseRange(opts.from, opts.to);
  const channel = ["whatsapp", "instagram", "facebook", "app"].includes(opts.channel) ? opts.channel : null;
  const repFilter = opts.repId ? parseInt(opts.repId, 10) : null;
  const lookEnd = new Date(Math.min(Date.now(), rangeEnd.getTime() + LOOKAHEAD_MS));

  const reps = await sequelize.query(
    `SELECT id, name, status, fiza_mode FROM sales_reps WHERE role = 'rep' ${repFilter ? "AND id = :rep" : ""} ORDER BY name`,
    { type: QueryTypes.SELECT, replacements: { rep: repFilter } }
  );
  const byRep = new Map(
    reps.map((r) => [r.id, {
      rep_id: r.id, name: r.name, active: r.status === "active", fiza_mode: r.fiza_mode || "off",
      _turns: [], conversations: new Set(), chats: new Set(), messages_sent: 0, messages_received: 0,
      fiza_messages: 0, new_leads: 0, new_leads_converted: 0, sales: 0, revenue: 0, active_minutes: 0,
      _firstReply: [], daily: new Map(),
    }])
  );
  const day = (r, d) => {
    if (!r.daily.has(d)) r.daily.set(d, { date: d, turns: 0, rep_minutes: [], unanswered: 0, conversations: new Set(), sales: 0, revenue: 0, messages_sent: 0 });
    return r.daily.get(d);
  };

  // Messages on the reps' leads (with lookahead for late replies)
  const chanSql = channel ? "AND m.channel = :channel" : "";
  const msgs = await sequelize.query(
    `SELECT m.lead_id, m.direction, m.\`from\`, m.rep_id, m.created_at, l.assigned_to
       FROM messages m JOIN leads l ON l.id = m.lead_id
      WHERE l.assigned_to IS NOT NULL ${repFilter ? "AND l.assigned_to = :rep" : ""}
        AND m.created_at >= :start AND m.created_at < :lookEnd ${chanSql}
      ORDER BY m.lead_id, m.created_at, m.id`,
    { type: QueryTypes.SELECT, replacements: { start: rangeStart, lookEnd, channel, rep: repFilter } }
  );

  let cur = null, bucket = [];
  const flush = () => {
    if (!bucket.length) return;
    const r = byRep.get(bucket[0].assigned_to);
    if (r) {
      const leadId = bucket[0].lead_id;
      for (const m of bucket) {
        const at = new Date(m.created_at);
        if (at < rangeStart || at >= rangeEnd) continue;
        const d = pktDate(at);
        if (m.direction === "IN") { r.messages_received++; r.chats.add(leadId); }
        else if (m.from === "rep") { r.messages_sent++; r.conversations.add(leadId); day(r, d).conversations.add(leadId); day(r, d).messages_sent++; }
        else if (m.from === "bot") r.fiza_messages++;
      }
      for (const t of turnsForLead(bucket, { rangeStart, rangeEnd, ...settings })) {
        r._turns.push(t);
        const dd = day(r, t.day);
        dd.turns++;
        if (t.outcome === "rep") dd.rep_minutes.push(t.minutes);
        if (t.outcome === "none") dd.unanswered++;
      }
    }
    bucket = [];
  };
  for (const m of msgs) {
    if (m.lead_id !== cur) { flush(); cur = m.lead_id; }
    bucket.push(m);
  }
  flush();

  // Sales
  const sales = await sequelize.query(
    `SELECT rc.rep_id, rc.lead_id, rc.amount_paid, rc.converted_at FROM rep_conversions rc
      WHERE rc.converted_at >= :start AND rc.converted_at < :end ${repFilter ? "AND rc.rep_id = :rep" : ""}`,
    { type: QueryTypes.SELECT, replacements: { start: rangeStart, end: rangeEnd, rep: repFilter } }
  );
  for (const s of sales) {
    const r = byRep.get(s.rep_id);
    if (!r) continue;
    r.sales++; r.revenue += Number(s.amount_paid || 0);
    const dd = day(r, pktDate(s.converted_at)); dd.sales++; dd.revenue += Number(s.amount_paid || 0);
  }

  // New leads given in the range, and how many have bought since; first reply time
  const newLeads = await sequelize.query(
    `SELECT l.id, l.assigned_to,
            COALESCE(l.owner_assigned_at, l.created_at) AS given_at,
            EXISTS(SELECT 1 FROM rep_conversions rc WHERE rc.lead_id = l.id) AS bought,
            (SELECT MIN(created_at) FROM messages WHERE lead_id = l.id AND direction = 'IN') AS first_in,
            (SELECT MIN(created_at) FROM messages WHERE lead_id = l.id AND direction = 'OUT' AND \`from\` = 'rep') AS first_rep
       FROM leads l
      WHERE l.assigned_to IS NOT NULL ${repFilter ? "AND l.assigned_to = :rep" : ""}
        AND l.created_at >= :start AND l.created_at < :end`,
    { type: QueryTypes.SELECT, replacements: { start: rangeStart, end: rangeEnd, rep: repFilter } }
  );
  for (const l of newLeads) {
    const r = byRep.get(l.assigned_to);
    if (!r) continue;
    r.new_leads++;
    if (Number(l.bought)) r.new_leads_converted++;
    if (l.first_in && l.first_rep && new Date(l.first_rep) > new Date(l.first_in)) {
      const st = nextInWindowInstant(new Date(l.first_in), settings.startHour, settings.endHour);
      const fr = new Date(l.first_rep);
      r._firstReply.push(fr <= st ? 0 : minutesInWindowFast(st, fr, settings.startHour, settings.endHour));
    }
  }

  // Time online
  const presence = await sequelize.query(
    `SELECT rep_id, SUM(active_minutes) AS active FROM rep_sessions
      WHERE started_at >= :start AND started_at < :end ${repFilter ? "AND rep_id = :rep" : ""} GROUP BY rep_id`,
    { type: QueryTypes.SELECT, replacements: { start: rangeStart, end: rangeEnd, rep: repFilter } }
  );
  for (const p of presence) { const r = byRep.get(p.rep_id); if (r) r.active_minutes = Number(p.active || 0); }

  // Shape the output
  const allDays = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86400000) allDays.push(new Date(t).toISOString().slice(0, 10));

  const team = { turns: 0, rep: 0, fiza: 0, none: 0, minutes: [], conversations: 0, sales: 0, revenue: 0, new_leads: 0, new_leads_converted: 0, messages_sent: 0 };
  const rows = [];
  for (const r of byRep.values()) {
    const repMin = r._turns.filter((t) => t.outcome === "rep").map((t) => t.minutes);
    const n = r._turns.length;
    const cnt = (o) => r._turns.filter((t) => t.outcome === o).length;
    const row = {
      rep_id: r.rep_id, name: r.name, active: r.active, fiza_mode: r.fiza_mode,
      conversations: r.conversations.size,
      chats_with_messages: r.chats.size,
      messages_sent: r.messages_sent,
      messages_received: r.messages_received,
      customer_turns: n,
      replied_by_rep_pct: pct(cnt("rep"), n),
      answered_by_fiza_pct: pct(cnt("fiza"), n),
      unanswered: cnt("none"),
      unanswered_pct: pct(cnt("none"), n),
      response: summarize(repMin, settings.slaMin),
      first_reply_median_min: round1(percentile(r._firstReply.slice().sort((a, b) => a - b), 50)),
      new_leads: r.new_leads,
      new_leads_converted: r.new_leads_converted,
      lead_to_sale_pct: pct(r.new_leads_converted, r.new_leads),
      sales: r.sales,
      revenue: Math.round(r.revenue),
      conversion_pct: pct(r.sales, r.conversations.size),
      avg_sale: r.sales ? Math.round(r.revenue / r.sales) : null,
      msgs_per_conversation: r.conversations.size ? round1(r.messages_sent / r.conversations.size) : null,
      fiza_share_pct: pct(r.fiza_messages, r.fiza_messages + r.messages_sent),
      active_hours: round1(r.active_minutes / 60),
      sales_per_active_hour: r.active_minutes ? Math.round((r.sales / (r.active_minutes / 60)) * 100) / 100 : null,
      daily: allDays.map((d) => {
        const x = r.daily.get(d);
        if (!x) return { date: d, turns: 0, median_min: null, unanswered: 0, conversations: 0, sales: 0, revenue: 0, messages_sent: 0 };
        return { date: d, turns: x.turns, median_min: round1(percentile(x.rep_minutes.slice().sort((a, b) => a - b), 50)), unanswered: x.unanswered, conversations: x.conversations.size, sales: x.sales, revenue: Math.round(x.revenue), messages_sent: x.messages_sent };
      }),
    };
    const hasActivity = row.customer_turns || row.conversations || row.sales || row.new_leads || row.active_hours;
    if (!hasActivity && !r.active) continue; // hide inactive reps with nothing in range
    rows.push(row);
    team.turns += n; team.rep += cnt("rep"); team.fiza += cnt("fiza"); team.none += cnt("none");
    team.minutes.push(...repMin); team.conversations += row.conversations; team.sales += row.sales;
    team.revenue += row.revenue; team.new_leads += row.new_leads; team.new_leads_converted += row.new_leads_converted;
    team.messages_sent += row.messages_sent;
  }
  rows.sort((a, b) => b.sales - a.sales || b.revenue - a.revenue || (a.response.median_min ?? 1e9) - (b.response.median_min ?? 1e9));

  return {
    from, to, channel: channel || "all", settings,
    team: {
      conversations: team.conversations, customer_turns: team.turns,
      response: summarize(team.minutes, settings.slaMin),
      replied_by_rep_pct: pct(team.rep, team.turns), answered_by_fiza_pct: pct(team.fiza, team.turns),
      unanswered: team.none, unanswered_pct: pct(team.none, team.turns),
      sales: team.sales, revenue: team.revenue, conversion_pct: pct(team.sales, team.conversations),
      new_leads: team.new_leads, lead_to_sale_pct: pct(team.new_leads_converted, team.new_leads),
      messages_sent: team.messages_sent,
    },
    days: allDays,
    reps: rows,
  };
}

module.exports = { analytics, turnsForLead, summarize, parseRange, percentile };
