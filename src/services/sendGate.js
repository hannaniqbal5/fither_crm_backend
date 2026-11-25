/**
 * sendGate.js — the single governance layer every PROACTIVE sender consults
 * before messaging a contact.
 *
 * WHY
 *   Campaign, follow-up and automation each policed only their own sends, so a
 *   contact could receive one of each in a day and every system thought it was
 *   within limits. And a number's BAN risk is driven by its TOTAL outbound
 *   (reactive replies + proactive sends) — no single sender saw that total.
 *   This gate unifies both:
 *     • per-contact  : combined proactive frequency (day / 7d / min-gap) + a
 *                      reply-gate (stop after N unanswered proactive messages).
 *     • per-number   : a daily ceiling on TOTAL outbound (reactive + proactive);
 *                      when hit, proactive is paused while real replies continue.
 *
 * REACTIVE sends (Fiza replies, rep replies) never call this gate — you must
 * always be able to answer a customer. They DO count toward the per-number
 * total, because that load is read from the unified `messages` log.
 *
 * MODES (layer_system_settings.gate_mode):
 *   'monitor' (default) — logs what it WOULD block, but allows everything.
 *   'enforce'           — actually blocks.
 *
 * FAIL-OPEN: any unexpected error allows the send (the senders' own legacy caps
 * remain as a backstop) — a gate bug must never silently halt all messaging.
 */

const sequelize = require("../config/database");

const DEFAULTS = {
  gate_mode:                     "monitor", // monitor | enforce
  proactive_max_per_contact_day: 1,
  proactive_max_per_contact_7d:  3,
  proactive_min_gap_hours:       24,
  proactive_stop_after_no_reply: 2,
  proactive_quiet_start:         9,   // PKT hour, inclusive
  proactive_quiet_end:           21,  // PKT hour, exclusive
  number_total_daily_softcap:    800, // reactive + proactive, per number/day
};

const PKT_OFFSET_MS = 5 * 60 * 60 * 1000; // +05:00
function pktHour() {
  return new Date(Date.now() + PKT_OFFSET_MS).getUTCHours();
}
// Start of the current PKT day as a UTC Date, so the per-number daily window
// lines up with the PKT quiet-hours window (instead of server-local midnight).
function pktDayStart() {
  const nowPkt = new Date(Date.now() + PKT_OFFSET_MS);
  const ms = Date.UTC(nowPkt.getUTCFullYear(), nowPkt.getUTCMonth(), nowPkt.getUTCDate()) - PKT_OFFSET_MS;
  return new Date(ms);
}

// Cache settings for 60s so the gate doesn't hit the DB on every single send.
let _cache = { t: 0, vals: null };
async function getSettings() {
  if (_cache.vals && Date.now() - _cache.t < 60 * 1000) return _cache.vals;
  const vals = { ...DEFAULTS };
  try {
    const [rows] = await sequelize.query(
      `SELECT setting_key, setting_value FROM layer_system_settings
        WHERE setting_key = 'gate_mode'
           OR setting_key = 'number_total_daily_softcap'
           OR setting_key LIKE 'proactive_%'`
    );
    rows.forEach((r) => {
      if (!(r.setting_key in vals)) return;
      vals[r.setting_key] =
        r.setting_key === "gate_mode" ? r.setting_value : Number(r.setting_value);
    });
  } catch (e) {
    console.warn("[sendGate] settings load failed, using defaults:", e.message);
  }
  _cache = { t: Date.now(), vals };
  return vals;
}

// Reasons that block in EVERY mode — a contact who opted out / is on the DNC
// list must never get a proactive message, even while the gate is in monitor.
const HARD_BLOCK_REASONS = new Set(["opted_out", "on_dnc"]);

function _decide(settings, reason) {
  if (reason && HARD_BLOCK_REASONS.has(reason)) {
    return { allowed: false, mode: settings.gate_mode === "enforce" ? "enforce" : "hard_block", reason };
  }
  // In monitor mode we never block — we just record what we WOULD have done.
  if (settings.gate_mode !== "enforce") {
    if (reason) console.warn(`[sendGate] MONITOR — would block (${reason})`);
    return { allowed: true, mode: "monitor", wouldBlock: reason || null };
  }
  return reason
    ? { allowed: false, mode: "enforce", reason }
    : { allowed: true, mode: "enforce" };
}

/**
 * canSendProactive — ask before any proactive send.
 * @param {object} person   People row (needs id; uses interaction_status)
 * @param {object} opts     { accountId }
 * @returns {Promise<{allowed:boolean, mode:string, reason?:string, wouldBlock?:string}>}
 */
async function canSendProactive(person, { accountId = null, source = null } = {}) {
  const decision = await evaluate(person, { accountId });
  logDecision(person, accountId, source, decision);
  return decision;
}

// Every decision goes to send_gate_log (fire-and-forget), so the limits can
// be reviewed — report() below — before gate_mode is switched to 'enforce'.
function logDecision(person, accountId, source, d) {
  const reason = d.allowed ? d.wouldBlock || null : d.reason || null;
  require("../monitor/tables").ensureTables(sequelize)
    .then(() => sequelize.query(
      `INSERT INTO send_gate_log (lead_id, account_id, source, mode, allowed, reason)
       VALUES (:lead, :acc, :src, :mode, :allowed, :reason)`,
      { replacements: { lead: (person && person.id) || null, acc: accountId || null, src: source ? String(source).slice(0, 30) : null, mode: String(d.mode || "").slice(0, 20), allowed: d.allowed ? 1 : 0, reason: reason ? String(reason).slice(0, 60) : null } }
    ))
    .catch((e) => console.warn("[sendGate] log failed:", e.message));
}

async function evaluate(person, { accountId = null } = {}) {
  try {
    if (!person || !person.id) return { allowed: false, mode: "enforce", reason: "no_person" };
    const s = await getSettings();

    // 1. Opt-out / DNC — hard stop in EVERY mode (incl. monitor).
    if (person.interaction_status === "opted_out") return _decide(s, "opted_out");
    const [dnc] = await sequelize.query(
      "SELECT 1 FROM dnc_list WHERE lead_id = ? LIMIT 1",
      { replacements: [person.id] }
    );
    if (dnc.length) return _decide(s, "on_dnc");

    // 2. Quiet hours (PKT).
    const h = pktHour();
    if (h < s.proactive_quiet_start || h >= s.proactive_quiet_end) {
      return _decide(s, "quiet_hours");
    }

    // 3. Per-contact frequency (proactive only) — min-gap, daily, 7-day.
    const [freq] = await sequelize.query(
      `SELECT
         SUM(created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)) AS in_gap,
         SUM(created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY))  AS in_day,
         SUM(created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY))  AS in_week
       FROM proactive_send_log WHERE lead_id = ?`,
      { replacements: [s.proactive_min_gap_hours, person.id] }
    );
    const f = freq[0] || {};
    if (Number(f.in_gap || 0) > 0)                              return _decide(s, `min_gap_${s.proactive_min_gap_hours}h`);
    if (Number(f.in_day || 0)  >= s.proactive_max_per_contact_day)  return _decide(s, "per_contact_daily_cap");
    if (Number(f.in_week || 0) >= s.proactive_max_per_contact_7d)   return _decide(s, "per_contact_7d_cap");

    // 4. Reply-gate — count proactive sends since the lead's LAST inbound. If we
    //    have already poked them N times with no reply, stop (the 2026
    //    unanswered-message flag is the biggest ban driver).
    const [lastIn] = await sequelize.query(
      "SELECT MAX(created_at) AS t FROM messages WHERE lead_id = ? AND direction = 'IN'",
      { replacements: [person.id] }
    );
    const lastInboundAt = lastIn[0]?.t || null;
    const [since] = await sequelize.query(
      lastInboundAt
        ? "SELECT COUNT(*) AS c FROM proactive_send_log WHERE lead_id = ? AND created_at > ?"
        : "SELECT COUNT(*) AS c FROM proactive_send_log WHERE lead_id = ?",
      { replacements: lastInboundAt ? [person.id, lastInboundAt] : [person.id] }
    );
    if (Number(since[0]?.c || 0) >= s.proactive_stop_after_no_reply) {
      return _decide(s, "no_reply_dormant");
    }

    // 5. Per-number COMBINED daily load (reactive + proactive). Reading the
    //    unified messages log means replies count too — exactly the "combined
    //    load shouldn't ban the number" guard.
    if (accountId) {
      const [tot] = await sequelize.query(
        `SELECT COUNT(*) AS c FROM messages
          WHERE whatsapp_account_id = ? AND direction = 'OUT'
            AND created_at >= ?`,
        { replacements: [accountId, pktDayStart()] }
      );
      if (Number(tot[0]?.c || 0) >= s.number_total_daily_softcap) {
        return _decide(s, "number_daily_softcap");
      }
    }

    return _decide(s, null); // allowed
  } catch (e) {
    console.error("[sendGate] check failed (allowing — fail open):", e.message);
    return { allowed: true, mode: "error_open" };
  }
}

/**
 * logProactiveSend — record an ACTUAL proactive send so the per-contact budget
 * is accurate. Call only after a successful proactive send.
 */
/**
 * isAutomationPaused — master kill-switch for AUTOMATED sends (Fiza auto-reply,
 * follow-up auto-send, automation-rule sends). Does NOT affect campaigns or a
 * rep's own messages. Read directly (no cache) so the admin toggle takes effect
 * immediately. Fails OPEN (returns false) so a read error never freezes sending.
 */
async function isAutomationPaused() {
  try {
    const [rows] = await sequelize.query(
      "SELECT setting_value FROM layer_system_settings WHERE setting_key = 'automation_sends_paused' LIMIT 1"
    );
    return String(rows[0]?.setting_value || "0") === "1";
  } catch (e) {
    return false;
  }
}

async function logProactiveSend({ leadId, accountId = null, source, templateKey = null }) {
  try {
    if (!leadId) return;
    await sequelize.query(
      `INSERT INTO proactive_send_log (lead_id, whatsapp_account_id, source, template_key)
       VALUES (?, ?, ?, ?)`,
      { replacements: [leadId, accountId, source || "unknown", templateKey] }
    );
  } catch (e) {
    console.error("[sendGate] logProactiveSend failed:", e.message);
  }
}

/**
 * report(days) — what the gate did over the last N days: how many proactive
 * sends it checked, how many it blocked, and how many it WOULD have blocked
 * (monitor mode), by reason and by sender. Read this before enforcing.
 */
async function report(days = 7) {
  await require("../monitor/tables").ensureTables(sequelize);
  const d = Math.max(1, Math.min(90, Number(days) || 7));
  const [[tot]] = await sequelize.query(
    `SELECT COUNT(*) AS checked,
            SUM(allowed = 0) AS blocked,
            SUM(allowed = 1 AND reason IS NOT NULL) AS would_block,
            COUNT(DISTINCT lead_id) AS women
       FROM send_gate_log WHERE created_at >= DATE_SUB(NOW(), INTERVAL :d DAY)`,
    { replacements: { d } }
  );
  const [byReason] = await sequelize.query(
    `SELECT reason, SUM(allowed = 0) AS blocked, SUM(allowed = 1) AS would_block, COUNT(*) AS total
       FROM send_gate_log
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL :d DAY) AND reason IS NOT NULL
      GROUP BY reason ORDER BY total DESC`,
    { replacements: { d } }
  );
  const [bySource] = await sequelize.query(
    `SELECT COALESCE(source, 'unknown') AS source, COUNT(*) AS checked,
            SUM(reason IS NOT NULL) AS would_or_did_block
       FROM send_gate_log WHERE created_at >= DATE_SUB(NOW(), INTERVAL :d DAY)
      GROUP BY source ORDER BY checked DESC`,
    { replacements: { d } }
  );
  const settings = await getSettings();
  const checked = Number(tot.checked || 0);
  const affected = Number(tot.blocked || 0) + Number(tot.would_block || 0);
  return {
    days: d,
    gate_mode: settings.gate_mode,
    limits: settings,
    checked,
    women: Number(tot.women || 0),
    blocked: Number(tot.blocked || 0),
    would_block: Number(tot.would_block || 0),
    share_affected_pct: checked ? Math.round((affected / checked) * 1000) / 10 : 0,
    by_reason: byReason,
    by_source: bySource,
  };
}

/** setMode('monitor' | 'enforce') — the admin switch. Takes effect at once. */
async function setMode(mode) {
  if (!["monitor", "enforce"].includes(mode)) throw Object.assign(new Error("mode must be monitor or enforce"), { status: 400 });
  await sequelize.query(
    `INSERT INTO layer_system_settings (setting_key, setting_value, description)
     VALUES ('gate_mode', :m, 'Send gate: monitor (log only) or enforce (block)')
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
    { replacements: { m: mode } }
  );
  _cache = { t: 0, vals: null };
  return { gate_mode: mode };
}

module.exports = { canSendProactive, logProactiveSend, isAutomationPaused, report, setMode };
