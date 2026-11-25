/**
 * groupImporter.js — programmatic version of script/exportGroupMembers.js
 *
 * Uses the EXISTING live Baileys connection (no separate session) to:
 *   1. List all WhatsApp groups the business number is a member of
 *   2. Extract member phones from a chosen group
 *   3. Insert them into the leads table (skip duplicates by JID/phone)
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
const { Pipeline, Event } = require("../../models");

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
 * importGroupMembers — extract members from a single group + insert into CRM.
 *
 * @param {object} options
 * @param {number} options.whatsappAccountId
 * @param {string} [options.groupJid]      — exact JID (preferred)
 * @param {string} [options.groupSubject]  — partial match on group name (fallback)
 * @param {number} [options.repId]         — admin who triggered
 * @param {number} [options.assignedRepId] — sales rep to attribute new leads to (Phase 19a)
 * @returns {Promise<{ importId, groupSubject, groupJid, totals }>}
 */
async function importGroupMembers({ whatsappAccountId, groupJid, groupSubject, repId, assignedRepId } = {}) {
  if (!whatsappAccountId) throw new Error("whatsappAccountId is required");
  if (!groupJid && !groupSubject) throw new Error("groupJid or groupSubject is required");

  const sock = getBaileysClient(whatsappAccountId);
  if (!sock) throw new Error(`WhatsApp account ${whatsappAccountId} not connected`);

  // Find the group
  const groups = await sock.groupFetchAllParticipating();
  let target;
  if (groupJid) {
    target = groups[groupJid];
  } else {
    target = Object.values(groups).find((g) =>
      g.subject?.toLowerCase().includes(groupSubject.toLowerCase())
    );
  }

  if (!target) {
    throw new Error(`Group not found: ${groupJid || groupSubject}`);
  }

  // Walk participants
  let added = 0;
  let skipped = 0;
  let pending = 0;
  const memberJids = [];   // every normalized participant JID — used to scope campaign recipients

  for (const participant of target.participants) {
    try {
      const jid = jidNormalizedUser(participant.id);
      memberJids.push(jid);
      let phone = null;

      if (jid.endsWith("@s.whatsapp.net")) {
        phone = jid.replace("@s.whatsapp.net", "").split(":")[0];
      } else if (jid.endsWith("@lid")) {
        const lidUser = jid.replace("@lid", "").split(":")[0];
        phone = resolveFromSessionFiles(whatsappAccountId, lidUser);
        if (!phone) pending++;
      }

      // Skip the business number itself
      if (phone && sock.user?.id?.includes(phone)) {
        skipped++;
        continue;
      }

      // Existing by JID?
      const [existsByJid] = await sequelize.query(
        `SELECT id FROM leads WHERE whatsapp_jid = :jid LIMIT 1`,
        { replacements: { jid } }
      );
      if (existsByJid.length > 0) {
        skipped++;
        continue;
      }

      // Existing by phone (and account)?
      if (phone) {
        const [existsByPhone] = await sequelize.query(
          `SELECT id FROM leads WHERE phone = :phone AND whatsapp_account_id = :acc LIMIT 1`,
          { replacements: { phone, acc: whatsappAccountId } }
        );
        if (existsByPhone.length > 0) {
          // Update missing JID on existing record
          await sequelize.query(
            `UPDATE leads SET whatsapp_jid = :jid WHERE id = :id AND whatsapp_jid IS NULL`,
            { replacements: { jid, id: existsByPhone[0].id } }
          );
          // Phase 19a: backfill assigned_to ONLY if not already assigned
          // (existing rep relationship wins — never clobber)
          if (assignedRepId) {
            await sequelize.query(
              `UPDATE leads SET assigned_to = :rep WHERE id = :id AND assigned_to IS NULL`,
              { replacements: { rep: assignedRepId, id: existsByPhone[0].id } }
            );
          }
          skipped++;
          continue;
        }
      }

      // Insert new lead (Phase 19a: include assigned_to from campaign rep)
      const name = participant.notify || participant.name || null;
      // One door in. These imports come from a PAID customers' group, so the
      // shape stays deliberately different: stage 'user', status 'converted',
      // Urdu, and the rep the campaign already chose rather than round robin.
      const frontDesk = require("../services/frontDesk");
      const { contact: imported, isNew: importedIsNew } = await frontDesk.findOrCreateContact({
        channel:     "whatsapp",
        identity:    jid,
        accountId:   whatsappAccountId,
        phone,
        name,
        stage:       "user",
        status:      "converted",
        repId:       assignedRepId || null,
        assignOwner: false,
        loosePhone:  true,
        source:      "whatsapp",
        gate:        "group_import",
        extra:       { language: "ur" },
      });

      // The front desk matches on the last 10 digits, which is wider than the
      // exact-phone pre-check above, so it can recognise a woman this importer
      // used to add a second time. Count her as skipped, not added.
      if (!importedIsNew) {
        if (assignedRepId) {
          await sequelize.query(
            `UPDATE leads SET assigned_to = :rep WHERE id = :id AND assigned_to IS NULL`,
            { replacements: { rep: assignedRepId, id: imported.id } }
          );
        }
        skipped++;
        continue;
      }

      const newLeadId = imported.id;
      added++;

      // Mirror what importToCRM.js does: pipeline row + manual_reengagement event
      try {
        await Pipeline.upsert({
          pipeline_id: uuidv4(),
          lead_id: newLeadId,
          stage: "converted",
          assigned_agent_id: null,
          stage_entered_at: new Date(),
        });
      } catch {}

      try {
        await Event.create({
          event_id: uuidv4(),
          lead_id: newLeadId,
          event_type: "manual_reengagement",
          payload: { source: "group_import", group: target.subject, jid },
          processed: 0,
        });
      } catch {}

    } catch (err) {
      console.error(`❌ [groupImporter] ${participant.id}: ${err.message}`);
    }
  }

  // Audit log
  const importId = uuidv4();
  await sequelize.query(
    `INSERT INTO group_imports
       (import_id, group_subject, group_jid, whatsapp_account_id,
        members_total, members_added, members_skipped, members_pending, imported_by)
     VALUES
       (:import_id, :subject, :jid, :acc, :total, :added, :skipped, :pending, :rep)`,
    {
      replacements: {
        import_id: importId,
        subject: target.subject,
        jid: target.id,
        acc: whatsappAccountId,
        total: target.participants.length,
        added, skipped, pending,
        rep: repId || null,
      },
    }
  );

  console.log(
    `📥 [groupImporter] ${target.subject}: ` +
    `${added} added, ${skipped} skipped, ${pending} LID-only pending`
  );

  return {
    importId,
    groupSubject: target.subject,
    groupJid: target.id,
    memberJids,                // NEW — used by campaign.routes.js to scope recipients to this group only
    totals: { total: target.participants.length, added, skipped, pending },
  };
}

module.exports = { listGroups, importGroupMembers };
