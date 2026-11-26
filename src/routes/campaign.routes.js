/**
 * campaign.routes.js — admin endpoints for the marketing-campaign system.
 *
 *   GET    /api/campaigns                     — list campaigns
 *   POST   /api/campaigns                     — create a campaign (draft)
 *   GET    /api/campaigns/:id                 — campaign detail + stats
 *   PATCH  /api/campaigns/:id                 — update a draft
 *   DELETE /api/campaigns/:id                 — delete (drafts only)
 *
 *   GET    /api/campaigns/:id/recipients      — paginated recipient list
 *   POST   /api/campaigns/:id/import-group    — pull members from a WA group → recipients
 *   POST   /api/campaigns/:id/add-segment     — add by filter (stage, language, last_activity)
 *   POST   /api/campaigns/:id/start           — flip to 'running'
 *   POST   /api/campaigns/:id/pause           — flip to 'paused'
 *   POST   /api/campaigns/:id/abort           — kill switch
 *
 *   GET    /api/wa-groups                     — list groups the WA account is in
 *
 *   GET    /api/dnc                           — list of opted-out leads
 */

const express = require("express");
const auth    = require("../middleware/auth.middleware");
const { v4: uuidv4 } = require("uuid");
const sequelize = require("../config/database");
const { SalesRep } = require("../../models");
const { listGroups, importGroupMembers } = require("../broadcast/groupImporter");

const router = express.Router();

/**
 * scheduleToUtc — the dashboard sends a `datetime-local` value ("2026-10-25T14:30",
 * no zone) meaning Pakistan time. Interpret zone-less values as Asia/Karachi
 * (UTC+5, no DST) and return a UTC Date (stored as UTC — Sequelize's session
 * time_zone is +00:00, so the worker's `<= NOW()` compares UTC to UTC).
 * Values that carry a zone (Z / ±hh:mm) are honoured as-is.
 * Returns null for empty input; throws on an unparseable value.
 */
function scheduleToUtc(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) {
    if (isNaN(v.getTime())) throw new Error("Invalid scheduled_start_at");
    return v;
  }
  const str = String(v).trim();
  if (!str) return null;
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/);
  if (m) {
    const [, y, mo, d, h = "0", mi = "0", sec = "0"] = m;
    const KARACHI_OFFSET_MS = 5 * 60 * 60 * 1000;
    const dt = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +sec) - KARACHI_OFFSET_MS);
    if (isNaN(dt.getTime())) throw new Error("Invalid scheduled_start_at");
    return dt;
  }
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(str)) {
    const dt = new Date(str);
    if (isNaN(dt.getTime())) throw new Error("Invalid scheduled_start_at");
    return dt;
  }
  throw new Error("Invalid scheduled_start_at");
}

const adminOnly = (req, res, next) => {
  if (req.user?.role !== "admin") return res.status(403).json({ error: "Admin only" });
  next();
};

// Frequency cap (days). Recently-messaged numbers are excluded when building a
// campaign's audience. Keep in sync with broadcastWorker's COOLDOWN_DAYS.
// Set CAMPAIGN_COOLDOWN_DAYS=0 in .env to disable.
const COOLDOWN_DAYS = (() => {
  const n = parseInt(process.env.CAMPAIGN_COOLDOWN_DAYS, 10);
  return Number.isFinite(n) && n >= 0 ? n : 7;
})();
// SQL fragment (or empty) that excludes leads messaged within the cooldown window.
const COOLDOWN_EXCLUDE_SQL = COOLDOWN_DAYS > 0
  ? `AND id NOT IN (
        SELECT lead_id FROM campaign_recipients
         WHERE status IN ('sent','delivered','read','replied')
           AND sent_at IS NOT NULL
           AND sent_at >= DATE_SUB(NOW(), INTERVAL ${COOLDOWN_DAYS} DAY)
      )`
  : "";

// Numbers permanently excluded from EVERY campaign (admin / internal numbers).
// Matched on the last 10 digits so 03055124674, +92 305…, and 923055124674
// all resolve to the same number. Add more via CAMPAIGN_EXCLUDED_PHONES (comma-separated).
const { EXCLUDED_PHONE_LAST10, phoneLast10 } = (() => {
  const set = new Set(["3055124674"]); // 03055124674 — admin's own number
  (process.env.CAMPAIGN_EXCLUDED_PHONES || "").split(",").forEach((p) => {
    const d = String(p).replace(/\D/g, "");
    if (d.length >= 10) set.add(d.slice(-10));
  });
  return { EXCLUDED_PHONE_LAST10: [...set], phoneLast10: (p) => String(p || "").replace(/\D/g, "").slice(-10) };
})();
// SQL that drops those numbers from any audience build (normalises stored phone first).
const EXCLUDE_PHONES_SQL = EXCLUDED_PHONE_LAST10.length
  ? `AND RIGHT(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(phone,''),' ',''),'+',''),'-',''),'(',''), 10)
       NOT IN (${EXCLUDED_PHONE_LAST10.map((n) => `'${n}'`).join(",")})`
  : "";

// ── Campaign sending rules (so the UI can show the active frequency cap) ──
// GET /api/campaigns/rules → { cooldown_days }
router.get("/campaigns/rules", auth, adminOnly, (req, res) => {
  res.json({ cooldown_days: COOLDOWN_DAYS });
});

// ── List active sales reps (for the campaign "Assigned sales rep" dropdown) ──
// GET /api/sales-reps → [{ id, name, email }]
router.get("/sales-reps", auth, adminOnly, async (req, res) => {
  try {
    const reps = await SalesRep.findAll({
      where: { status: "active" },
      attributes: ["id", "name", "email"],
      order: [["name", "ASC"]],
    });
    res.json(reps);
  } catch (err) {
    console.error("❌ list sales-reps:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── List groups the WA account is in ──────────────────────────
router.get("/wa-groups", auth, adminOnly, async (req, res) => {
  try {
    const accountId = parseInt(req.query.account || "1", 10);
    const groups = await listGroups(accountId);
    res.json(groups);
  } catch (err) {
    console.error("❌ [/wa-groups]:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Campaigns CRUD ───────────────────────────────────────────
router.get("/campaigns", auth, adminOnly, async (req, res) => {
  try {
    const cols = `campaign_id, name, channel, language, status,
              total_recipients, sent_count, delivered_count, replied_count, failed_count,
              fizza_auto_reply, scheduled_start_at, send_window_start, send_window_end,
              created_at, started_at, completed_at`;
    // ab_group_id / ab_arm come with migration 047; list still works before it.
    const [rows] = await sequelize.query(
      `SELECT ${cols}, ab_group_id, ab_arm FROM campaigns ORDER BY created_at DESC LIMIT 100`
    ).catch((e) => {
      if (!/ab_group_id|ab_arm/i.test(String(e.message || ""))) throw e;
      return sequelize.query(`SELECT ${cols} FROM campaigns ORDER BY created_at DESC LIMIT 100`);
    });
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── "Who handles replies?" for a campaign ─────────────────────
// The admin's dropdown, stored in campaigns.replying_now (migration 039):
//   null  → "Same as rep"  — replies follow the assigned rep's Fiza level
//   "rep" → "Assist"       — Fiza drafts, the rep approves
//   "fiza"→ "Auto"         — Fiza replies on her own
// The locked guardrails in services/replyOwner.js (health, complaint,
// payment, "talk to a human") still hand those replies to the rep.
// Returns undefined for a value we don't accept.
function parseReplyMode(v) {
  if (v === "fiza" || v === "rep") return v;
  if (v === null || v === "" || v === "inherit") return null;
  return undefined;
}

// Writes the setting and keeps the legacy fizza_auto_reply flag in step, so
// the two can never disagree (replyOwner still reads the old flag as a
// fallback when replying_now is NULL).
async function setCampaignReplyMode(campaignId, mode) {
  try {
    await sequelize.query(
      "UPDATE campaigns SET replying_now = :m, fizza_auto_reply = :f WHERE campaign_id = :id",
      { replacements: { m: mode, f: mode === "fiza" ? 1 : 0, id: campaignId } }
    );
  } catch (e) {
    if (/replying_now/i.test(String(e.message || ""))) {
      throw Object.assign(
        new Error("Run migration 039 first — campaigns.replying_now doesn't exist yet"),
        { status: 503 }
      );
    }
    throw e;
  }
}

// Follow-ups (Touch 2/3): [{ body, delay_days }] — max 2, delay counted from
// the FIRST message, 1–30 days, increasing. Throws a 400 on bad input.
function cleanNurture(steps) {
  if (steps === undefined) return undefined;
  if (steps === null || (Array.isArray(steps) && !steps.length)) return [];
  if (!Array.isArray(steps)) throw Object.assign(new Error("Follow-ups must be a list"), { status: 400 });
  const out = steps.slice(0, 2).map((x) => ({
    body: String((x && x.body) || "").trim(),
    delay_days: parseInt(x && x.delay_days, 10),
  }));
  for (const [i, x] of out.entries()) {
    if (!x.body) throw Object.assign(new Error(`Follow-up ${i + 1} needs a message`), { status: 400 });
    if (!(x.delay_days >= 1 && x.delay_days <= 30)) throw Object.assign(new Error(`Follow-up ${i + 1}: days must be 1–30`), { status: 400 });
    if (i && x.delay_days <= out[i - 1].delay_days) throw Object.assign(new Error("Follow-up 2 must come after follow-up 1"), { status: 400 });
  }
  return out;
}
// Schedule follow-up 1 for women who already got the first message (when
// follow-ups are switched on mid-campaign). Skips first messages too old
// for the plan to still make sense (more than 2 days past due).
async function backfillNurture(campaignId, steps) {
  if (!steps.length) {
    await sequelize.query("UPDATE campaign_recipients SET next_step_at = NULL WHERE campaign_id = :id", { replacements: { id: campaignId } });
    return;
  }
  await sequelize.query(
    `UPDATE campaign_recipients
        SET next_step_at = GREATEST(DATE_ADD(sent_at, INTERVAL :d DAY), NOW())
      WHERE campaign_id = :id AND step = 0 AND next_step_at IS NULL AND sent_at IS NOT NULL
        AND status IN ('sent','delivered','read')
        AND DATE_ADD(sent_at, INTERVAL :d DAY) >= NOW() - INTERVAL 2 DAY`,
    { replacements: { id: campaignId, d: steps[0].delay_days } }
  );
}

// Slow-start ramp: "100,200,350,400" or [100,200,350,400] → "100,200,350,400"
// (1-14 positive steps, each ≤ 1000). null/"" → no ramp. Throws on bad input.
function cleanRamp(v) {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const parts = (Array.isArray(v) ? v : String(v).split(/[,\s]+/)).filter((x) => String(x).trim() !== "");
  const nums = parts.map((x) => parseInt(x, 10));
  if (!nums.length || nums.length > 14 || nums.some((n) => !(n > 0 && n <= 1000))) {
    throw Object.assign(new Error("Slow start must be 1–14 daily numbers between 1 and 1000, e.g. 100,200,350,400"), { status: 400 });
  }
  return nums.join(",");
}
// ramp_caps exists only after migration 045.
let hasRampCol = null;
async function rampColumnExists() {
  if (hasRampCol !== null) return hasRampCol;
  try {
    const [r] = await sequelize.query("SHOW COLUMNS FROM campaigns LIKE 'ramp_caps'");
    hasRampCol = r.length > 0;
  } catch (_) { hasRampCol = false; }
  return hasRampCol;
}

router.post("/campaigns", auth, adminOnly, async (req, res) => {
  try {
    const {
      name, description, channel = "whatsapp", language = "any",
      body, body_variants,                       // Phase 18c — variants array
      media_url,
      media_variants,                            // Per-variant media URLs (parallel to body_variants)
      delay_min_seconds = 8, delay_max_seconds = 15,
      daily_cap = 400, send_window_start = "09:00", send_window_end = "21:00",
      whatsapp_account_id = null,
      source_type = "group_import", source_meta = null,
      assigned_rep_id = null,                    // Phase 19a — rep attribution
      scheduled_start_at = null,                 // Phase 19c — schedule future start
      fizza_auto_reply = false,                  // Phase 20 — Fizza handles replies automatically
      replying_now,                              // "Who handles replies?" — null | "rep" | "fiza"
      ramp_caps,                                 // Slow start, e.g. "100,200,350,400"
      nurture_steps,                             // Follow-ups [{ body, delay_days }]
    } = req.body || {};

    if (!name || !body) {
      return res.status(400).json({ error: "name and body are required" });
    }
    const replyMode = parseReplyMode(replying_now);
    if (replying_now !== undefined && replyMode === undefined) {
      return res.status(400).json({ error: "replying_now must be null (same as rep), \"rep\" (assist) or \"fiza\" (auto)" });
    }
    try { cleanRamp(ramp_caps); cleanNurture(nurture_steps); } catch (e) { return res.status(400).json({ error: e.message }); }
    if (ramp_caps && !(await rampColumnExists())) {
      return res.status(400).json({ error: "Run migration 045_campaign_ramp.sql to use slow start" });
    }
    let schedUtc;
    try {
      schedUtc = scheduleToUtc(scheduled_start_at);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    // Phase 18c — sanitize body_variants array (1-5 non-empty strings)
    let variantsJson = null;
    if (Array.isArray(body_variants)) {
      const clean = body_variants
        .filter(v => typeof v === "string" && v.trim().length > 0)
        .map(v => v.trim())
        .slice(0, 5);
      if (clean.length > 0) variantsJson = JSON.stringify(clean);
    }

    // Per-variant media: array parallel to body_variants. Empty strings allowed
    // (means "no media for this variant"). Slice to same length as body_variants.
    let mediaVariantsJson = null;
    if (Array.isArray(media_variants)) {
      const cleanedMedia = media_variants
        .map(v => (typeof v === "string" ? v.trim() : ""))
        .slice(0, 5);
      mediaVariantsJson = JSON.stringify(cleanedMedia);
    }

    const campaignId = uuidv4();
    await sequelize.query(
      `INSERT INTO campaigns
         (campaign_id, name, description, channel, language, body, body_variants, media_url, media_variants,
          delay_min_seconds, delay_max_seconds, daily_cap,
          send_window_start, send_window_end, whatsapp_account_id, assigned_rep_id,
          fizza_auto_reply,
          scheduled_start_at,
          source_type, source_meta, status, created_by)
       VALUES
         (:id, :name, :desc, :ch, :lang, :body, :variants, :media, :mvariants,
          :dmin, :dmax, :cap,
          :ws, :we, :acc, :arep,
          :fizza,
          :sched,
          :stype, :smeta, 'draft', :rep)`,
      {
        replacements: {
          id: campaignId, name, desc: description || null, ch: channel, lang: language,
          body, variants: variantsJson, media: media_url || null, mvariants: mediaVariantsJson,
          dmin: delay_min_seconds, dmax: delay_max_seconds, cap: daily_cap,
          ws: send_window_start, we: send_window_end, acc: whatsapp_account_id,
          arep: assigned_rep_id || null,
          fizza: fizza_auto_reply ? 1 : 0,
          sched: schedUtc,
          stype: source_type, smeta: source_meta ? JSON.stringify(source_meta) : null,
          rep: req.user.repId,
        },
      }
    );

    let ramp;
    try { ramp = cleanRamp(ramp_caps); } catch (e) { ramp = undefined; }
    if (ramp && (await rampColumnExists())) {
      await sequelize.query("UPDATE campaigns SET ramp_caps = :r WHERE campaign_id = :id", { replacements: { r: ramp, id: campaignId } });
    }

    const followups = cleanNurture(nurture_steps);
    if (followups && followups.length) {
      await sequelize.query(
        "UPDATE campaigns SET nurture_enabled = 1, nurture_steps = :st WHERE campaign_id = :id",
        { replacements: { st: JSON.stringify(followups), id: campaignId } }
      ).catch((e) => console.warn("[campaign create] follow-ups not saved:", e.message));
    }

    let replyModeWarning = null;
    // Blank offer fields on create = no offer (works before migration 048).
    if ((req.body || {}).offer_text || (req.body || {}).offer_ends_at) {
      try { await saveOffer(campaignId, req.body); }
      catch (e) { replyModeWarning = e.message; }
    }
    if (replying_now !== undefined) {
      try {
        await setCampaignReplyMode(campaignId, replyMode);
      } catch (e) {
        // The campaign itself was saved; say why the reply setting wasn't.
        replyModeWarning = e.message;
      }
    }

    // "Compare Fizza on vs off": make the twin straight away.
    let abTest = null;
    if (req.body?.ab_compare_fizza === true) {
      try { abTest = await makeAbTest(campaignId, req.user.repId); }
      catch (e) { replyModeWarning = `A/B test not created: ${e.message}`; }
    }

    const [created] = await sequelize.query(
      `SELECT * FROM campaigns WHERE campaign_id = :id`,
      { replacements: { id: campaignId } }
    );
    if (replyModeWarning) created[0].reply_mode_warning = replyModeWarning;
    if (abTest) created[0].ab_test = abTest;
    res.status(201).json(created[0]);
  } catch (err) {
    console.error("❌ create campaign:", err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/campaigns/:id/settings — change pacing on a draft, running or
// paused campaign (e.g. halve a number's sends after a bad day).
//   { daily_cap?, ramp_caps?, send_window_start?, send_window_end?,
//     delay_min_seconds?, delay_max_seconds? }
router.patch("/campaigns/:id/settings", auth, adminOnly, async (req, res) => {
  try {
    const b = req.body || {};
    const sets = [];
    const rep = { id: req.params.id };
    const int = (v, lo, hi) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= lo && n <= hi ? n : null; };
    const hhmm = (v) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v)) ? String(v) : null);
    if (b.daily_cap !== undefined) {
      const n = int(b.daily_cap, 1, 1000); if (n === null) return res.status(400).json({ error: "daily_cap must be 1–1000" });
      sets.push("daily_cap = :cap"); rep.cap = n;
    }
    if (b.ramp_caps !== undefined) {
      if (!(await rampColumnExists())) return res.status(400).json({ error: "Run migration 045_campaign_ramp.sql to use slow start" });
      sets.push("ramp_caps = :ramp"); rep.ramp = cleanRamp(b.ramp_caps);
    }
    for (const k of ["send_window_start", "send_window_end"]) {
      if (b[k] !== undefined) {
        const t = hhmm(b[k]); if (!t) return res.status(400).json({ error: `${k} must be HH:MM` });
        sets.push(`${k} = :${k}`); rep[k] = t;
      }
    }
    for (const k of ["delay_min_seconds", "delay_max_seconds"]) {
      if (b[k] !== undefined) {
        const n = int(b[k], 1, 3600); if (n === null) return res.status(400).json({ error: `${k} must be 1–3600 seconds` });
        sets.push(`${k} = :${k}`); rep[k] = n;
      }
    }
    let followups;
    if (b.nurture_steps !== undefined) {
      followups = cleanNurture(b.nurture_steps);
      sets.push("nurture_steps = :nsteps", "nurture_enabled = :nen");
      rep.nsteps = followups.length ? JSON.stringify(followups) : null;
      rep.nen = followups.length ? 1 : 0;
    }
    if (b.nurture_paused !== undefined) { sets.push("nurture_paused = :npaused"); rep.npaused = b.nurture_paused ? 1 : 0; }
    if (b.nurture_only_delivered !== undefined) { sets.push("nurture_only_delivered = :nod"); rep.nod = b.nurture_only_delivered ? 1 : 0; }
    if (!sets.length) return res.status(400).json({ error: "Nothing to change" });
    const [[cur]] = await sequelize.query("SELECT delay_min_seconds, delay_max_seconds, status FROM campaigns WHERE campaign_id = :id", { replacements: { id: req.params.id } });
    if (!cur) return res.status(404).json({ error: "Campaign not found" });
    const onlyFollowups = Object.keys(b).every((k) => k.startsWith("nurture_"));
    if (cur.status === "aborted" || (cur.status === "completed" && !onlyFollowups)) {
      return res.status(400).json({ error: `Campaign is ${cur.status}${cur.status === "completed" ? " — only its follow-ups can still be changed" : ""}` });
    }
    const dmin = rep.delay_min_seconds ?? cur.delay_min_seconds;
    const dmax = rep.delay_max_seconds ?? cur.delay_max_seconds;
    if (Number(dmin) > Number(dmax)) return res.status(400).json({ error: "Min delay can't be more than max delay" });
    await sequelize.query(`UPDATE campaigns SET ${sets.join(", ")} WHERE campaign_id = :id`, { replacements: rep });
    if (followups !== undefined) await backfillNurture(req.params.id, followups);
    // A/B pair: keep pacing and follow-ups equal on both sides.
    const sib = await abSiblingId(req.params.id);
    if (sib) {
      await sequelize.query(`UPDATE campaigns SET ${sets.join(", ")} WHERE campaign_id = :sib`, { replacements: { ...rep, sib } });
      if (followups !== undefined) await backfillNurture(sib, followups);
    }
    const [[c]] = await sequelize.query("SELECT * FROM campaigns WHERE campaign_id = :id", { replacements: { id: req.params.id } });
    res.json(c);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Offer + end date (migration 048). { offer_text, offer_ends_at } → saved
// when given. Throws a 400 on a bad date, a 503 before the migration.
async function saveOffer(campaignId, body = {}) {
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  if (!has("offer_text") && !has("offer_ends_at")) return;
  const sets = [];
  const rep = { id: campaignId };
  if (has("offer_text")) {
    sets.push("offer_text = :ot");
    rep.ot = String(body.offer_text || "").trim().slice(0, 300) || null;
  }
  if (has("offer_ends_at")) {
    const v = body.offer_ends_at ? String(body.offer_ends_at).slice(0, 10) : null;
    if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw Object.assign(new Error("offer_ends_at must be YYYY-MM-DD"), { status: 400 });
    sets.push("offer_ends_at = :oe");
    rep.oe = v;
  }
  try {
    await sequelize.query(`UPDATE campaigns SET ${sets.join(", ")} WHERE campaign_id = :id`, { replacements: rep });
  } catch (e) {
    if (/offer_/i.test(String(e.message || ""))) throw Object.assign(new Error("Run migration 048_campaign_offer.sql to save an offer"), { status: 503 });
    throw e;
  }
}

// Copy a campaign's message + settings into a fresh draft (no recipients).
// Used by /duplicate and by the A/B pair. keepSchedule: same start time.
async function duplicateCampaign(src, { name: nameOverride, account: accOverride, repId = null, keepSchedule = false } = {}) {
  const newId      = uuidv4();
  const newName    = (nameOverride && String(nameOverride).trim()) || `Copy of ${src.name}`;
  const newAccount = accOverride !== undefined ? accOverride : src.whatsapp_account_id;

  // Copy content/config only. Operational fields (status, counts, schedule,
  // started/completed, weights, auto-pause) reset. body_variants/media_variants/
  // source_meta are already stored as JSON strings, so copy them verbatim.
  await sequelize.query(
    `INSERT INTO campaigns
       (campaign_id, name, description, channel, language, body, body_variants, media_url, media_variants,
        delay_min_seconds, delay_max_seconds, daily_cap,
        send_window_start, send_window_end, whatsapp_account_id, assigned_rep_id,
        fizza_auto_reply,
        scheduled_start_at,
        source_type, source_meta, status, created_by)
     VALUES
       (:id, :name, :desc, :ch, :lang, :body, :variants, :media, :mvariants,
        :dmin, :dmax, :cap,
        :ws, :we, :acc, :arep,
        :fizza,
        CASE WHEN :keepSched = 1 THEN :sched ELSE NULL END,
        :stype, :smeta, 'draft', :rep)`,
    {
      replacements: {
        id: newId, name: newName, desc: src.description, ch: src.channel, lang: src.language,
        body: src.body, variants: src.body_variants, media: src.media_url, mvariants: src.media_variants,
        dmin: src.delay_min_seconds, dmax: src.delay_max_seconds, cap: src.daily_cap,
        ws: src.send_window_start, we: src.send_window_end, acc: newAccount, arep: src.assigned_rep_id, fizza: src.fizza_auto_reply ? 1 : 0,
        stype: src.source_type, smeta: src.source_meta,
        keepSched: keepSchedule ? 1 : 0, sched: src.scheduled_start_at || null,
        rep: repId,
      },
    }
  );

  // Copy the follow-ups too.
  if (Number(src.nurture_enabled) && src.nurture_steps) {
    await sequelize.query(
      "UPDATE campaigns SET nurture_enabled = 1, nurture_steps = :st, nurture_only_delivered = :od WHERE campaign_id = :id",
      { replacements: { st: typeof src.nurture_steps === "string" ? src.nurture_steps : JSON.stringify(src.nurture_steps), od: src.nurture_only_delivered ?? 1, id: newId } }
    ).catch(() => {});
  }
  // Copy the offer too.
  if (src.offer_text || src.offer_ends_at) {
    await sequelize.query(
      `UPDATE campaigns t JOIN campaigns s ON s.campaign_id = :src
          SET t.offer_text = s.offer_text, t.offer_ends_at = s.offer_ends_at
        WHERE t.campaign_id = :id`,
      { replacements: { src: src.campaign_id, id: newId } }
    ).catch(() => {});
  }
  // Copy the slow start too.
  if (src.ramp_caps) {
    await sequelize.query("UPDATE campaigns SET ramp_caps = :r WHERE campaign_id = :id", { replacements: { r: src.ramp_caps, id: newId } }).catch(() => {});
  }
  // Copy "who handles replies" too (only when the source has one set;
  // a NULL source keeps the copied legacy fizza_auto_reply as-is).
  if (src.replying_now === "fiza" || src.replying_now === "rep") {
    await setCampaignReplyMode(newId, src.replying_now).catch((e) =>
      console.warn("[campaign duplicate] reply setting not copied:", e.message)
    );
  }

  return newId;
}

// The other side of an A/B pair, or null. Used to keep the two sides equal
// when message, pacing or schedule change (only "who replies" may differ).
async function abSiblingId(campaignId) {
  const ab = await require("../services/campaignIntake").abInfo(campaignId);
  return ab ? ab.arms.find((c) => c.campaign_id !== campaignId).campaign_id : null;
}

// ── A/B pair: Fizza on vs Fizza off (migration 047) ───────────
// Same message, same number, same pacing, same start time. The ONLY
// difference is who answers replies: side 0 Fizza, side 1 the rep. Each
// woman's side is fixed by a hash of her lead id (campaignIntake.armFor), so
// importing the group or sheet into either campaign fills both halves and
// nobody gets both messages.
async function makeAbTest(campaignId, repId) {
  const intake = require("../services/campaignIntake");
  const [[src]] = await sequelize.query("SELECT * FROM campaigns WHERE campaign_id = :id", { replacements: { id: campaignId } });
  if (!src) throw Object.assign(new Error("Campaign not found"), { status: 404 });
  if (src.status !== "draft") throw Object.assign(new Error("Only a draft can be split into an A/B test"), { status: 400 });
  if (!("ab_group_id" in src)) throw Object.assign(new Error("Run migration 047_campaign_ab_test.sql first"), { status: 503 });
  if (src.ab_group_id) throw Object.assign(new Error("This campaign is already in an A/B test"), { status: 400 });

  const base = String(src.name).replace(/\s*\((Fizza on|Fizza off)\)\s*$/i, "");
  const groupId = uuidv4();
  const twinId = await duplicateCampaign(src, { name: `${base} (Fizza off)`, repId, keepSchedule: true });

  await sequelize.query("UPDATE campaigns SET name = :n, ab_group_id = :g, ab_arm = 0 WHERE campaign_id = :id",
    { replacements: { n: `${base} (Fizza on)`, g: groupId, id: campaignId } });
  await sequelize.query("UPDATE campaigns SET ab_group_id = :g, ab_arm = 1 WHERE campaign_id = :id",
    { replacements: { g: groupId, id: twinId } });
  // Explicit on both sides: 'rep' is a firm "Fizza off" (null would fall back
  // to the rep's own autopilot and blur the test).
  await setCampaignReplyMode(campaignId, "fiza");
  await setCampaignReplyMode(twinId, "rep");

  // Women already added: the ones on side 1 move to the twin.
  const [rows] = await sequelize.query(
    "SELECT id, lead_id FROM campaign_recipients WHERE campaign_id = :id AND status = 'queued'",
    { replacements: { id: campaignId } }
  );
  const move = rows.filter((r) => intake.armFor(groupId, r.lead_id) === 1).map((r) => r.id);
  for (let i = 0; i < move.length; i += 1000) {
    await sequelize.query("UPDATE campaign_recipients SET campaign_id = :t WHERE id IN (:ids)",
      { replacements: { t: twinId, ids: move.slice(i, i + 1000) } });
  }
  for (const id of [campaignId, twinId]) {
    await sequelize.query(
      "UPDATE campaigns SET total_recipients = (SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id = :id) WHERE campaign_id = :id",
      { replacements: { id } }
    );
  }
  const [pair] = await sequelize.query("SELECT * FROM campaigns WHERE ab_group_id = :g ORDER BY ab_arm", { replacements: { g: groupId } });
  return { ab_group_id: groupId, campaigns: pair, moved_to_fizza_off: move.length };
}

// POST /api/campaigns/:id/ab-test — split a draft into Fizza on / Fizza off.
router.post("/campaigns/:id/ab-test", auth, adminOnly, async (req, res) => {
  try {
    res.status(201).json(await makeAbTest(req.params.id, req.user.repId));
  } catch (err) {
    console.error("❌ ab-test:", err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// GET /api/campaigns/ab/:groupId/compare — the two sides side by side.
// Counts only what happened AFTER her campaign message, so a woman who was
// already paying doesn't count as a win for either side.
router.get("/campaigns/ab/:groupId/compare", auth, adminOnly, async (req, res) => {
  try {
    const [camps] = await sequelize.query(
      `SELECT campaign_id, name, status, ab_arm, replying_now, started_at, total_recipients
         FROM campaigns WHERE ab_group_id = :g ORDER BY ab_arm`,
      { replacements: { g: req.params.groupId } }
    );
    if (!camps.length) return res.status(404).json({ error: "A/B test not found" });
    const sides = [];
    for (const c of camps) {
      const [[m]] = await sequelize.query(
        `SELECT COUNT(*) AS recipients,
                SUM(l.stage = 'user')                                   AS paying_at_import,
                SUM(l.stage = 'churned')                                AS past_customers,
                SUM(cr.sent_at IS NOT NULL)                             AS sent,
                SUM(cr.status IN ('delivered','read','replied'))        AS delivered,
                SUM(cr.status IN ('read','replied'))                    AS seen,
                SUM(cr.status = 'replied')                              AS replied,
                SUM(EXISTS (SELECT 1 FROM dnc_list d WHERE d.lead_id = cr.lead_id AND d.created_at >= cr.sent_at)) AS opted_out
           FROM campaign_recipients cr JOIN leads l ON l.id = cr.lead_id
          WHERE cr.campaign_id = :id`,
        { replacements: { id: c.campaign_id } }
      );
      const [[money]] = await sequelize.query(
        `SELECT COUNT(DISTINCT rc.lead_id) AS paid_after, COALESCE(SUM(rc.amount_paid), 0) AS revenue
           FROM campaign_recipients cr
           JOIN rep_conversions rc ON rc.lead_id = cr.lead_id AND rc.converted_at >= cr.sent_at
          WHERE cr.campaign_id = :id AND cr.sent_at IS NOT NULL`,
        { replacements: { id: c.campaign_id } }
      ).catch(() => [[{ paid_after: null, revenue: null }]]);
      const n = (v) => Number(v || 0);
      const pct = (a, b) => (n(b) ? Math.round((n(a) / n(b)) * 1000) / 10 : 0);
      sides.push({
        campaign_id: c.campaign_id, name: c.name, status: c.status, side: n(c.ab_arm),
        replies_by: c.replying_now === "fiza" ? "Fizza" : "Rep",
        recipients: n(m.recipients), paying_at_import: n(m.paying_at_import), past_customers: n(m.past_customers),
        sent: n(m.sent), delivered: n(m.delivered), seen: n(m.seen), replied: n(m.replied), opted_out: n(m.opted_out),
        paid_after: n(money.paid_after), revenue: n(money.revenue),
        reply_rate: pct(m.replied, m.sent), pay_rate: pct(money.paid_after, m.sent), opt_out_rate: pct(m.opted_out, m.sent),
      });
    }
    res.json({ ab_group_id: req.params.groupId, sides });
  } catch (err) {
    console.error("❌ ab compare:", err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/campaigns/:id/duplicate — clone message + settings into a fresh
// draft (NO recipients copied). Admin then attaches a new group/number and starts it.
router.post("/campaigns/:id/duplicate", auth, adminOnly, async (req, res) => {
  try {
    const [rows] = await sequelize.query(
      `SELECT * FROM campaigns WHERE campaign_id = :id LIMIT 1`,
      { replacements: { id: req.params.id } }
    );
    const src = rows[0];
    if (!src) return res.status(404).json({ error: "Campaign not found" });

    // Optional overrides at duplicate time.
    const { name: nameOverride, whatsapp_account_id: accOverride } = req.body || {};
    const newId = await duplicateCampaign(src, { name: nameOverride, account: accOverride, repId: req.user.repId });

    const [created] = await sequelize.query(
      `SELECT * FROM campaigns WHERE campaign_id = :id`,
      { replacements: { id: newId } }
    );
    res.status(201).json({ ...created[0], duplicated_from: req.params.id });
  } catch (err) {
    console.error("❌ duplicate campaign:", err);
    res.status(500).json({ error: err.message });
  }
});

router.get("/campaigns/:id", auth, adminOnly, async (req, res) => {
  try {
    const [rows] = await sequelize.query(
      `SELECT * FROM campaigns WHERE campaign_id = :id LIMIT 1`,
      { replacements: { id: req.params.id } }
    );
    if (!rows[0]) return res.status(404).json({ error: "Not found" });

    // Stats: status counts
    const [statusRows] = await sequelize.query(
      `SELECT status, COUNT(*) AS n
         FROM campaign_recipients
        WHERE campaign_id = :id
        GROUP BY status`,
      { replacements: { id: req.params.id } }
    );
    const statusCounts = {};
    statusRows.forEach((r) => { statusCounts[r.status] = parseInt(r.n, 10); });

    // "When will it send?" from the sender's own rules (services/campaignSchedule.js).
    let sendInfo = null;
    try { sendInfo = await require("../services/campaignSchedule").sendInfo(rows[0]); }
    catch (e) { console.warn("[campaign] send info:", e.message); }
    res.json({ ...rows[0], statusCounts, send_info: sendInfo });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch("/campaigns/:id", auth, adminOnly, async (req, res) => {
  try {
    const [rows] = await sequelize.query(
      `SELECT status FROM campaigns WHERE campaign_id = :id LIMIT 1`,
      { replacements: { id: req.params.id } }
    );
    if (!rows[0]) return res.status(404).json({ error: "Not found" });
    // Changing ONLY "who handles replies" is allowed while running — that's
    // exactly when an admin may need to switch a flooded campaign to Auto.
    const bodyKeys = Object.keys(req.body || {});
    // So is the offer: extending or correcting it mid-campaign is normal.
    const onlyReplyMode = bodyKeys.length > 0 && bodyKeys.every((k) => ["replying_now", "offer_text", "offer_ends_at"].includes(k));
    if (rows[0].status === "running" && !onlyReplyMode) {
      return res.status(400).json({ error: "Pause the campaign first before editing." });
    }
    const replyModeGiven = req.body.replying_now !== undefined;
    const replyMode = parseReplyMode(req.body.replying_now);
    if (replyModeGiven && replyMode === undefined) {
      return res.status(400).json({ error: "replying_now must be null (same as rep), \"rep\" (assist) or \"fiza\" (auto)" });
    }

    const fields = [];
    const replacements = { id: req.params.id };
    const allowed = [
      "name","description","body","media_url",
      "body_variants","media_variants",                                   // variants + per-variant media
      "delay_min_seconds","delay_max_seconds","daily_cap",
      "send_window_start","send_window_end","whatsapp_account_id","language","channel",
      "assigned_rep_id",                                                  // Phase 19a
      "fizza_auto_reply",                                                 // Phase 20
      "scheduled_start_at",                                               // Phase 19c
    ];
    for (const k of allowed) {
      if (req.body[k] !== undefined) {
        fields.push(`${k} = :${k}`);
        let val = req.body[k];
        // Auto-stringify arrays for JSON columns
        if ((k === "body_variants" || k === "media_variants") && Array.isArray(val)) {
          val = JSON.stringify(val.map(v => (typeof v === "string" ? v.trim() : "")).slice(0, 5));
        }
        if (k === "scheduled_start_at") {
          try {
            val = scheduleToUtc(val);
          } catch (e) {
            return res.status(400).json({ error: e.message });
          }
        }
        replacements[k] = val;
      }
    }
    const offerGiven = ["offer_text", "offer_ends_at"].some((k) => req.body[k] !== undefined);
    if (fields.length === 0 && !replyModeGiven && !offerGiven) return res.status(400).json({ error: "Nothing to update" });
    if (offerGiven) {
      const offer = {};
      for (const k of ["offer_text", "offer_ends_at"]) if (req.body[k] !== undefined) offer[k] = req.body[k];
      await saveOffer(req.params.id, offer);
      const sibOffer = await abSiblingId(req.params.id);
      if (sibOffer) await saveOffer(sibOffer, offer);
    }

    if (fields.length > 0) {
      await sequelize.query(
        `UPDATE campaigns SET ${fields.join(", ")} WHERE campaign_id = :id`,
        { replacements }
      );
      // A/B pair: the same message, pacing, number and schedule on both
      // sides. Name and "who replies" stay per side, that IS the test.
      const sib = await abSiblingId(req.params.id);
      const shared = fields.filter((f) => !/^(name|fizza_auto_reply) =/.test(f));
      if (sib && shared.length) {
        await sequelize.query(
          `UPDATE campaigns SET ${shared.join(", ")} WHERE campaign_id = :sib AND status <> 'running'`,
          { replacements: { ...replacements, sib } }
        );
      }
    }
    // Applied after the main update so it wins over a fizza_auto_reply sent
    // in the same request.
    if (replyModeGiven) await setCampaignReplyMode(req.params.id, replyMode);
    res.json({ success: true, ...(replyModeGiven ? { replying_now: replyMode } : {}) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.delete("/campaigns/:id", auth, adminOnly, async (req, res) => {
  try {
    const [rows] = await sequelize.query(
      `SELECT status FROM campaigns WHERE campaign_id = :id LIMIT 1`,
      { replacements: { id: req.params.id } }
    );
    if (!rows[0]) return res.status(404).json({ error: "Not found" });
    if (!["draft", "completed", "aborted"].includes(rows[0].status)) {
      return res.status(400).json({ error: "Cannot delete a running campaign" });
    }
    // Its sent messages stay in each chat, as automated (not 'rep'): older
    // campaign sends were saved as 'rep' and, once the campaign rows are
    // gone, would read as "a person is talking to her" and silence Fiza.
    await sequelize.query(
      `UPDATE messages m JOIN campaign_recipients cr
          ON cr.external_message_id = m.whatsapp_message_id AND cr.campaign_id = :id
          SET m.\`from\` = 'bot'
        WHERE m.direction = 'OUT' AND m.\`from\` = 'rep'`,
      { replacements: { id: req.params.id } }
    ).catch((e) => console.warn("[campaign delete] relabel:", e.message));
    await sequelize.query(`DELETE FROM campaigns WHERE campaign_id = :id`, {
      replacements: { id: req.params.id },
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Recipients ────────────────────────────────────────────────
router.get("/campaigns/:id/recipients", auth, adminOnly, async (req, res) => {
  try {
    const status = req.query.status;
    const where = ["cr.campaign_id = :id"];
    const replacements = { id: req.params.id, limit: 200 };
    if (status) { where.push("cr.status = :status"); replacements.status = status; }

    const [rows] = await sequelize.query(
      `SELECT cr.id, cr.status, cr.sent_at, cr.replied_at, cr.error_message,
              l.id AS lead_id, l.phone, l.name, l.whatsapp_jid
         FROM campaign_recipients cr
         JOIN leads l ON l.id = cr.lead_id
        WHERE ${where.join(" AND ")}
        ORDER BY cr.id ASC
        LIMIT :limit`,
      { replacements }
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Import-from-group ─────────────────────────────────────────
router.post("/campaigns/:id/import-group", auth, adminOnly, async (req, res) => {
  try {
    const { groupJid, groupSubject } = req.body || {};
    const whatsappAccountId = Number(req.body?.whatsappAccountId) || 1; // normalize (frontend sends a string)
    if (!groupJid && !groupSubject) {
      return res.status(400).json({ error: "groupJid or groupSubject is required" });
    }

    const [campRows] = await sequelize.query(
      `SELECT campaign_id, name, status, assigned_rep_id FROM campaigns WHERE campaign_id = :id LIMIT 1`,
      { replacements: { id: req.params.id } }
    );
    if (!campRows[0]) return res.status(404).json({ error: "Campaign not found" });
    if (campRows[0].status !== "draft") {
      return res.status(400).json({ error: "Recipients can only be added to drafts" });
    }

    // Step 1: match / create every member, checking in the app whether her
    // plan is live. Returns the lead ids of THIS group's members.
    const importResult = await importGroupMembers({
      whatsappAccountId,
      groupJid,
      groupSubject,
      repId: req.user.repId,
      assignedRepId: campRows[0].assigned_rep_id || null,
      campaign: campRows[0],
      skipAppCheck: req.body?.skipAppCheck === true,
    });

    // Step 2: add them by lead id. Matching by one WhatsApp id dropped women
    // we know under their other id (@lid vs number), by last 10 digits, or on
    // another of our numbers. Same filters as every door: opted out,
    // cooldown, internal numbers. Also refreshes total_recipients.
    const intake = require("../services/campaignIntake");
    const recip = await intake.addRecipients(req.params.id, importResult.leadIds || [], { allowOverlap: req.body?.allowOverlap === true });
    await sequelize.query(
      `UPDATE campaigns
          SET source_meta = JSON_SET(COALESCE(source_meta, JSON_OBJECT()),
                                      '$.group_subject', :gs,
                                      '$.group_jid', :gj)
        WHERE campaign_id = :id`,
      { replacements: { id: req.params.id, gs: importResult.groupSubject, gj: importResult.groupJid } }
    );
    const insertedCount = recip.added;

    res.json({
      success: true,
      group: importResult.groupSubject,
      import: importResult.totals,
      recipientsAdded: insertedCount,
      recipients: recip, // added / already / opted_out / cooldown / excluded
    });
  } catch (err) {
    console.error("❌ import-group:", err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ── Add hand-picked leads (testing, VIPs, a few named women) ──
// POST /api/campaigns/:id/add-leads
//   { lead_ids?: [..], phones?: ["0300…", …], forTesting?: true }
// lead_ids: picked in the dashboard. phones: matched on the last 10 digits;
// a number we don't have becomes a new lead on the campaign's WhatsApp line
// (entry gate "campaign_pick"). forTesting: the same woman may get it again
// (skips the cooldown and "already in another campaign" rules). Opted-out
// women and DNC are never added, test or not.
router.post("/campaigns/:id/add-leads", auth, adminOnly, async (req, res) => {
  try {
    const intake = require("../services/campaignIntake");
    const frontDesk = require("../services/frontDesk");
    const [[campaign]] = await sequelize.query(
      "SELECT campaign_id, status, assigned_rep_id, whatsapp_account_id FROM campaigns WHERE campaign_id = :id",
      { replacements: { id: req.params.id } }
    );
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });
    if (campaign.status !== "draft") return res.status(400).json({ error: "Recipients can only be added to drafts" });

    const b = req.body || {};
    const ids = new Set((Array.isArray(b.lead_ids) ? b.lead_ids : []).map((x) => parseInt(x, 10)).filter((x) => x > 0).slice(0, 500));
    const phones = (Array.isArray(b.phones) ? b.phones : String(b.phones || "").split(/[\s,;]+/))
      .map((p) => String(p || "").trim()).filter(Boolean).slice(0, 500);
    if (!ids.size && !phones.length) return res.status(400).json({ error: "Pick at least one lead or number" });

    // Picked ids must be live leads (a merged one points to the live one).
    if (ids.size) {
      const [rows] = await sequelize.query(
        "SELECT id, merged_into_lead_id FROM leads WHERE id IN (:ids)", { replacements: { ids: [...ids] } }
      );
      ids.clear();
      for (const r of rows) ids.add(Number(r.merged_into_lead_id || r.id));
    }

    // Numbers: existing lead, or a new one on this campaign's line.
    const accountId = await intake.campaignAccount(campaign);
    const numbers = { matched: 0, created: 0, invalid: [] };
    for (const raw of phones) {
      if (!intake.tail10(raw)) { numbers.invalid.push(raw); continue; }
      const found = await frontDesk.findByPhoneLoosely(raw);
      if (found) { ids.add(Number(found.id)); numbers.matched++; continue; }
      const { contact } = await frontDesk.findOrCreateContact({
        channel: "phone", phone: raw, accountId, loosePhone: true,
        repId: campaign.assigned_rep_id || null, source: "whatsapp", gate: "campaign_pick",
      });
      ids.add(Number(contact.id));
      numbers.created++;
    }

    const forTesting = b.forTesting === true;
    const recip = await intake.addRecipients(req.params.id, [...ids], { allowOverlap: forTesting, ignoreCooldown: forTesting });
    res.json({ success: true, recipientsAdded: recip.added, recipients: recip, numbers, forTesting });
  } catch (err) {
    console.error("❌ add-leads:", err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ── Add by segment (filter on existing leads) ─────────────────
router.post("/campaigns/:id/add-segment", auth, adminOnly, async (req, res) => {
  try {
    const filter = req.body || {};
    // A lead with only a number is sendable too (the sender looks her up on
    // WhatsApp), so number-only leads are no longer left out.
    const where = ["(whatsapp_jid IS NOT NULL OR (phone IS NOT NULL AND phone <> ''))"];
    const replacements = { id: req.params.id };

    // Exact leads (e.g. a test, or a hand-picked few): { lead_ids: [407] }
    if (Array.isArray(filter.lead_ids)) {
      const ids = filter.lead_ids.map((x) => parseInt(x, 10)).filter((x) => x > 0).slice(0, 5000);
      if (!ids.length) return res.status(400).json({ error: "lead_ids is empty" });
      where.push("id IN (:leadIds)"); replacements.leadIds = ids;
    }
    if (filter.stage)    { where.push("stage = :stage"); replacements.stage = filter.stage; }
    if (filter.language) { where.push("language = :lang"); replacements.lang = filter.language; }
    if (filter.source)   { where.push("source = :source"); replacements.source = filter.source; }
    if (filter.minLeadScore) { where.push("lead_score >= :minScore"); replacements.minScore = filter.minLeadScore; }
    if (filter.lastActivityBefore) {
      where.push("last_activity_at < :lab");
      replacements.lab = filter.lastActivityBefore;
    }

    // Don't include opted-out leads
    where.push("id NOT IN (SELECT lead_id FROM dnc_list WHERE lead_id IS NOT NULL)");

    // Don't include permanently-excluded numbers (admin / internal)
    // (Internal numbers are dropped and counted by campaignIntake.addRecipients
    //  below, without the full-table string scan this used to do.)

    // Don't include numbers messaged within the cooldown window
    if (COOLDOWN_DAYS > 0) {
      where.push(`id NOT IN (
        SELECT lead_id FROM campaign_recipients
         WHERE status IN ('sent','delivered','read','replied')
           AND sent_at IS NOT NULL
           AND sent_at >= DATE_SUB(NOW(), INTERVAL ${COOLDOWN_DAYS} DAY)
      )`);
    }

    // Pick the leads, then add them through the shared door: it also keeps
    // out women waiting in another campaign, and an A/B pair splits them.
    const [picked] = await sequelize.query(
      `SELECT id FROM leads WHERE ${where.join(" AND ")} AND merged_into_lead_id IS NULL`,
      { replacements }
    );
    const intake = require("../services/campaignIntake");
    const recip = await intake.addRecipients(req.params.id, picked.map((r) => r.id), { allowOverlap: filter.allowOverlap === true });

    res.json({ success: true, recipientsAdded: recip.added, recipients: recip });
  } catch (err) {
    console.error("❌ add-segment:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── Start / pause / abort ─────────────────────────────────────
router.post("/campaigns/:id/start", auth, adminOnly, async (req, res) => {
  try {
    const [rows] = await sequelize.query(
      `SELECT status, total_recipients, scheduled_start_at FROM campaigns WHERE campaign_id = :id`,
      { replacements: { id: req.params.id } }
    );
    if (!rows[0]) return res.status(404).json({ error: "Not found" });
    if (rows[0].total_recipients === 0) {
      return res.status(400).json({ error: "Add recipients before starting" });
    }
    if (!["draft", "paused", "scheduled"].includes(rows[0].status)) {
      return res.status(400).json({ error: `Cannot start from status '${rows[0].status}'` });
    }

    // Phase 19c — if scheduled_start_at is in the future, flip to 'scheduled'
    // (worker will auto-promote when the time comes). Else start immediately.
    const sched = rows[0].scheduled_start_at;
    const isFutureSchedule = sched && new Date(sched) > new Date();
    const targetStatus = isFutureSchedule ? "scheduled" : "running";

    // A/B pair: both sides start together, or the comparison isn't fair
    // (different days, different hours). The other side must be ready too.
    const intake = require("../services/campaignIntake");
    const ab = await intake.abInfo(req.params.id);
    const ids = [req.params.id];
    // (Resuming a paused side resumes only that side.)
    if (ab && rows[0].status !== "paused") {
      const other = ab.arms.find((c) => c.campaign_id !== req.params.id);
      const [[o]] = await sequelize.query("SELECT status, total_recipients FROM campaigns WHERE campaign_id = :id", { replacements: { id: other.campaign_id } });
      if (["draft", "scheduled"].includes(o.status)) {
        if (!Number(o.total_recipients)) {
          return res.status(400).json({ error: `A/B test: "${other.name}" has no recipients yet. Add the audience first, both sides start together.` });
        }
        ids.push(other.campaign_id);
      }
    }

    await sequelize.query(
      `UPDATE campaigns
          SET status = :status,
              started_at = CASE WHEN :status = 'running' THEN COALESCE(started_at, NOW()) ELSE started_at END
        WHERE campaign_id IN (:ids)`,
      { replacements: { ids, status: targetStatus } }
    );
    res.json({
      success: true,
      status: targetStatus,
      started: ids,
      ...(isFutureSchedule && { scheduled_start_at: sched }),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/campaigns/:id/pause", auth, adminOnly, async (req, res) => {
  try {
    await sequelize.query(
      `UPDATE campaigns SET status = 'paused' WHERE campaign_id = :id AND status = 'running'`,
      { replacements: { id: req.params.id } }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/campaigns/:id/abort", auth, adminOnly, async (req, res) => {
  try {
    await sequelize.query(
      `UPDATE campaigns SET status = 'aborted', completed_at = NOW()
        WHERE campaign_id = :id AND status IN ('running','paused','queued','draft')`,
      { replacements: { id: req.params.id } }
    );
    // Mark unsent recipients as skipped
    await sequelize.query(
      `UPDATE campaign_recipients
          SET status = 'skipped'
        WHERE campaign_id = :id AND status IN ('queued','sending')`,
      { replacements: { id: req.params.id } }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Phase 19d — Manual weights recompute (testing/debug) ──────
router.post("/campaigns/recompute-weights", auth, adminOnly, async (req, res) => {
  try {
    const { recomputeWeights } = require("../broadcast/campaignWeightsJob");
    const result = await recomputeWeights();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DNC list ──────────────────────────────────────────────────
router.get("/dnc", auth, adminOnly, async (req, res) => {
  try {
    const [rows] = await sequelize.query(
      `SELECT d.id, d.lead_id, d.phone, d.reason, d.matched_keyword, d.created_at,
              l.name
         FROM dnc_list d
         LEFT JOIN leads l ON l.id = d.lead_id
        ORDER BY d.created_at DESC LIMIT 200`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/dnc/:id", auth, adminOnly, async (req, res) => {
  try {
    await sequelize.query(`DELETE FROM dnc_list WHERE id = :id`, {
      replacements: { id: req.params.id },
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────
// GET /api/campaigns/:id/results — Phase 18 conversion analytics
// Returns the full marketing-ROI picture for a single campaign:
//   funnel counts, revenue attributed, goal breakdown, stage distribution.
// ──────────────────────────────────────────────────────────────
router.get("/campaigns/:id/results", auth, adminOnly, async (req, res) => {
  try {
    // campaign_id is a UUID string — do NOT parseInt
    const campaignId = req.params.id;
    if (!campaignId) return res.status(400).json({ error: "Invalid campaign id" });

    const [campaignRows] = await sequelize.query(
      "SELECT campaign_id, name, status, sent_count, replied_count, total_recipients, started_at, created_at FROM campaigns WHERE campaign_id = ?",
      { replacements: [campaignId] }
    );
    const campaign = campaignRows[0];
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });

    // 1. Funnel counts
    const [funnelRows] = await sequelize.query(
      `SELECT
         COUNT(*) AS total,
         SUM(l.stage = 'user') AS converted_users,
         SUM(l.interaction_status = 'ready_to_pay') AS ready_to_pay,
         SUM(l.lead_score >= 100) AS hot_leads,
         SUM(l.lead_score >= 60 AND l.lead_score < 100) AS warming_leads,
         SUM(l.interaction_status = 'ghosted') AS ghosted_count,
         SUM(l.interaction_status = 'opted_out') AS opted_out_count
       FROM campaign_recipients cr
       JOIN leads l ON l.id = cr.lead_id
       WHERE cr.campaign_id = ?`,
      { replacements: [campaignId] }
    );
    const funnel = funnelRows[0] || {};

    // 2. Revenue attributed
    const [revRows] = await sequelize.query(
      `SELECT
         COUNT(rc.id) AS conversions_count,
         COALESCE(SUM(rc.amount_paid), 0) AS total_revenue,
         COALESCE(AVG(rc.amount_paid), 0) AS avg_deal,
         MIN(rc.converted_at) AS first_conversion_at,
         MAX(rc.converted_at) AS last_conversion_at
       FROM campaign_recipients cr
       JOIN rep_conversions rc ON rc.lead_id = cr.lead_id
       WHERE cr.campaign_id = ?`,
      { replacements: [campaignId] }
    );
    const revenue = revRows[0] || {};

    // 3. Goal breakdown
    const [byGoal] = await sequelize.query(
      `SELECT COALESCE(l.main_goal, 'unknown') AS main_goal, COUNT(*) AS count
       FROM campaign_recipients cr JOIN leads l ON l.id = cr.lead_id
       WHERE cr.campaign_id = ? GROUP BY l.main_goal ORDER BY count DESC`,
      { replacements: [campaignId] }
    );

    // 4. Funnel stage distribution
    const [byStage] = await sequelize.query(
      `SELECT COALESCE(l.funnel_stage, 1) AS funnel_stage, COUNT(*) AS count
       FROM campaign_recipients cr JOIN leads l ON l.id = cr.lead_id
       WHERE cr.campaign_id = ? GROUP BY l.funnel_stage ORDER BY funnel_stage`,
      { replacements: [campaignId] }
    );

    // 5. Interaction status distribution
    const [byStatus] = await sequelize.query(
      `SELECT COALESCE(l.interaction_status, 'no_status') AS interaction_status, COUNT(*) AS count
       FROM campaign_recipients cr JOIN leads l ON l.id = cr.lead_id
       WHERE cr.campaign_id = ? GROUP BY l.interaction_status ORDER BY count DESC LIMIT 15`,
      { replacements: [campaignId] }
    );

    // 6. Objections distribution
    const [byObjection] = await sequelize.query(
      `SELECT COALESCE(l.last_objection, 'none') AS last_objection, COUNT(*) AS count
       FROM campaign_recipients cr JOIN leads l ON l.id = cr.lead_id
       WHERE cr.campaign_id = ? GROUP BY l.last_objection ORDER BY count DESC`,
      { replacements: [campaignId] }
    );

    // 7. Time-to-first-sale (hours)
    let timeToFirstSale = null;
    if (campaign.started_at && revenue.first_conversion_at) {
      timeToFirstSale = Math.round(
        (new Date(revenue.first_conversion_at) - new Date(campaign.started_at)) / 3600000
      );
    }

    // 8. Computed rates
    const sent = Number(campaign.sent_count || 0);
    const replied = Number(campaign.replied_count || 0);
    const converted = Number(revenue.conversions_count || 0);

    res.json({
      campaign,
      funnel,
      revenue,
      rates: {
        reply_rate_pct:                  sent > 0 ? +(replied / sent * 100).toFixed(2) : 0,
        conversion_rate_of_sent_pct:     sent > 0 ? +(converted / sent * 100).toFixed(2) : 0,
        conversion_rate_of_replied_pct:  replied > 0 ? +(converted / replied * 100).toFixed(1) : 0,
      },
      breakdowns: {
        by_goal: byGoal,
        by_funnel_stage: byStage,
        by_interaction_status: byStatus,
        by_objection: byObjection,
      },
      time_to_first_sale_hours: timeToFirstSale,
    });
  } catch (err) {
    console.error("[campaign results]", err);
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────
// GET /api/campaigns/analytics/summary
// Cross-campaign rollup — totals, top performers, comparison rows.
// ──────────────────────────────────────────────────────────────
router.get("/campaigns/analytics/summary", auth, adminOnly, async (req, res) => {
  try {
    const [totalsRows] = await sequelize.query(
      `SELECT
         COUNT(*)                                              AS total_campaigns,
         SUM(CASE WHEN status = 'running'   THEN 1 ELSE 0 END) AS running_count,
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_count,
         SUM(CASE WHEN status = 'draft'     THEN 1 ELSE 0 END) AS draft_count,
         COALESCE(SUM(total_recipients), 0) AS total_recipients,
         COALESCE(SUM(sent_count), 0)       AS total_sent,
         COALESCE(SUM(replied_count), 0)    AS total_replied,
         COALESCE(SUM(failed_count), 0)     AS total_failed
       FROM campaigns`
    );
    const totals = totalsRows[0] || {};

    const [revRows] = await sequelize.query(
      `SELECT
         COUNT(DISTINCT rc.id)                AS total_conversions,
         COALESCE(SUM(rc.amount_paid), 0)     AS total_revenue,
         COALESCE(AVG(rc.amount_paid), 0)     AS avg_deal
       FROM campaign_recipients cr
       JOIN rep_conversions rc ON rc.lead_id = cr.lead_id
       JOIN campaigns c ON c.campaign_id = cr.campaign_id
       WHERE rc.converted_at >= COALESCE(c.started_at, c.created_at)`
    );
    const revenue = revRows[0] || {};

    const [perCampaign] = await sequelize.query(
      `SELECT
         c.campaign_id, c.name, c.status, c.channel,
         c.total_recipients, c.sent_count, c.replied_count, c.failed_count,
         c.started_at, c.completed_at,
         CASE WHEN c.sent_count > 0
              THEN ROUND(c.replied_count / c.sent_count * 100, 1)
              ELSE 0 END AS reply_rate_pct,
         (SELECT COUNT(DISTINCT rc.id)
            FROM campaign_recipients cr
            JOIN rep_conversions rc ON rc.lead_id = cr.lead_id
           WHERE cr.campaign_id = c.campaign_id
             AND rc.converted_at >= COALESCE(c.started_at, c.created_at)
         ) AS conversions,
         (SELECT COALESCE(SUM(rc.amount_paid), 0)
            FROM campaign_recipients cr
            JOIN rep_conversions rc ON rc.lead_id = cr.lead_id
           WHERE cr.campaign_id = c.campaign_id
             AND rc.converted_at >= COALESCE(c.started_at, c.created_at)
         ) AS revenue
       FROM campaigns c
       ORDER BY c.created_at DESC
       LIMIT 20`
    );

    const sentCampaigns = perCampaign.filter(c => Number(c.sent_count) > 0);
    const topByReply = [...sentCampaigns]
      .sort((a, b) => Number(b.reply_rate_pct) - Number(a.reply_rate_pct))[0] || null;
    const topByRevenue = [...sentCampaigns]
      .sort((a, b) => Number(b.revenue) - Number(a.revenue))[0] || null;

    const [channelMix] = await sequelize.query(
      `SELECT channel, COUNT(*) AS n
         FROM campaigns
        WHERE status IN ('running','completed','paused','aborted')
        GROUP BY channel`
    );

    const sent = Number(totals.total_sent || 0);
    const replied = Number(totals.total_replied || 0);
    const conversions = Number(revenue.total_conversions || 0);

    res.json({
      totals: {
        ...totals,
        total_conversions: conversions,
        total_revenue: Number(revenue.total_revenue || 0),
        avg_deal: Number(revenue.avg_deal || 0),
        overall_reply_rate_pct:     sent > 0 ? +(replied / sent * 100).toFixed(1) : 0,
        overall_conversion_rate_pct: sent > 0 ? +(conversions / sent * 100).toFixed(2) : 0,
      },
      top_performers: {
        by_reply_rate: topByReply,
        by_revenue:    topByRevenue,
      },
      per_campaign: perCampaign,
      channel_mix:  channelMix,
    });
  } catch (err) {
    console.error("[campaigns analytics summary]", err);
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────
// POST /api/campaigns/:id/retry-failed
// Requeues all status='failed' recipients, resets their error_message,
// recalculates failed_count, and flips the campaign back to 'running'.
// Use after fixing the issue that caused failures (bad media URL, etc.)
// ──────────────────────────────────────────────────────────────
router.post("/campaigns/:id/retry-failed", auth, adminOnly, async (req, res) => {
  try {
    const [rows] = await sequelize.query(
      `SELECT status, failed_count FROM campaigns WHERE campaign_id = :id LIMIT 1`,
      { replacements: { id: req.params.id } }
    );
    if (!rows[0]) return res.status(404).json({ error: "Not found" });
    if (rows[0].status === "running") {
      return res.status(400).json({ error: "Campaign is already running" });
    }

    // Requeue failed AND skipped recipients (skipped happens when worker
    // bailed mid-flight or couldn't resolve a phone — worth re-attempting
    // after a session refresh or config change)
    const [updateResult] = await sequelize.query(
      `UPDATE campaign_recipients
          SET status = 'queued',
              error_message = NULL,
              sent_at = NULL
        WHERE campaign_id = :id AND status IN ('failed', 'skipped')`,
      { replacements: { id: req.params.id } }
    );
    const requeued = updateResult.affectedRows || 0;

    // Decrement failed_count by the requeued count, flip campaign to running
    await sequelize.query(
      `UPDATE campaigns
          SET status        = 'running',
              completed_at  = NULL,
              failed_count  = GREATEST(0, COALESCE(failed_count, 0) - :n)
        WHERE campaign_id = :id`,
      { replacements: { id: req.params.id, n: requeued } }
    );

    res.json({ success: true, requeued });
  } catch (err) {
    console.error("[retry-failed]", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
