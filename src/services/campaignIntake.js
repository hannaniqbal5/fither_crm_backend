/**
 * campaignIntake.js — how a woman enters a campaign (group import, number
 * upload). Shared by groupImporter.js and numberUpload.routes.js (Nov 2026).
 *
 * WHY
 *   The two doors each had their own idea of "who is she" and "what is she":
 *     • group import saved every member as a paying customer, whether or not
 *       her plan was still running;
 *     • the sheet upload threw away everything but phone and name (email,
 *       amount, package, goal, city, paid/unpaid);
 *     • matching was by exact phone or one WhatsApp id, so a woman we already
 *       had under her other id (@lid vs number) was "skipped" AND left out of
 *       the campaign.
 *
 * RULES
 *   1. Who is she: her WhatsApp ids (number jid and @lid), her app account,
 *      her phone (last 10 digits), her email. First hit wins. Never a second
 *      record when any of these already points at her.
 *   2. What is she: the APP is the truth for "paying right now". Asked live
 *      via partner_backend /internal/crm/subscription-lookup.
 *        active / frozen        → stage user, status converted (paying member)
 *        trial                  → visitor becomes lead
 *        expired / cancelled    → paid before, not now: stage churned
 *      Not in the app: what the import says. A paid customers' group or a
 *      "paid" row in the sheet = paid before → stage churned.
 *      A 'user' stage is never downgraded here (the nightly plan sync lists
 *      those for a person to check, she may have paid another way).
 *   3. What we knew before is kept: data only fills blanks, never overwrites.
 *   4. Every woman (new or existing) gets a note line and an event saying
 *      which campaign / group / sheet brought her in.
 */
const sequelize = require("../config/database");
const { v4: uuidv4 } = require("uuid");
const frontDesk = require("./frontDesk");

/* ───────────────────────── small helpers ───────────────────────── */

function tail10(phone) {
  const d = String(phone || "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : null;
}
function cleanEmail(e) {
  const v = String(e || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 180 ? v : null;
}
const PAYING = ["active", "frozen"];
const ENDED = ["expired", "cancelled"];

// leads.whatsapp_lid comes with migration 046. Until it runs, everything
// works, just without the @lid column.
let lidColumn = null;
async function hasLidColumn() {
  if (lidColumn !== null) return lidColumn;
  try {
    const [r] = await sequelize.query(
      `SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'leads' AND COLUMN_NAME = 'whatsapp_lid' LIMIT 1`
    );
    lidColumn = r.length > 0;
    if (!lidColumn) console.warn("[campaignIntake] leads.whatsapp_lid missing, run migration 046_whatsapp_lid.sql");
  } catch { lidColumn = false; }
  return lidColumn;
}

/* ─────────────────── sheet columns → lead fields ─────────────────── */

function mapGoal(text) {
  const t = String(text || "").toLowerCase();
  if (!t) return null;
  if (/pcos|pcod/.test(t)) return "pcos";
  if (/post.?partum|after (delivery|baby|pregnan)|delivery/.test(t)) return "postpartum";
  if (/diabet|sugar|insulin/.test(t)) return "diabetes";
  if (/gain|weight.?up|underweight/.test(t)) return "weight_gain";
  if (/loss|lose|reduc|fat|slim|weight/.test(t)) return "weight_loss";
  return "general";
}

/**
 * number_entries.extra_data is { "<header as typed>": "<cell>" }. Pick out
 * what has a home on the lead; everything else goes into the note.
 */
function readSheetExtras(extra) {
  const out = { email: null, amount: null, planTitle: null, goalText: null, mainGoal: null, noteParts: [] };
  if (!extra || typeof extra !== "object") return out;
  for (const [rawKey, rawVal] of Object.entries(extra)) {
    const key = String(rawKey).trim().toLowerCase();
    const val = String(rawVal ?? "").trim();
    if (!val) continue;
    if (/^(category|paid|paid.?converted|status|type)$/.test(key)) continue; // already the category
    if (/e-?mail/.test(key)) { out.email = out.email || cleanEmail(val); if (!cleanEmail(val)) out.noteParts.push(`${rawKey}: ${val}`); continue; }
    if (/amount|price|fee|paid.?amount|payment/.test(key)) {
      const n = parseFloat(val.replace(/[^\d.]/g, ""));
      if (Number.isFinite(n) && n > 0 && out.amount == null) out.amount = n;
      out.noteParts.push(`${rawKey}: ${val}`);
      continue;
    }
    if (/package|plan|subscription|duration/.test(key)) { out.planTitle = out.planTitle || val.slice(0, 160); out.noteParts.push(`${rawKey}: ${val}`); continue; }
    if (/goal|concern|problem|issue/.test(key)) { out.goalText = out.goalText || val; out.mainGoal = out.mainGoal || mapGoal(val); out.noteParts.push(`${rawKey}: ${val}`); continue; }
    out.noteParts.push(`${rawKey}: ${val}`);
  }
  return out;
}

/* ───────────────────── the app's answer (truth) ───────────────────── */

/**
 * contacts: [{ key, phone?, email? }] → Map(key → truth | null)
 *   null  = asked, she has no app account
 * Throws (err.status 502/503) when the app backend can't be asked, so the
 * caller can stop instead of guessing who is paying.
 */
async function lookupApp(contacts) {
  const { partnerCall } = require("./partnerSigned");
  const out = new Map();
  const list = contacts.filter((c) => c && c.key != null && (tail10(c.phone) || cleanEmail(c.email)));
  for (let i = 0; i < list.length; i += 200) {
    const chunk = list.slice(i, i + 200).map((c) => ({ key: String(c.key), phone: c.phone || null, email: cleanEmail(c.email) }));
    const data = await partnerCall("POST", "/internal/crm/subscription-lookup", { contacts: chunk });
    const results = data.results || {};
    for (const c of chunk) out.set(c.key, results[c.key] || null);
  }
  return out;
}

/**
 * decide(lead, truth, claim) — pure, so it can be tested.
 *   truth: undefined = not checked, null = not in the app, object = app account
 *   claim: { paidBefore, email, amount, planTitle, mainGoal }
 * → { patch, verdict }
 */
function decide(lead, truth, claim = {}) {
  const patch = {};
  const stage = lead.stage || "visitor";
  const isUser = stage === "user";

  // What she brought with her: fill blanks only.
  if (claim.email && !lead.email) patch.email = claim.email;
  if (claim.amount && lead.subscription_amount == null) patch.subscription_amount = claim.amount;
  if (claim.mainGoal && !lead.main_goal) patch.main_goal = claim.mainGoal;

  const markPaidBefore = () => {
    if (!isUser) patch.stage = "churned";
    if (lead.status !== "converted") patch.status = "converted";
  };

  let verdict;
  if (truth && truth.status && truth.status !== "none") {
    // The app knows her plan: copy it as the truth.
    if ((lead.subscription_status || "none") !== truth.status) patch.subscription_status = truth.status;
    if (truth.plan_title && truth.plan_title !== lead.subscription_plan_title) patch.subscription_plan_title = truth.plan_title;
    if (truth.expires_at) {
      const want = new Date(truth.expires_at);
      const have = lead.subscription_expires_at ? new Date(lead.subscription_expires_at) : null;
      if (!have || Math.abs(want - have) > 1000) patch.subscription_expires_at = want;
    }
    if (PAYING.includes(truth.status)) {
      verdict = "active";
      if (!isUser) patch.stage = "user";
      if (lead.status !== "converted") patch.status = "converted";
    } else if (truth.status === "trial") {
      verdict = "trial";
      if (claim.paidBefore) markPaidBefore();
      else if (stage === "visitor") patch.stage = "lead";
    } else if (ENDED.includes(truth.status)) {
      verdict = "past_customer";
      markPaidBefore();
    } else {
      verdict = "unknown_status";
    }
  } else {
    // Not in the app, an app account that never paid, or not checked:
    // go by what the import says.
    verdict = truth === undefined ? "not_checked" : truth === null ? "not_in_app" : "app_no_plan";
    if (truth && !lead.subscription_status) patch.subscription_status = "none";
    if (claim.paidBefore) {
      markPaidBefore();
      if (claim.planTitle && !lead.subscription_plan_title) patch.subscription_plan_title = claim.planTitle;
      verdict += "_paid_before";
    }
  }
  if (truth && truth.app_user_id && !lead.app_user_id) patch.app_user_id = String(truth.app_user_id);
  return { patch, verdict };
}

/* ───────────────────────── who is she ───────────────────────── */

async function resolveMerged(id) {
  // Follow a merged (history) lead to the one that's live now.
  for (let i = 0; i < 5 && id; i++) {
    const [[r]] = await sequelize.query("SELECT id, merged_into_lead_id FROM leads WHERE id = :id", { replacements: { id } });
    if (!r) return null;
    if (!r.merged_into_lead_id) return r.id;
    id = r.merged_into_lead_id;
  }
  return id;
}

/**
 * findExisting({ jids, lid, appUserId, phone, email }) → { id, by } | null
 * Order: her WhatsApp ids, her app account, her phone, her email.
 */
async function findExisting({ jids = [], lid = null, appUserId = null, phone = null, email = null }) {
  const ids = [...new Set(jids.filter(Boolean))];
  if (ids.length) {
    const [rows] = await sequelize.query(
      "SELECT id FROM leads WHERE whatsapp_jid IN (:ids) ORDER BY (merged_into_lead_id IS NULL) DESC, id ASC LIMIT 1",
      { replacements: { ids } }
    );
    if (rows[0]) return { id: await resolveMerged(rows[0].id), by: "whatsapp_id" };
  }
  if (lid && (await hasLidColumn())) {
    const [rows] = await sequelize.query(
      "SELECT id FROM leads WHERE whatsapp_lid = :lid ORDER BY (merged_into_lead_id IS NULL) DESC, id ASC LIMIT 1",
      { replacements: { lid } }
    );
    if (rows[0]) return { id: await resolveMerged(rows[0].id), by: "lid" };
  }
  if (appUserId) {
    const [rows] = await sequelize.query(
      "SELECT id FROM leads WHERE app_user_id = :a AND merged_into_lead_id IS NULL LIMIT 1",
      { replacements: { a: String(appUserId) } }
    );
    if (rows[0]) return { id: rows[0].id, by: "app_account" };
  }
  if (tail10(phone)) {
    const c = await frontDesk.findByPhoneLoosely(phone);
    if (c) return { id: c.id, by: "phone" };
  }
  const e = cleanEmail(email);
  if (e) {
    const [rows] = await sequelize.query(
      // Emails are stored lowercase (frontDesk.normalizeEmail), so a plain
      // comparison uses the email index; LOWER(email) would scan every lead.
      "SELECT id FROM leads WHERE email = :e AND merged_into_lead_id IS NULL LIMIT 2",
      { replacements: { e } }
    );
    if (rows.length === 1) return { id: rows[0].id, by: "email" };
  }
  return null;
}

/** Give a lead the WhatsApp ids we just learned, without moving a live chat. */
async function backfillIds(leadId, { pnJid = null, lid = null, phone = null } = {}) {
  const want = pnJid || lid;
  if (want) {
    await sequelize.query(
      "UPDATE leads SET whatsapp_jid = :j WHERE id = :id AND whatsapp_jid IS NULL",
      { replacements: { j: want, id: leadId } }
    ).catch(() => {}); // another lead already holds that id: leave it
  }
  if (lid && (await hasLidColumn())) {
    await sequelize.query(
      "UPDATE leads SET whatsapp_lid = :l WHERE id = :id AND whatsapp_lid IS NULL",
      { replacements: { l: lid, id: leadId } }
    ).catch(() => {});
  }
  if (phone) {
    await sequelize.query(
      "UPDATE leads SET phone = :p WHERE id = :id AND (phone IS NULL OR phone = '')",
      { replacements: { p: require("./phoneKey").normalize(phone) || phone, id: leadId } }
    ).catch(() => {}); // UNIQUE(phone, account) clash: keep what she has
  }
}

/* ─────────────────── write the decision + the trace ─────────────────── */

const LEAD_COLS = `id, stage, status, email, app_user_id, subscription_status, subscription_plan_title,
                   subscription_expires_at, subscription_amount, main_goal, notes`;

/**
 * applyIntake(leadId, { truth, claim, trace, isNew })
 *   trace: { campaignId, campaignName, source: 'group_import'|'number_upload',
 *            label: group name / batch name, noteParts: [] }
 * → { verdict, changed: [fields] }
 */
async function applyIntake(leadId, { truth, claim = {}, trace = {}, isNew = false }) {
  const [[lead]] = await sequelize.query(`SELECT ${LEAD_COLS} FROM leads WHERE id = :id`, { replacements: { id: leadId } });
  if (!lead) return { verdict: "missing", changed: [] };
  const { patch, verdict } = decide(lead, truth, claim);

  // app_user_id is UNIQUE: if another lead already holds her app account,
  // don't steal it; say so in the note for a person to merge.
  let appNote = "";
  if (patch.app_user_id) {
    const [[other]] = await sequelize.query(
      "SELECT id FROM leads WHERE app_user_id = :a AND id <> :id LIMIT 1",
      { replacements: { a: patch.app_user_id, id: leadId } }
    );
    if (other) {
      delete patch.app_user_id;
      appNote = ` (app account #${truth.app_user_id} is on lead ${other.id}, "Same person?" sent to the rep)`;
      await suggestSamePerson(other.id, leadId, `Phone matches app account #${truth.app_user_id} (campaign import)`);
    }
  }

  // The note line: when, which campaign, what the app said, sheet extras.
  const day = new Date().toISOString().slice(0, 10);
  const where = [trace.campaignName ? `campaign "${trace.campaignName}"` : null,
                 trace.label ? `${trace.source === "group_import" ? "group" : "sheet"} "${trace.label}"` : null]
    .filter(Boolean).join(", ");
  const appLine = truth && truth.status
    ? `App: ${truth.status}${truth.plan_title ? ` ${truth.plan_title}` : ""}${truth.expires_at ? ` until ${String(truth.expires_at).slice(0, 10)}` : ""}`
    : truth === null ? "App: no account" : "App: not checked";
  const extras = (trace.noteParts || []).join(", ");
  const line = `[${day}] Imported for ${where || "a campaign"}. ${appLine}${appNote}${extras ? `. ${extras}` : ""}`.slice(0, 900);
  if (!String(lead.notes || "").includes(line)) {
    patch.notes = lead.notes ? `${lead.notes}\n${line}` : line;
  }

  const fields = Object.keys(patch);
  if (fields.length) {
    try {
      await sequelize.query(
        `UPDATE leads SET ${fields.map((f) => `\`${f}\` = :${f}`).join(", ")}${truth ? ", app_synced_at = NOW()" : ""} WHERE id = :id`,
        { replacements: { ...patch, id: leadId } }
      );
    } catch (e) {
      console.warn(`[campaignIntake] lead ${leadId} not fully updated: ${e.message}`);
    }
  }

  // Event for the timeline. processed = 1: a record, not an automation trigger.
  try {
    const { Event } = require("../../models");
    await Event.create({
      event_id: uuidv4(),
      lead_id: leadId,
      event_type: "campaign_intake",
      payload: {
        campaign_id: trace.campaignId || null, campaign: trace.campaignName || null,
        source: trace.source || null, label: trace.label || null,
        is_new: !!isNew, verdict, app_status: truth ? truth.status : truth === null ? "no_account" : "not_checked",
        changed: fields.filter((f) => f !== "notes"),
      },
      processed: 1,
    });
  } catch (e) { /* the note already carries the trace */ }

  // A brand-new woman gets her pipeline row in the right place.
  if (isNew) {
    const pipeStage = verdict === "active" ? "converted" : verdict === "trial" && !claim.paidBefore ? "trialing"
      : (patch.stage || lead.stage) === "churned" ? "churned" : "new";
    try {
      const { Pipeline } = require("../../models");
      await Pipeline.upsert({ pipeline_id: uuidv4(), lead_id: leadId, stage: pipeStage, assigned_agent_id: null, stage_entered_at: new Date() });
    } catch {}
  }
  return { verdict, changed: fields };
}

/**
 * The app account matched by phone already sits on another lead. Per the
 * identity rule a phone match is never an automatic merge: open a
 * suggestion so the rep sees "Same person?" on both leads.
 *   lead_id = the lead holding the app account, candidate = this one.
 */
async function suggestSamePerson(appLeadId, leadId, detail) {
  try {
    await sequelize.query(
      `INSERT IGNORE INTO lead_match_suggestions (lead_id, candidate_lead_id, reason, detail)
       VALUES (:a, :c, 'phone', :d)`,
      { replacements: { a: appLeadId, c: leadId, d: String(detail || "").slice(0, 255) } }
    );
  } catch (e) {
    if (!/lead_match_suggestions/.test(String(e.message))) console.warn("[campaignIntake] suggestion not saved:", e.message);
  }
}

/**
 * refreshFromApp(leadId, phone) — her number just became known (WhatsApp
 * revealed it behind an @lid). Ask the app whether she has an account and a
 * live plan, and record it like the nightly plan sync would. Fire and
 * forget: never throws, never blocks a message.
 */
async function refreshFromApp(leadId, phone) {
  try {
    if (!tail10(phone)) return null;
    const map = await lookupApp([{ key: "x", phone }]);
    const truth = map.get("x");
    if (!truth) return { verdict: "not_in_app" };
    const [[lead]] = await sequelize.query(`SELECT ${LEAD_COLS} FROM leads WHERE id = :id`, { replacements: { id: leadId } });
    if (!lead) return null;
    const { patch, verdict } = decide(lead, truth, {});
    if (patch.app_user_id) {
      const [[other]] = await sequelize.query(
        "SELECT id FROM leads WHERE app_user_id = :a AND id <> :id LIMIT 1",
        { replacements: { a: patch.app_user_id, id: leadId } }
      );
      if (other) {
        delete patch.app_user_id;
        await suggestSamePerson(other.id, leadId, `WhatsApp number ${phone} matches app account #${truth.app_user_id}`);
      }
    }
    const fields = Object.keys(patch);
    if (fields.length) {
      await sequelize.query(
        `UPDATE leads SET ${fields.map((f) => `\`${f}\` = :${f}`).join(", ")}, app_synced_at = NOW() WHERE id = :id`,
        { replacements: { ...patch, id: leadId } }
      );
    }
    try {
      const { writeActivity } = require("./activity.service");
      await writeActivity(leadId, "app_status_checked", "whatsapp", { trigger: "number_revealed", verdict, app_status: truth.status, changed: fields });
    } catch {}
    return { verdict, changed: fields };
  } catch (e) {
    console.warn(`[campaignIntake] app check for lead ${leadId} skipped: ${e.message}`);
    return null;
  }
}

/* ───────────────────── A/B pairs (migration 047) ───────────────────── */

// A woman's side: SHA-256 of "<test id>:<lead id>", first byte, odd or even.
// Fixed forever for one test, and independent between tests (a CRC was
// tried first: it is linear, so ~99% of women landed on the same side in
// every test, which would compare the same two groups again and again).
const crypto = require("crypto");
/** Which side (0 or 1) of A/B pair `groupId` a lead belongs to. Fixed forever. */
function armFor(groupId, leadId) {
  return crypto.createHash("sha256").update(`${groupId}:${leadId}`).digest()[0] & 1;
}

/**
 * abInfo(campaignId) → null, or { groupId, arms: [campaign0, campaign1] }
 * (each { campaign_id, name, status, ab_arm }). Null before migration 047.
 */
async function abInfo(campaignId) {
  try {
    const [[c]] = await sequelize.query(
      "SELECT ab_group_id FROM campaigns WHERE campaign_id = :id", { replacements: { id: campaignId } }
    );
    if (!c || !c.ab_group_id) return null;
    const [rows] = await sequelize.query(
      "SELECT campaign_id, name, status, ab_arm FROM campaigns WHERE ab_group_id = :g ORDER BY ab_arm",
      { replacements: { g: c.ab_group_id } }
    );
    const arms = [rows.find((r) => Number(r.ab_arm) === 0), rows.find((r) => Number(r.ab_arm) === 1)];
    if (!arms[0] || !arms[1]) return null;
    return { groupId: c.ab_group_id, arms };
  } catch (e) {
    if (/ab_group_id/i.test(String(e.message || ""))) return null; // migration 047 not run
    throw e;
  }
}
/** The campaign a lead belongs to: her side of the pair, or the campaign itself. */
function campaignFor(ab, campaign, leadId) {
  return ab ? ab.arms[armFor(ab.groupId, leadId)] : campaign;
}

/* ─────────────────────── campaign recipients ─────────────────────── */

const COOLDOWN_DAYS = (() => {
  const n = parseInt(process.env.CAMPAIGN_COOLDOWN_DAYS, 10);
  return Number.isFinite(n) && n >= 0 ? n : 7;
})();
// Same list as the sender (broadcastWorker) and campaign.routes: the admin's
// own number is built in, more via CAMPAIGN_EXCLUDED_PHONES. Without the
// built-in one here, that number showed as "added" and was then silently
// skipped at send time.
const EXCLUDED = new Set([
  "3055124674", // 03055124674, admin's own number
  ...String(process.env.CAMPAIGN_EXCLUDED_PHONES || "").split(",").map(tail10).filter(Boolean),
]);

/**
 * addRecipients(campaignId, leadIds, { allowOverlap }) — the same filters
 * every door uses, and true counts of who went in and why the rest didn't:
 *   already         already in this campaign
 *   opted_out       asked us to stop
 *   excluded        internal / admin numbers
 *   cooldown        messaged by a campaign in the last N days
 *   (ignoreCooldown: true skips the cooldown rule, for test sends)
 *   in_other_campaign  waiting in another draft or live campaign (so two
 *                   campaigns on the same sheet or group never both message
 *                   her). allowOverlap: true turns this one off.
 *   other_side_locked  A/B: her side's campaign has already started
 * A/B pair: each lead goes to HER side's campaign, whichever one was called.
 */
async function addRecipients(campaignId, leadIds, { allowOverlap = false, ignoreCooldown = false } = {}) {
  const ids = [...new Set(leadIds.map(Number).filter((x) => x > 0))];
  const out = { added: 0, already: 0, opted_out: 0, excluded: 0, cooldown: 0, in_other_campaign: 0, other_side_locked: 0, by_campaign: {} };
  if (!ids.length) return out;

  const ab = await abInfo(campaignId);
  const groups = new Map(); // campaign_id → { campaign, ids }
  if (ab) {
    for (const id of ids) {
      const c = campaignFor(ab, null, id);
      if (!groups.has(c.campaign_id)) groups.set(c.campaign_id, { campaign: c, ids: [] });
      groups.get(c.campaign_id).ids.push(id);
    }
  } else {
    groups.set(campaignId, { campaign: { campaign_id: campaignId, status: "draft" }, ids });
  }

  // Another campaign "holds" her while she is waiting in it and it hasn't
  // finished. Her own A/B pair never counts as a conflict.
  const pairSql = ab ? "AND (c2.ab_group_id IS NULL OR c2.ab_group_id <> :g)" : "";
  const otherSql = allowOverlap ? "0" : `EXISTS (SELECT 1 FROM campaign_recipients o
                JOIN campaigns c2 ON c2.campaign_id = o.campaign_id
               WHERE o.lead_id = l.id AND o.campaign_id <> :cid
                 AND o.status IN ('queued','sending')
                 AND c2.status IN ('draft','queued','scheduled','running','paused')
                 ${pairSql})`;

  for (const [cid, { campaign, ids: groupIds }] of groups) {
    if (campaign.status !== "draft") { out.other_side_locked += groupIds.length; continue; }
    let addedHere = 0;
    for (let i = 0; i < groupIds.length; i += 1000) {
      const chunk = groupIds.slice(i, i + 1000);
      const [rows] = await sequelize.query(
        `SELECT l.id, l.phone,
                EXISTS (SELECT 1 FROM dnc_list d WHERE d.lead_id = l.id) AS dnc,
                (l.interaction_status = 'opted_out') AS opted,
                EXISTS (SELECT 1 FROM campaign_recipients x WHERE x.campaign_id = :cid AND x.lead_id = l.id) AS already,
                ${COOLDOWN_DAYS > 0 && !ignoreCooldown ? `EXISTS (SELECT 1 FROM campaign_recipients r
                         WHERE r.lead_id = l.id AND r.status IN ('sent','delivered','read','replied')
                           AND r.sent_at >= DATE_SUB(NOW(), INTERVAL ${COOLDOWN_DAYS} DAY))` : "0"} AS cool,
                ${otherSql} AS other
           FROM leads l WHERE l.id IN (:ids)`,
        { replacements: { cid, ids: chunk, g: ab ? ab.groupId : null } }
      );
      const ok = [];
      for (const r of rows) {
        if (Number(r.already)) { out.already++; continue; }
        if (Number(r.dnc) || Number(r.opted)) { out.opted_out++; continue; }
        if (EXCLUDED.has(tail10(r.phone))) { out.excluded++; continue; }
        if (Number(r.cool)) { out.cooldown++; continue; }
        if (Number(r.other)) { out.in_other_campaign++; continue; }
        ok.push(r.id);
      }
      if (ok.length) {
        const [res] = await sequelize.query(
          `INSERT IGNORE INTO campaign_recipients (campaign_id, lead_id) SELECT :cid, id FROM leads WHERE id IN (:ok)`,
          { replacements: { cid, ok } }
        );
        const n = res && res.affectedRows != null ? res.affectedRows : ok.length;
        addedHere += n;
        out.already += ok.length - n;
      }
    }
    out.added += addedHere;
    out.by_campaign[cid] = addedHere;
    await sequelize.query(
      `UPDATE campaigns SET total_recipients = (SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id = :cid) WHERE campaign_id = :cid`,
      { replacements: { cid } }
    );
  }
  return out;
}

/** The account a campaign sends from: pinned, else where most of its recipients are, else the default. */
async function campaignAccount(campaign) {
  if (campaign && campaign.whatsapp_account_id) return Number(campaign.whatsapp_account_id);
  if (campaign && campaign.campaign_id) {
    const [[r]] = await sequelize.query(
      `SELECT l.whatsapp_account_id AS acc FROM campaign_recipients cr JOIN leads l ON l.id = cr.lead_id
        WHERE cr.campaign_id = :cid AND l.whatsapp_account_id IS NOT NULL
        GROUP BY l.whatsapp_account_id ORDER BY COUNT(*) DESC LIMIT 1`,
      { replacements: { cid: campaign.campaign_id } }
    );
    if (r && r.acc) return Number(r.acc);
  }
  return Number(process.env.META_DEFAULT_WA_ACCOUNT_ID || 1);
}

module.exports = {
  tail10, cleanEmail, mapGoal, readSheetExtras, decide,
  lookupApp, findExisting, backfillIds, applyIntake, addRecipients, campaignAccount, hasLidColumn,
  armFor, abInfo, campaignFor, refreshFromApp, suggestSamePerson,
};
