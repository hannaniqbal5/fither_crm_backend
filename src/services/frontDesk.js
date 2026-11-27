/**
 * frontDesk.js — THE ONE DOOR IN AND THE ONE DOOR OUT.
 *
 * WHY THIS EXISTS
 *   Seven different files used to create a woman in this database
 *   (message.handler, meta/webhook.handler, app_integration/handlers,
 *   groupImporter, numberUpload.routes, fizzaChats.routes, lead.service).
 *   Seven authors, seven slightly different ideas of what a lead is. So
 *   depending on which door she walked through she could arrive with no
 *   owner, as a duplicate, or not at all:
 *     • Instagram skipped the opt-out check entirely.
 *     • A rep messaging a brand-new number from their own phone saved nothing.
 *     • Fiza's auto-replies were rejected by the DB (sender 'ai' isn't in the
 *       `from` enum), so the silence clock never moved and the follow-up
 *       engine messaged on top of her.
 *
 *   Those were not four bugs. They were one bug — the same code written four
 *   times — so this file is the single copy that replaces them.
 *
 * THE FIVE CHECKS, in one place, for every channel:
 *   1. Do we already know her?      → never a duplicate
 *   2. Who owns her?                → always someone, never nobody
 *   3. Did she ask us to stop?      → nothing goes out
 *   4. Write the message down       → inbound and outbound, always
 *   5. Note when we last spoke      → so nothing messages her again at once
 *
 * WHAT THIS FILE DOES NOT DO
 *   It does not decide anything about the journey (that's the CRM's own
 *   intent layers), and it does not send (that's channels/*). It only
 *   records. Keeping it dumb is what makes it safe to route everything here.
 */

const sequelize = require("../config/database");
const { People, Message } = require("../../models");
const { insertIdOf } = require("../utils/insertId");
const { getNextRepRoundRobin } = require("./assignment.service");

/* ─────────────────────────────────────────────────────────────
   Channel facts. Adding a channel = one row in each map.
   ───────────────────────────────────────────────────────────── */

// How each channel identifies a woman. "phone" is for the doors that have
// nothing else: a bulk number upload, a group import, an admin opening a chat
// by typing a number.
const IDENTITY_COLUMN = {
  whatsapp:  "whatsapp_jid",
  instagram: "instagram_psid",
  facebook:  "facebook_psid",
  phone:     "phone",
};

// Where each channel's display name lives.
const NAME_COLUMN = {
  whatsapp:  "name",
  instagram: "instagram_username",
  facebook:  "facebook_name",
};

// leads.whatsapp_account_id is NOT NULL, so non-WhatsApp contacts still need
// an account to hang off. This used to be hardcoded to 1 inside the Meta
// handler while round-robin was called with no account at all, which is how
// an Instagram lead could land on a rep who sits on a different number.
// One value, used for BOTH the stamp and the rep lookup, so they always agree.
function defaultAccountId() {
  return Number(process.env.META_DEFAULT_WA_ACCOUNT_ID || 1);
}

/**
 * `entry_gate` (migration 038) records WHICH DOOR she came through, as opposed
 * to `source`, which records the channel. Four different gates used to read as
 * 'whatsapp': she wrote in, a rep messaged her from the shared phone, an
 * uploaded number list, a group import.
 *
 * Deploy order should not matter, so if the column isn't there yet the insert
 * is retried without it and we stop trying for the rest of the process. Same
 * approach app_integration/handlers.js takes for app_phone.
 */
let gateColumnMissing = false;
function isMissingGateColumn(err) {
  const m = String((err && err.message) || "");
  return /entry_gate/i.test(m) && /unknown column|doesn't exist|no such column/i.test(m);
}

/**
 * Email is the SECOND key that can join a woman here to her app account, and
 * until now nothing on the message side ever filled it: only the app
 * integration did, and only for women already linked. So a woman who arrived
 * on WhatsApp had a phone and nothing else, and if her app account had no
 * phone the two could never be connected.
 *
 * Stored lowercase and trimmed, so "Ayesha@Gmail.com " and "ayesha@gmail.com"
 * are one address instead of two.
 */
function normalizeEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e || e.length > 180) return null;
  // Deliberately permissive: one @, something either side, a dot in the domain.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

/**
 * Pakistani numbers reach us written half a dozen ways: +923001234567,
 * 923001234567, 03001234567, with spaces, with dashes. The last ten digits are
 * the part that never changes, which is how numberUpload.routes.js has always
 * matched them. Doing it here means every door agrees on who is a duplicate.
 */
function last10(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : null;
}

async function findByPhoneLoosely(phone) {
  const tail = last10(phone);
  if (!tail) return null;
  // Indexed leads.phone_last10 (migration 049) via phoneKey.tailSql.
  const match = await require("./phoneKey").tailSql();
  const [rows] = await sequelize.query(
    `SELECT id FROM leads
      WHERE ${match}
        AND merged_into_lead_id IS NULL
      ORDER BY (assigned_to IS NOT NULL) DESC, last_message_at DESC, id ASC
      LIMIT 1`,
    { replacements: { tail } }
  );
  return rows.length ? People.findByPk(rows[0].id) : null;
}

/** Same number (last 10 digits) on one WhatsApp line. */
async function findOnAccountByPhone(phone, account) {
  const tail = last10(phone);
  if (!tail || account == null) return null;
  const match = await require("./phoneKey").tailSql();
  const [rows] = await sequelize.query(
    `SELECT id FROM leads
      WHERE ${match} AND whatsapp_account_id = :acc AND merged_into_lead_id IS NULL
      ORDER BY id ASC LIMIT 1`,
    { replacements: { tail, acc: account } }
  );
  return rows.length ? People.findByPk(rows[0].id) : null;
}

/**
 * A woman we already know by phone but who has never written on WhatsApp
 * (she signed up in the app, or her number was uploaded). Only leads with NO
 * WhatsApp id qualify, so an existing WhatsApp chat is never taken over.
 * Exactly one match, or nothing (two leads with that number = a rep decides).
 * Her phone or, for an app lead, the number she typed in the app.
 */
async function findUnclaimedByPhone(phone) {
  const tail = last10(phone);
  if (!tail) return null;
  const match = await require("./phoneKey").tailSql("", { withApp: true });
  const [rows] = await sequelize.query(
    `SELECT id FROM leads
      WHERE ${match}
        AND whatsapp_jid IS NULL
        AND merged_into_lead_id IS NULL
      LIMIT 2`,
    { replacements: { tail } }
  );
  return rows.length === 1 ? People.findByPk(rows[0].id) : null;
}

/* ─────────────────────────────────────────────────────────────
   Sender names. messages.`from` is ENUM('user','rep','bot') and has never
   been extended, so anything else is silently rejected by MySQL in strict
   mode. Callers write 'ai', 'fizza', 'customer' — all reasonable words, none
   of them valid. Normalise here instead of trusting every call site.
   ───────────────────────────────────────────────────────────── */
function normalizeSender(from, direction) {
  const f = String(from || "").toLowerCase();
  if (["ai", "bot", "fiza", "fizza", "automation", "system"].includes(f)) return "bot";
  if (["rep", "agent", "admin", "sales_rep", "salesrep"].includes(f))     return "rep";
  if (["user", "customer", "lead", "contact", "her"].includes(f))         return "user";
  // Unknown word: fall back on the direction, which is never ambiguous.
  return direction === "IN" ? "user" : "rep";
}

/* ─────────────────────────────────────────────────────────────
   CHECK 3 — did she ask us to stop?
   ───────────────────────────────────────────────────────────── */
async function isSilenced(contact) {
  try {
    if (!contact || !contact.id) return true;
    if (contact.interaction_status === "opted_out") return true;
    const [dnc] = await sequelize.query(
      "SELECT 1 FROM dnc_list WHERE lead_id = ? LIMIT 1",
      { replacements: [contact.id] }
    );
    return dnc.length > 0;
  } catch (e) {
    // Fail CLOSED on an opt-out check. Messaging a woman who asked us to stop
    // is worse than missing one message.
    console.error("[frontDesk] opt-out check failed, treating as silenced:", e.message);
    return true;
  }
}

/* ─────────────────────────────────────────────────────────────
   CHECKS 1 + 2 — do we know her, and who owns her?
   ───────────────────────────────────────────────────────────── */

/**
 * findOrCreateContact — the only way a woman enters this database.
 *
 * @param {object}  args
 * @param {string}  args.channel      "whatsapp" | "instagram" | "facebook"
 * @param {string}  args.identity     her id on that channel (jid or psid)
 * @param {number}  [args.accountId]  WhatsApp account this arrived on
 * @param {string}  [args.phone]      when known (WhatsApp, or resolved LID)
 * @param {string}  [args.name]       display name / username when known
 * @param {string}  [args.email]      when known (app signup, or a rep types it)
 * @param {number}  [args.metaPageId] meta_pages.id for IG/FB contacts
 * @param {string}  [args.source]     defaults to the channel
 * @param {string}  [args.stage]      defaults to "visitor"
 * @param {string}  [args.status]     defaults to "new"
 * @param {boolean} [args.assignOwner] false to skip round-robin (bulk imports
 *                                     that carry their own rep)
 * @param {number}  [args.repId]      an owner chosen by the caller
 * @param {boolean} [args.loosePhone] match on the last 10 digits (bulk doors)
 * @param {string}  [args.gate]       which door she came through, e.g.
 *                                    "whatsapp_inbound", "number_upload"
 * @param {object}  [args.extra]      further columns to set on creation only
 * @param {string}  [args.altIdentity] WhatsApp: her OTHER id sent with the
 *                                    message (@lid when identity is her number,
 *                                    or the reverse). Proves both are one account.
 * @returns {Promise<{contact: object, isNew: boolean}>}
 */
async function findOrCreateContact({
  channel,
  identity,
  accountId = null,
  phone = null,
  name = null,
  email = null,
  metaPageId = null,
  source = null,
  stage = "visitor",
  status = "new",
  assignOwner = true,
  repId = null,
  loosePhone = false,
  gate = null,
  extra = null,
  altIdentity = null,
}) {
  const idColumn = IDENTITY_COLUMN[channel];
  if (!idColumn) throw new Error(`frontDesk: unknown channel "${channel}"`);
  // Every phone is saved one way: international digits, no '+'
  // ("0300-1234567" → "923001234567"), so the same number is the same text.
  if (phone) phone = require("./phoneKey").normalize(phone) || String(phone).replace(/\D/g, "") || null;
  // A phone-only door passes just a phone; that IS her identity.
  if (!identity && channel === "phone") identity = phone;
  if (!identity) throw new Error(`frontDesk: no identity given for ${channel}`);

  const account = accountId != null ? Number(accountId) : defaultAccountId();
  const cleanEmail = normalizeEmail(email);

  // 1a. Known by her id on this channel?
  let contact = await People.findOne({ where: { [idColumn]: identity } });

  // 1a2. WhatsApp: known under her OTHER id. Either the alt jid WhatsApp sent
  //      with this message is her saved chat id, or one of her ids is kept as
  //      leads.whatsapp_lid (migration 046; that part is skipped before 046).
  if (!contact && channel === "whatsapp") {
    if (altIdentity) contact = await People.findOne({ where: { whatsapp_jid: altIdentity } });
    const lids = [identity, altIdentity].filter((j) => /@lid$/.test(String(j || "")));
    if (!contact && lids.length) {
      try {
        const [rows] = await sequelize.query(
          "SELECT id FROM leads WHERE whatsapp_lid IN (:lids) ORDER BY (merged_into_lead_id IS NULL) DESC, id ASC LIMIT 1",
          { replacements: { lids } }
        );
        if (rows.length) contact = await People.findByPk(rows[0].id);
      } catch (e) {
        if (!/whatsapp_lid/i.test(String(e.message || ""))) console.warn("[frontDesk] lid lookup failed:", e.message);
      }
    }
  }

  // A merged (hidden) duplicate still holds some old ids: follow it to the
  // lead that is live now, so her message lands where her history is.
  for (let hops = 0; contact && contact.merged_into_lead_id && hops < 5; hops++) {
    contact = (await People.findByPk(contact.merged_into_lead_id)) || null;
  }

  // 1b. WhatsApp only: the JID can change (WhatsApp moves contacts to an @lid
  //     JID and sometimes back). Find her by phone on this account and
  //     re-point the JID rather than creating a second record.
  if (!contact && channel === "whatsapp" && phone && account != null) {
    contact = await findOnAccountByPhone(phone, account);
    if (contact) {
      const oldJid = contact.whatsapp_jid;
      try {
        await contact.update({ whatsapp_jid: identity });
        console.log(`[frontDesk] contact ${contact.id} JID moved ${oldJid} -> ${identity}`);
      } catch (e) {
        console.warn(`[frontDesk] contact ${contact.id} JID move not saved: ${e.message}`);
      }
    }
  }

  // 1b2. WhatsApp: her first WhatsApp message, but we already know her number
  //      from the app or an upload. Give that lead her WhatsApp id instead of
  //      making a second one. If she is on another of our numbers' lists, she
  //      moves to the number she actually wrote to, and gets a rep who works
  //      that number (her old rep could not see or answer it).
  if (!contact && channel === "whatsapp" && phone) {
    const known = await findUnclaimedByPhone(phone);
    if (known) {
      const patch = { whatsapp_jid: identity };
      if (!known.phone) patch.phone = phone;
      if (account != null && Number(known.whatsapp_account_id) !== account) {
        patch.whatsapp_account_id = account;
        let repOk = false;
        if (known.assigned_to) {
          const [[r]] = await sequelize.query("SELECT whatsapp_account_id FROM sales_reps WHERE id = :id AND status = 'active'", { replacements: { id: known.assigned_to } });
          repOk = !!r && Number(r.whatsapp_account_id) === account;
        }
        if (!repOk) {
          const next = await getNextRepRoundRobin(account).catch(() => null);
          patch.assigned_to = next ? next.id : null;
        }
      }
      try {
        await known.update(patch);
        contact = known;
        console.log(`[frontDesk] ${phone} wrote on WhatsApp for the first time → existing lead ${known.id} (${known.source || "?"})`);
      } catch (e) {
        console.warn(`[frontDesk] could not give lead ${known.id} her WhatsApp id: ${e.message}`);
      }
    }
  }

  // 1c. Bulk doors: the same woman written a different way is still her.
  if (!contact && loosePhone && phone) {
    contact = await findByPhoneLoosely(phone);
    if (contact) console.log(`[frontDesk] matched ${phone} to existing contact ${contact.id} on last 10 digits`);
  }

  // Known already: top up anything we learned this time, then we're done.
  if (contact) {
    const hadPhone = !!contact.phone;
    const patch = {};
    if (phone && !contact.phone) patch.phone = phone;
    if (name && !contact.name)   patch.name = name;
    // Never overwrite an address we already hold; only fill a blank.
    if (cleanEmail && !contact.email) patch.email = cleanEmail;
    const nameCol = NAME_COLUMN[channel];
    if (name && nameCol && nameCol !== "name" && !contact[nameCol]) patch[nameCol] = name;
    if (metaPageId && !contact.meta_page_id) patch.meta_page_id = metaPageId;
    if (Object.keys(patch).length) {
      try { await contact.update(patch); }
      catch (e) { console.warn(`[frontDesk] top-up failed for ${contact.id}: ${e.message}`); }
    }

    // WhatsApp told us who she is (both ids, or her hidden number): keep both
    // ids, merge any duplicate WhatsApp proves is her, and if her number is
    // new to us, ask the app about her plan in the background.
    if (channel === "whatsapp" && (altIdentity || (phone && !hadPhone))) {
      contact = await require("./whatsappIdentity").reconcile(contact, { identity, altIdentity, phone, hadPhone });
      if (phone && !hadPhone) {
        setImmediate(() => require("./campaignIntake").refreshFromApp(contact.id, phone));
      }
    }
    return { contact, isNew: false };
  }

  // 2. New woman: she gets an owner before she gets saved. Round-robin is
  //    scoped to the SAME account we're about to stamp on her, so the rep who
  //    gets her can actually see her in their account-filtered inbox.
  let owner = repId || null;
  if (!owner && assignOwner) {
    try {
      const nextRep = await getNextRepRoundRobin(account);
      owner = nextRep ? nextRep.id : null;
      if (!owner) {
        console.warn(`[frontDesk] no active rep on account ${account} — ${channel} contact created unassigned`);
      }
    } catch (e) {
      console.error("[frontDesk] rep assignment failed, creating unassigned:", e.message);
    }
  }

  const now = new Date();
  const fields = {
    phone: phone || null,
    name:  name || null,
    email: cleanEmail,
    stage,
    status,
    assigned_to: owner,
    whatsapp_account_id: account,
    meta_page_id: metaPageId || null,
    source: source || (channel === "phone" ? "whatsapp" : channel),
    last_message_at: now,
    last_activity_at: now,
    [idColumn]: identity,
    ...(extra || {}),
  };
  // Set once, never overwritten — an existing contact keeps the gate she first
  // arrived through, even if she later turns up somewhere else.
  if (gate && !gateColumnMissing) fields.entry_gate = String(gate).slice(0, 40);
  const nameCol = NAME_COLUMN[channel];
  if (name && nameCol && nameCol !== "name") fields[nameCol] = name;

  // owner_type (migration 031) is how the CRM says who is responsible for her
  // right now: 'rep', 'fiza' or 'app'. It isn't on the People model, so it goes
  // in a separate statement rather than the insert, and it's swallowed so a DB
  // without migration 031 still works. A rep owning her and Fiza working the
  // lead run together — this only records which one is answerable for her.
  const stampOwner = async (c) => {
    try {
      await sequelize.query(
        `UPDATE leads
            SET owner_type = COALESCE(owner_type, :t),
                owner_assigned_at = COALESCE(owner_assigned_at, NOW())
          WHERE id = :id`,
        { replacements: { id: c.id, t: owner ? "rep" : "fiza" } }
      );
    } catch (e) {
      if (!/owner_type/i.test(String(e.message || ""))) {
        console.warn("[frontDesk] owner_type stamp failed:", e.message);
      }
    }
    return c;
  };

  // Her @lid, when this message carried one, goes beside her chat id.
  const rememberLid = async (c) => {
    const lid = channel === "whatsapp" ? [identity, altIdentity].find((j) => /@lid$/.test(String(j || ""))) : null;
    if (lid) {
      await sequelize.query("UPDATE leads SET whatsapp_lid = :lid WHERE id = :id AND whatsapp_lid IS NULL",
        { replacements: { lid, id: c.id } }).catch(() => {}); // column missing before 046
    }
    return c;
  };

  try {
    contact = await People.create(fields);
    return { contact: await rememberLid(await stampOwner(contact)), isNew: true };
  } catch (e) {
    // Migration 038 not run yet: save her without the gate rather than lose her.
    if (isMissingGateColumn(e)) {
      gateColumnMissing = true;
      console.warn("[frontDesk] leads.entry_gate missing — run migration 038. Saving without the gate.");
      delete fields.entry_gate;
      contact = await People.create(fields);
      return { contact: await stampOwner(contact), isNew: true };
    }
    // Two messages from a brand-new contact landing at once: the other one
    // created her first. Re-read instead of dropping this message.
    if (e && e.name === "SequelizeUniqueConstraintError") {
      contact =
        (await People.findOne({ where: { [idColumn]: identity } })) ||
        (phone && channel === "whatsapp" ? await findOnAccountByPhone(phone, account) : null) ||
        (phone ? await findByPhoneLoosely(phone) : null);
      if (contact) return { contact, isNew: false };
    }
    throw e;
  }
}

/* ─────────────────────────────────────────────────────────────
   CHECKS 4 + 5 — write it down, and note when we last spoke.
   ───────────────────────────────────────────────────────────── */

/**
 * saveMessage — the only way a message enters this database.
 *
 * Deduped on the provider's own message id, so a webhook replay or a Baileys
 * re-delivery can never double-count unread or trigger a second AI reply.
 *
 * @returns {Promise<{message: object, duplicate: boolean}>}
 */
async function saveMessage({
  contact,
  direction,                 // "IN" | "OUT"
  channel = "whatsapp",
  from = null,               // any word; normalised to the enum
  text = null,
  accountId = null,
  externalMessageId = null,  // WhatsApp msg id, or Meta mid
  externalThreadId = null,
  repId = null,
  messageType = "text",
  mediaUrl = null,
  mediaMime = null,
  mediaSize = null,
  duration = null,
  fileName = null,
  status = null,
}) {
  if (!contact || !contact.id) throw new Error("frontDesk.saveMessage: no contact");
  if (direction !== "IN" && direction !== "OUT") {
    throw new Error(`frontDesk.saveMessage: direction must be IN or OUT, got "${direction}"`);
  }

  const sender  = normalizeSender(from, direction);
  const account = accountId != null ? Number(accountId)
                : (channel === "whatsapp" ? contact.whatsapp_account_id : null);

  // CHECK 4a — have we seen this exact message before?
  if (externalMessageId) {
    const [seen] = await sequelize.query(
      `SELECT id FROM messages
        WHERE whatsapp_message_id = :mid OR external_message_id = :mid
        LIMIT 1`,
      { replacements: { mid: String(externalMessageId) } }
    );
    if (seen.length > 0) {
      // The Instagram / Facebook adapters write their own copy of every send,
      // always as 'rep' with no rep named. The caller saving it now knows who
      // really sent it (Fiza, or a named rep/admin), so correct the row rather
      // than keep the guess. Without this, Fiza's own Instagram reply counted
      // as a human reply and replyOwner locked her out of that chat for 24 h.
      if (direction === "OUT") {
        await sequelize
          .query(
            "UPDATE messages SET `from` = :sender, rep_id = COALESCE(:repId, rep_id) WHERE id = :id AND direction = 'OUT'",
            { replacements: { sender, repId: repId || null, id: seen[0].id } }
          )
          .catch((e) => console.warn("[frontDesk] sender correction failed:", e.message));
      }
      return { message: { id: seen[0].id }, duplicate: true };
    }
  }

  // CHECK 4b — write it down.
  const [res] = await sequelize.query(
    `INSERT INTO messages (
       lead_id, rep_id, whatsapp_account_id,
       \`from\`, channel, external_message_id, external_thread_id,
       whatsapp_message_id, message, direction, message_type, status, is_read,
       media_url, media_mime, media_size, duration, file_name, created_at
     ) VALUES (
       :leadId, :repId, :account,
       :sender, :channel, :extId, :threadId,
       :waMsgId, :text, :direction, :messageType, :status, :isRead,
       :mediaUrl, :mediaMime, :mediaSize, :duration, :fileName, NOW()
     )`,
    {
      replacements: {
        leadId:   contact.id,
        repId:    repId || contact.assigned_to || null,
        account:  account != null ? account : null,
        sender,
        channel,
        extId:    externalMessageId ? String(externalMessageId) : null,
        threadId: externalThreadId || null,
        waMsgId:  channel === "whatsapp" && externalMessageId ? String(externalMessageId) : null,
        text:     text || null,
        direction,
        messageType,
        status:   status || (direction === "IN" ? "received" : "sent"),
        isRead:   direction === "IN" ? 0 : 1,
        mediaUrl, mediaMime, mediaSize, duration,
        fileName: fileName || null,
      },
    }
  );

  const messageId = insertIdOf(res);

  // CHECK 4c — her unread badge, for inbound only.
  if (direction === "IN") {
    await People.increment({ unread_count: 1 }, { where: { id: contact.id } }).catch((e) =>
      console.error("[frontDesk] unread bump failed:", e.message)
    );
  }

  // CHECK 5 — note when we last spoke. This single line is what stops the
  // follow-up engine from messaging on top of a reply that just went out.
  await sequelize
    .query("UPDATE leads SET last_message_at = NOW() WHERE id = :id", {
      replacements: { id: contact.id },
    })
    .catch((e) => console.error("[frontDesk] last_message_at bump failed:", e.message));

  return {
    message: {
      id: messageId,
      lead_id: contact.id,
      message: text || null,
      direction,
      channel,
      from: sender,
      message_type: messageType,
      media_url: mediaUrl,
      media_mime: mediaMime,
      media_size: mediaSize,
      duration,
      file_name: fileName || null,
      status: status || (direction === "IN" ? "received" : "sent"),
      whatsapp_message_id: channel === "whatsapp" ? externalMessageId : null,
      external_message_id: externalMessageId || null,
      created_at: new Date(),
    },
    duplicate: false,
  };
}

/**
 * receive — the whole front desk in one call, for an inbound message.
 * Finds or creates her, then writes the message down.
 */
async function receive({
  channel,
  identity,
  accountId = null,
  phone = null,
  name = null,
  email = null,
  metaPageId = null,
  source = null,
  gate = null,
  text = null,
  externalMessageId = null,
  externalThreadId = null,
  messageType = "text",
  mediaUrl = null,
  mediaMime = null,
  mediaSize = null,
  duration = null,
  fileName = null,
}) {
  const { contact, isNew } = await findOrCreateContact({
    channel, identity, accountId, phone, name, email, metaPageId, source, gate,
  });

  const { message, duplicate } = await saveMessage({
    contact,
    direction: "IN",
    channel,
    from: "user",
    text,
    accountId,
    externalMessageId,
    externalThreadId,
    messageType,
    mediaUrl, mediaMime, mediaSize, duration, fileName,
  });

  return { contact, message, isNew, duplicate };
}

module.exports = {
  findOrCreateContact,
  findByPhoneLoosely,
  last10,
  normalizeEmail,
  saveMessage,
  receive,
  isSilenced,
  normalizeSender,
  IDENTITY_COLUMN,
};
