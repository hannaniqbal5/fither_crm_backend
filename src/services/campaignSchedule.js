/**
 * campaignSchedule.js — "when will this campaign send?" (Nov 2026).
 *
 * Uses the same rules as the sender (broadcast/broadcastWorker.js): start
 * time, the daily send window (Pakistan time), the number's shared daily cap,
 * the campaign's own cap / slow start, a paused number. Also says plainly
 * what would stop it: test mode (OUTBOUND_DISABLED), a disconnected number,
 * the sender not running, internal numbers.
 *
 *   sendInfo(campaign) → { state, starts_at, next_send_at, finish_estimate_min,
 *                          headline, warnings: [] }   (times in UTC ISO)
 */
const sequelize = require("../config/database");

const PKT_MS = 5 * 3600 * 1000;
const pktParts = (d) => {
  const x = new Date(d.getTime() + PKT_MS);
  return { y: x.getUTCFullYear(), m: x.getUTCMonth(), d: x.getUTCDate(), hm: x.toISOString().slice(11, 16) };
};
const fromPkt = (y, m, d, hm) => {
  const [h, mi] = hm.split(":").map(Number);
  return new Date(Date.UTC(y, m, d, h, mi) - PKT_MS);
};
const digits = (p) => String(p || "").replace(/\D/g, "");

/** First moment at or after `from` inside the daily window (PKT HH:MM). */
function nextInWindow(from, startHM = "09:00", endHM = "21:00") {
  const p = pktParts(from);
  if (p.hm >= startHM && p.hm <= endHM) return from;
  if (p.hm < startHM) return fromPkt(p.y, p.m, p.d, startHM);
  return fromPkt(p.y, p.m, p.d + 1, startHM);
}

/** "Today 6:02 PM" / "Tomorrow 9:00 AM" / "Thu 27 Nov, 9:00 AM" in Pakistan time. */
function pktLabel(d, now = new Date()) {
  if (!d) return null;
  const day = (x) => pktParts(x);
  const a = day(d), b = day(now), t = day(new Date(now.getTime() + 86400000));
  const time = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Karachi", hour: "numeric", minute: "2-digit" }).format(d);
  if (a.y === b.y && a.m === b.m && a.d === b.d) return `Today ${time}`;
  if (a.y === t.y && a.m === t.m && a.d === t.d) return `Tomorrow ${time}`;
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Karachi", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true }).format(d);
}

async function sendInfo(c, now = new Date()) {
  const W = require("../broadcast/broadcastWorker");
  const win = [String(c.send_window_start || "09:00").slice(0, 5), String(c.send_window_end || "21:00").slice(0, 5)];
  const out = { state: c.status, starts_at: null, next_send_at: null, finish_estimate_min: null, headline: "", warnings: [] };

  const [queued] = await sequelize.query(
    `SELECT l.phone, l.whatsapp_jid FROM campaign_recipients cr JOIN leads l ON l.id = cr.lead_id
      WHERE cr.campaign_id = :id AND cr.status = 'queued'`,
    { replacements: { id: c.campaign_id } }
  );
  const left = queued.length;

  // ── Things that would stop it, whatever the clock says ──
  if (process.env.OUTBOUND_DISABLED === "1") {
    const allow = new Set(String(process.env.OUTBOUND_ALLOWLIST || "").split(",").map(digits).filter(Boolean));
    const blocked = queued.filter((r) => !allow.has(digits(r.phone))).length;
    out.warnings.push(blocked
      ? `Test mode is on (OUTBOUND_DISABLED=1): ${blocked} of ${left} will be blocked. Only the ${allow.size} number(s) in OUTBOUND_ALLOWLIST receive messages.`
      : `Test mode is on (OUTBOUND_DISABLED=1): all ${left} are on the allow-list, so they will receive it.`);
  }
  const excluded = queued.filter((r) => W.EXCLUDED_PHONES.has(digits(r.phone).slice(-10))).length;
  if (excluded) out.warnings.push(`${excluded} is an internal / admin number and will be skipped.`);
  const accountId = await W.pickWAAccount(c.whatsapp_account_id, c.campaign_id).catch(() => null);
  try {
    const { isAccountConnected } = require("../whatsapp/baileysClient");
    if (accountId && !isAccountConnected(accountId)) out.warnings.push(`WhatsApp number #${accountId} is not connected. Nothing sends until it is.`);
  } catch {}
  // Is the sender alive? In this process: its own heartbeat. Otherwise the
  // heartbeat row's age, computed by the database (no clock / zone mix-ups).
  try {
    const local = require("../monitor/jobs")._state.get("broadcast");
    let ageSec = local && local.lastStart ? (Date.now() - new Date(local.lastStart).getTime()) / 1000 : null;
    if (ageSec === null) {
      const [[hb]] = await sequelize.query(
        "SELECT MIN(TIMESTAMPDIFF(SECOND, updated_at, NOW())) AS age FROM job_heartbeats WHERE name = 'broadcast'"
      );
      ageSec = hb && hb.age != null ? Number(hb.age) : null;
    }
    if (ageSec === null) out.warnings.push("The campaign sender hasn't run yet. Is the CRM server running?");
    else if (ageSec > 180) out.warnings.push(`The campaign sender last ran ${Math.round(ageSec / 60)} min ago. Is the CRM server running?`);
  } catch {}

  // ── When ──
  if (c.status === "draft") { out.headline = "Not started yet."; return out; }
  if (["completed", "aborted", "failed"].includes(c.status) || (c.status === "running" && !left)) {
    out.state = "done"; out.headline = left ? `Stopped (${c.status}).` : "Everyone has been sent to."; return out;
  }
  if (c.status === "paused") { out.headline = "Paused. Nothing sends until you resume it."; return out; }

  let from = now;
  if (c.status === "scheduled" && c.scheduled_start_at) {
    const start = new Date(c.scheduled_start_at);
    out.starts_at = start.toISOString();
    if (start > now) from = start;
    else out.warnings.push(`It was due to start ${pktLabel(start, now)} but hasn't yet. The sender checks every 5 seconds, so the CRM server is probably not running.`);
  }

  // Daily caps (only matter for today).
  let capNote = "";
  if (accountId) {
    try {
      const acct = await W.getAccountSettings(accountId);
      if (acct.paused_until && new Date(acct.paused_until) > from) {
        from = new Date(acct.paused_until);
        capNote = ` (number paused until ${pktLabel(from, now)})`;
      }
      const sharedCap = Number(acct.shared_daily_cap || 400);
      if ((await W.getAccountSentToday(accountId)) >= sharedCap && pktParts(from).d === pktParts(now).d) {
        const p = pktParts(now); from = fromPkt(p.y, p.m, p.d + 1, win[0]);
        capNote = ` (this number's ${sharedCap}/day limit is used up today)`;
      }
      const { cap } = await W.getCampaignCapToday(c);
      if (cap && (await W.getCampaignSentToday(c.campaign_id)) >= cap && pktParts(from).d === pktParts(now).d) {
        const p = pktParts(now); from = fromPkt(p.y, p.m, p.d + 1, win[0]);
        capNote = ` (today's limit of ${cap} for this campaign is reached)`;
      }
    } catch {}
  }

  const next = nextInWindow(from, win[0], win[1]);
  out.next_send_at = next.toISOString();
  const avgSec = ((Number(c.delay_min_seconds) || 8) + (Number(c.delay_max_seconds) || 15)) / 2;
  out.finish_estimate_min = Math.max(1, Math.round((left * avgSec) / 60));
  const pace = left > 1 ? ` One every ${c.delay_min_seconds || 8}–${c.delay_max_seconds || 15} s, about ${out.finish_estimate_min} min for all ${left}.` : "";
  out.headline = next - now <= 60 * 1000
    ? `Sending now.${pace}`
    : `First message: ${pktLabel(next, now)}${capNote}.${pace}` + (next.getTime() !== from.getTime() ? ` (sends only between ${win[0]} and ${win[1]})` : "");
  return out;
}

module.exports = { sendInfo, nextInWindow, pktLabel };
