/**
 * whatsappIdentity.js — one WhatsApp account = one lead (Nov 2026).
 *
 * WhatsApp can address the same woman two ways: her number
 * (923001234567@s.whatsapp.net) or a hidden @lid. A group import or a first
 * message under the @lid gave us a lead with no number. When she writes,
 * WhatsApp usually hands us the OTHER id too (remoteJidAlt, or Baileys' own
 * lid ↔ number map). That pairing comes from WhatsApp itself, so it PROVES
 * both ids are one account. This file acts on that proof:
 *
 *   1. remember both ids on her lead (whatsapp_jid + whatsapp_lid);
 *   2. if another lead holds the other id, or holds her number while this
 *      one had none, they are the same woman: merge them (history kept,
 *      the duplicate is hidden, every merge goes on the timeline);
 *   3. her number is new to us: ask the app whether she has an account and
 *      a live plan (campaignIntake.refreshFromApp), in the background.
 *
 * NOT merged here: two leads that merely share a typed phone or email. Those
 * stay suggestions for a rep (identity.routes.js), as before.
 */
const sequelize = require("../config/database");

const isLid = (j) => /@lid$/.test(String(j || ""));
const isPn = (j) => /@s\.whatsapp\.net$/.test(String(j || ""));
const tail10 = (p) => { const d = String(p || "").replace(/\D/g, ""); return d.length >= 10 ? d.slice(-10) : null; };

/**
 * Score: which of two leads survives a merge. App account first (her real
 * identity), then a paying member, then the one with a number, then the oldest.
 */
function survivorOf(a, b) {
  const score = (l) => (l.app_user_id ? 8 : 0) + (l.stage === "user" ? 4 : 0) + (l.phone ? 2 : 0);
  const sa = score(a), sb = score(b);
  if (sa !== sb) return sa > sb ? [a, b] : [b, a];
  return Number(a.id) < Number(b.id) ? [a, b] : [b, a];
}

const LEAD_COLS = "id, phone, name, email, stage, app_user_id, whatsapp_jid, assigned_to, notes, interaction_status, merged_into_lead_id";

async function lidColumn() {
  return require("./campaignIntake").hasLidColumn();
}

// Every table that points at a lead and should follow her to the survivor.
// UPDATE IGNORE: a row that would clash (e.g. both leads in one campaign)
// stays on the hidden duplicate. Missing tables are skipped.
const CHILD_TABLES = [
  "messages", "ai_replies", "activities", "events", "escalations", "rep_tasks",
  "payment_requests", "campaign_recipients", "dnc_list", "app_issues",
];

/**
 * mergeLeads(fromId, toId, reason) — fold one lead into another. Returns true
 * when done. Never throws.
 */
async function mergeLeads(fromId, toId, reason) {
  try {
    const [[from]] = await sequelize.query(`SELECT ${LEAD_COLS} FROM leads WHERE id = :id`, { replacements: { id: fromId } });
    const [[to]] = await sequelize.query(`SELECT ${LEAD_COLS} FROM leads WHERE id = :id`, { replacements: { id: toId } });
    if (!from || !to || from.merged_into_lead_id || to.merged_into_lead_id) return false;

    const moved = {};
    for (const t of CHILD_TABLES) {
      try {
        const [r] = await sequelize.query(`UPDATE IGNORE \`${t}\` SET lead_id = :to WHERE lead_id = :from`, { replacements: { to: toId, from: fromId } });
        if (r && r.affectedRows) moved[t] = r.affectedRows;
      } catch (e) {
        if (!/doesn't exist|unknown column/i.test(String(e.message))) console.warn(`[whatsappIdentity] ${t} not moved: ${e.message}`);
      }
    }

    // Unique ids leave the duplicate first, then fill the survivor's blanks.
    const fromJid = from.whatsapp_jid, fromApp = from.app_user_id;
    const hasLid = await lidColumn();
    let fromLid = null;
    if (hasLid) {
      const [[r]] = await sequelize.query("SELECT whatsapp_lid FROM leads WHERE id = :id", { replacements: { id: fromId } });
      fromLid = r && r.whatsapp_lid;
    }
    const lidToKeep = fromLid || (isLid(fromJid) ? fromJid : null);
    // Her old id can move only if the survivor has room for it; otherwise it
    // stays on the hidden duplicate and frontDesk follows the merge pointer.
    const jidMoves = fromJid && (!to.whatsapp_jid || (hasLid && isLid(fromJid)));
    await sequelize.query(
      `UPDATE leads SET merged_into_lead_id = :to, app_user_id = NULL
              ${jidMoves ? ", whatsapp_jid = NULL" : ""}
        WHERE id = :from`,
      { replacements: { to: toId, from: fromId } }
    );

    const day = new Date().toISOString().slice(0, 10);
    const line = `[${day}] Merged lead #${fromId} into this one (${reason}).`;
    const sets = [
      "phone = COALESCE(NULLIF(phone, ''), :phone)",
      "name = COALESCE(NULLIF(name, ''), :name)",
      "email = COALESCE(NULLIF(email, ''), :email)",
      "assigned_to = COALESCE(assigned_to, :rep)",
      "notes = CONCAT(COALESCE(notes, ''), IF(notes IS NULL OR notes = '', '', '\\n'), :line)",
    ];
    const rep = { id: toId, phone: from.phone || null, name: from.name || null, email: from.email || null, rep: from.assigned_to || null, line };
    if (fromApp && !to.app_user_id) { sets.push("app_user_id = :app"); rep.app = fromApp; }
    if (jidMoves && !to.whatsapp_jid) { sets.push("whatsapp_jid = :jid"); rep.jid = fromJid; }
    if (hasLid && lidToKeep) { sets.push("whatsapp_lid = COALESCE(whatsapp_lid, :lid)"); rep.lid = lidToKeep; }
    // An opt-out on either record holds for her.
    if (from.interaction_status === "opted_out") sets.push("interaction_status = 'opted_out'");
    try {
      await sequelize.query(`UPDATE leads SET ${sets.join(", ")} WHERE id = :id`, { replacements: rep });
    } catch (e) {
      // e.g. her phone already sits on another lead of this account: keep the rest
      console.warn(`[whatsappIdentity] survivor ${toId} not fully topped up: ${e.message}`);
      delete rep.phone;
      await sequelize.query(`UPDATE leads SET ${sets.filter((s) => !s.startsWith("phone")).join(", ")} WHERE id = :id`, { replacements: rep }).catch(() => {});
    }

    try {
      const { writeActivity } = require("./activity.service");
      await writeActivity(toId, "identity_merged", "whatsapp", { from_lead: fromId, reason, moved });
    } catch {}
    console.log(`🔗 [whatsappIdentity] lead ${fromId} merged into ${toId} (${reason})`, moved);
    return true;
  } catch (e) {
    console.error(`[whatsappIdentity] merge ${fromId} → ${toId} failed: ${e.message}`);
    return false;
  }
}

/**
 * reconcile(contact, { identity, altIdentity, phone, hadPhone })
 *   contact      the lead frontDesk found (Sequelize instance)
 *   identity     the jid the message came on
 *   altIdentity  the other jid WhatsApp sent with it (may be null)
 *   phone        her number, when WhatsApp gave it (never typed)
 *   hadPhone     did the lead have a number before this message
 * → the lead to use from now on (the survivor). Never throws.
 */
async function reconcile(contact, { identity, altIdentity = null, phone = null, hadPhone = true } = {}) {
  try {
    if (!contact || !contact.id) return contact;
    const ids = [identity, altIdentity].filter(Boolean);
    const lid = ids.find(isLid) || null;
    const pnJid = ids.find(isPn) || (tail10(phone) ? `${String(phone).replace(/\D/g, "")}@s.whatsapp.net` : null);
    const hasLid = await lidColumn();

    if (hasLid && lid) {
      await sequelize.query(
        "UPDATE leads SET whatsapp_lid = :lid WHERE id = :id AND whatsapp_lid IS NULL",
        { replacements: { lid, id: contact.id } }
      ).catch(() => {});
    }

    // Other leads WhatsApp proves are her.
    const jids = [lid, pnJid].filter(Boolean);
    const where = [];
    const rep = { id: contact.id };
    if (jids.length) { where.push("whatsapp_jid IN (:jids)"); rep.jids = jids; }
    if (hasLid && lid) { where.push("whatsapp_lid = :lid"); rep.lid = lid; }
    // Her number, proven by WhatsApp, on another lead, while THIS lead was the
    // number-less one: the classic @lid duplicate.
    const tail = tail10(phone);
    if (tail && !hadPhone) {
      where.push(await require("./phoneKey").tailSql()); // indexed (migration 049)
      rep.tail = tail;
    }
    // ...or the other lead is number-less and carries one of her ids (covered
    // by the jid / lid conditions above).
    if (!where.length) return contact;

    const [others] = await sequelize.query(
      `SELECT ${LEAD_COLS} FROM leads
        WHERE id <> :id AND merged_into_lead_id IS NULL AND (${where.join(" OR ")})
        ORDER BY id ASC LIMIT 4`,
      { replacements: rep }
    );
    if (!others.length) return contact;
    if (others.length > 3) {
      console.warn(`[whatsappIdentity] lead ${contact.id}: ${others.length} matches, too many to merge on its own`);
      return contact;
    }

    const [[me]] = await sequelize.query(`SELECT ${LEAD_COLS} FROM leads WHERE id = :id`, { replacements: { id: contact.id } });
    let current = me;
    for (const other of others) {
      // Two different app accounts = two different women, whatever WhatsApp says.
      if (current.app_user_id && other.app_user_id && String(current.app_user_id) !== String(other.app_user_id)) {
        console.warn(`[whatsappIdentity] leads ${current.id} and ${other.id} have different app accounts, not merged`);
        continue;
      }
      const [keep, drop] = survivorOf(current, other);
      if (await mergeLeads(drop.id, keep.id, "same WhatsApp account")) {
        const [[k]] = await sequelize.query(`SELECT ${LEAD_COLS} FROM leads WHERE id = :id`, { replacements: { id: keep.id } });
        current = k;
      }
    }
    if (Number(current.id) === Number(contact.id)) { await contact.reload().catch(() => {}); return contact; }
    const { People } = require("../../models");
    return (await People.findByPk(current.id)) || contact;
  } catch (e) {
    console.error(`[whatsappIdentity] reconcile ${contact && contact.id} failed: ${e.message}`);
    return contact;
  }
}

module.exports = { reconcile, mergeLeads, survivorOf, isLid, isPn };
