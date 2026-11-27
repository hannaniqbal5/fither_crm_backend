/**
 * groupImporter.js — programmatic version of script/exportGroupMembers.js
 *
 * Uses the EXISTING live Baileys connection (no separate session) to:
 *   1. List all WhatsApp groups the business number is a member of
 *   2. Extract member phones from a chosen group
 *   3. Match each one to her lead (WhatsApp ids, app account, phone) or create her,
 *      checking in the app whether her plan is live (campaignIntake.js)
 *   4. Log the import to group_imports table
 *
 * Returns counts so the admin UI can show "245 added, 17 already in CRM".
 */

const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const { jidNormalizedUser } = require("@whiskeysockets/baileys");

const sequelize = require("../config/database");
const { getBaileysClient } = require("../whatsapp/baileysClient");

/**
 * Same LID-resolution helper used by exportGroupMembers.
 * Looks for a phone associated with a Baileys @lid identity in session files.
 */
function resolveFromSessionFiles(accountId, lidUser) {
  const sessionDir = path.resolve(__dirname, `../../baileys_sessions/${accountId}`);
  if (!fs.existsSync(sessionDir)) return null;

  const reverseFile = path.join(sessionDir, `lid-mapping-${lidUser}_reverse.json`);
  if (fs.existsSync(reverseFile)) {
    try {
      const content = JSON.parse(fs.readFileSync(reverseFile, "utf-8"));
      if (typeof content === "string") return content;
    } catch {}
  }
  try {
    const sessionFiles = fs.readdirSync(sessionDir);
    for (const file of sessionFiles) {
      const fwdMatch = file.match(/^lid-mapping-(\d+)\.json$/);
      if (fwdMatch) {
        try {
          const storedLid = JSON.parse(fs.readFileSync(path.join(sessionDir, file), "utf-8"));
          if (typeof storedLid === "string" && storedLid === lidUser) {
            return fwdMatch[1];
          }
        } catch {}
      }
    }
  } catch {}
  return null;
}

/**
 * listGroups — return all groups the business WA number is a member of.
 * @param {number} whatsappAccountId
 * @returns {Promise<Array<{ jid, subject, size, role }>>}
 */
async function listGroups(whatsappAccountId) {
  const sock = getBaileysClient(whatsappAccountId);
  if (!sock) throw new Error(`WhatsApp account ${whatsappAccountId} not connected`);

  const groups = await sock.groupFetchAllParticipating();
  const list = Object.values(groups).map((g) => ({
    jid:     g.id,
    subject: g.subject,
    size:    g.participants?.length || 0,
    role:    (g.participants?.find((p) => p.id === sock.user?.id)?.admin) || "regular",
  }));
  list.sort((a, b) => b.size - a.size);
  return list;
}

/**
 * importGroupMembers — bring a group's members into the CRM and return the
 * lead ids, so a campaign can add exactly these women (Nov 2026 rewrite).
 *
 * The group is a PAID customers' group, so every member paid at some point.
 * Whether she is paying RIGHT NOW comes from the app (campaignIntake.js):
 * active → user; expired or no app account → churned (paid before).
 *
 * Who she is: her number jid, her @lid, her app account, her last 10 digits.
 * An existing woman keeps her record, rep and history; we only fill blanks
 * and add a note saying which campaign and group brought her in.
 *
 * @param {object} options
 * @param {number} options.whatsappAccountId
 * @param {string} [options.groupJid]      exact JID (preferred)
 * @param {string} [options.groupSubject]  partial match on group name (fallback)
 * @param {number} [options.repId]         admin who triggered
 * @param {number} [options.assignedRepId] rep new women are given to
 * @param {object} [options.campaign]      { campaign_id, name } for the trace
 * @param {boolean}[options.skipAppCheck]  import even when the app can't be asked
 * @returns {Promise<{ importId, groupSubject, groupJid, memberJids, leadIds, totals }>}
 */
async function importGroupMembers({ whatsappAccountId, groupJid, groupSubject, repId, assignedRepId, campaign = null, skipAppCheck = false } = {}) {
  if (!whatsappAccountId) throw new Error("whatsappAccountId is required");
  if (!groupJid && !groupSubject) throw new Error("groupJid or groupSubject is required");

  const intake = require("../services/campaignIntake");
  const frontDesk = require("../services/frontDesk");

  const sock = getBaileysClient(whatsappAccountId);
  if (!sock) throw new Error(`WhatsApp account ${whatsappAccountId} not connected`);

  const groups = await sock.groupFetchAllParticipating();
  const target = groupJid
    ? groups[groupJid]
    : Object.values(groups).find((g) => g.subject?.toLowerCase().includes(groupSubject.toLowerCase()));
  if (!target) throw new Error(`Group not found: ${groupJid || groupSubject}`);

  const userPart = (j) => String(j || "").split("@")[0].split(":")[0];
  const norm = (j) => { try { return j ? jidNormalizedUser(j) : null; } catch { return null; } };
  const myPhone = userPart(sock.user?.id).replace(/\D/g, "");
  const myLid = sock.user?.lid ? norm(sock.user.lid) : null;

  // ── Pass 1: who is each member (both WhatsApp ids + phone) ──
  const members = [];
  const memberJids = [];
  let pending = 0;
  let skipped = 0;
  for (const p of target.participants) {
    const ids = [p.id, p.lid, p.phoneNumber, p.jid].map(norm).filter(Boolean);
    const lid = ids.find((j) => j.endsWith("@lid")) || null;
    let pnJid = ids.find((j) => j.endsWith("@s.whatsapp.net")) || null;
    let phone = pnJid ? userPart(pnJid).replace(/\D/g, "") : null;
    if (!phone && lid) {
      try {
        const mapped = await sock.signalRepository?.lidMapping?.getPNForLID?.(lid);
        if (mapped) phone = userPart(mapped).replace(/\D/g, "") || null;
      } catch {}
      if (!phone) phone = resolveFromSessionFiles(whatsappAccountId, userPart(lid));
    }
    if (phone && !pnJid) pnJid = `${phone}@s.whatsapp.net`;
    ids.forEach((j) => memberJids.push(j));

    if ((phone && myPhone && phone === myPhone) || (lid && myLid && lid === myLid)) { skipped++; continue; }
    if (!phone) pending++;
    members.push({ key: String(members.length), lid, pnJid, phone, name: p.notify || p.name || p.verifiedName || null });
  }

  // ── Pass 2: ask the app who is paying right now ──
  let truthMap = null;
  if (!skipAppCheck) {
    try {
      truthMap = await intake.lookupApp(members.filter((m) => m.phone).map((m) => ({ key: m.key, phone: m.phone })));
    } catch (e) {
      const err = new Error(`Could not check subscriptions in the app (${e.message}). Nothing was imported. Try again, or import with skipAppCheck to save them as "paid before" without the check.`);
      err.status = 502;
      throw err;
    }
  }

  // ── Pass 3: match or create, then record what we know ──
  // A/B pair: each woman's note names the side she will be on.
  const ab = campaign?.campaign_id ? await intake.abInfo(campaign.campaign_id) : null;
  const leadIds = [];
  const verdicts = {};
  let added = 0;
  let matched = 0;
  for (const m of members) {
    try {
      // Not checked (skipAppCheck), or LID with no number: undefined = unknown.
      const truth = truthMap && m.phone ? (truthMap.get(m.key) ?? null) : undefined;
      let leadId = null;
      let isNew = false;

      const found = await intake.findExisting({
        jids: [m.pnJid, m.lid], lid: m.lid, appUserId: truth && truth.app_user_id, phone: m.phone,
      });
      if (found) {
        leadId = found.id;
        matched++;
      } else {
        const { contact, isNew: created } = await frontDesk.findOrCreateContact({
          channel: "whatsapp",
          identity: m.pnJid || m.lid,
          accountId: whatsappAccountId,
          phone: m.phone,
          name: m.name,
          repId: assignedRepId || null,
          assignOwner: false,
          loosePhone: true,
          source: "whatsapp",
          gate: "group_import",
          extra: { language: "ur" },
        });
        leadId = contact.id;
        isNew = created;
        if (created) added++; else matched++;
      }
      if (!leadId) continue;

      await intake.backfillIds(leadId, { pnJid: m.pnJid, lid: m.lid, phone: m.phone });
      // The group listed both her number and her @lid: WhatsApp's proof they
      // are one account. Fold any duplicate holding the other id into one.
      if (m.lid && m.pnJid) {
        const { People } = require("../../models");
        const me = await People.findByPk(leadId);
        const kept = await require("../services/whatsappIdentity").reconcile(me, {
          identity: m.pnJid, altIdentity: m.lid, phone: m.phone, hadPhone: true,
        });
        if (kept && kept.id) leadId = kept.id;
      }
      if (assignedRepId) {
        await sequelize.query(
          "UPDATE leads SET assigned_to = :rep WHERE id = :id AND assigned_to IS NULL",
          { replacements: { rep: assignedRepId, id: leadId } }
        );
      }
      const { verdict } = await intake.applyIntake(leadId, {
        truth,
        isNew,
        claim: { paidBefore: true },
        trace: {
          campaignId: intake.campaignFor(ab, campaign, leadId)?.campaign_id || null,
          campaignName: intake.campaignFor(ab, campaign, leadId)?.name || null,
          source: "group_import",
          label: target.subject,
        },
      });
      verdicts[verdict] = (verdicts[verdict] || 0) + 1;
      leadIds.push(leadId);
    } catch (err) {
      console.error(`❌ [groupImporter] ${m.pnJid || m.lid}: ${err.message}`);
    }
  }

  // Audit log (members_skipped = already in CRM + our own number)
  const importId = uuidv4();
  await sequelize.query(
    `INSERT INTO group_imports
       (import_id, group_subject, group_jid, whatsapp_account_id,
        members_total, members_added, members_skipped, members_pending, imported_by)
     VALUES
       (:import_id, :subject, :jid, :acc, :total, :added, :skipped, :pending, :rep)`,
    {
      replacements: {
        import_id: importId, subject: target.subject, jid: target.id, acc: whatsappAccountId,
        total: target.participants.length, added, skipped: skipped + matched, pending, rep: repId || null,
      },
    }
  );

  console.log(
    `📥 [groupImporter] ${target.subject}: ${added} new, ${matched} already in CRM, ` +
    `${pending} without a number, app: ${JSON.stringify(verdicts)}`
  );

  return {
    importId,
    groupSubject: target.subject,
    groupJid: target.id,
    memberJids: [...new Set(memberJids)],
    leadIds: [...new Set(leadIds)],
    totals: {
      total: target.participants.length,
      added,
      already_in_crm: matched,
      skipped: matched + skipped, // already in CRM + our own number (dashboard reads this)
      pending,               // no phone could be found (matched by WhatsApp id only)
      app: verdicts,         // active / past_customer / not_in_app_paid_before ...
    },
  };
}

module.exports = { listGroups, importGroupMembers };
