/**
 * assignUnowned.js — give every lead that has no rep a rep, by the admin's rule
 * (Team → "New leads go to"). Fiza works WITH a rep; she is never the owner.
 *
 *   - She has written on WhatsApp → a rep on that WhatsApp number (her chat
 *     lives on that number, the rep must see it and reply from it).
 *   - She hasn't (app signup / import) → any rep by the rule, and her lead is
 *     put on that rep's number.
 * Opted-out and merged leads are left alone.
 *
 * Usage (from the CRM folder):
 *   node script/assignUnowned.js --dry-run     preview, changes nothing
 *   node script/assignUnowned.js               assign
 *   node script/assignUnowned.js --source=app  only app leads
 */
require("dotenv").config();
const sequelize = require("../src/config/database");
const { getNextRepRoundRobin } = require("../src/services/assignment.service");

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const SOURCE = (args.find((a) => a.startsWith("--source=")) || "").split("=")[1] || null;

async function main() {
  const [leads] = await sequelize.query(
    `SELECT id, name, phone, source, whatsapp_jid, whatsapp_account_id
       FROM leads
      WHERE assigned_to IS NULL
        AND merged_into_lead_id IS NULL
        AND COALESCE(interaction_status, '') <> 'opted_out'
        ${SOURCE ? "AND source = :source" : ""}
      ORDER BY id ASC`,
    { replacements: { source: SOURCE } }
  );
  console.log(`${leads.length} lead(s) without a rep${SOURCE ? ` (source ${SOURCE})` : ""}`);
  const perRep = {};
  let none = 0, errors = 0;

  for (const l of leads) {
    try {
      const onWhatsApp = !!l.whatsapp_jid;
      const rep = await getNextRepRoundRobin(onWhatsApp ? l.whatsapp_account_id : null);
      if (!rep) { none++; continue; }
      perRep[rep.name] = (perRep[rep.name] || 0) + 1;
      if (DRY) continue;
      await sequelize.query(
        `UPDATE leads
            SET assigned_to = :rep,
                whatsapp_account_id = :acc,
                owner_type = 'rep',
                owner_assigned_at = NOW()
          WHERE id = :id AND assigned_to IS NULL`,
        { replacements: { rep: rep.id, acc: onWhatsApp ? l.whatsapp_account_id : rep.whatsapp_account_id, id: l.id } }
      ).catch(async (e) => {
        if (!/owner_type|owner_assigned_at/.test(e.message)) throw e; // migration 031 not run
        await sequelize.query(
          "UPDATE leads SET assigned_to = :rep, whatsapp_account_id = :acc WHERE id = :id AND assigned_to IS NULL",
          { replacements: { rep: rep.id, acc: onWhatsApp ? l.whatsapp_account_id : rep.whatsapp_account_id, id: l.id } }
        );
      });
    } catch (e) {
      errors++;
      console.error(`  lead ${l.id}: ${e.message}`);
    }
  }
  console.log(`\n${DRY ? "DRY RUN — nothing changed" : "Done"}. Leads per rep:`);
  console.table(perRep);
  if (none) console.log(`${none} could not get a rep (nobody in the rotation for their WhatsApp number).`);
  if (errors) console.log(`${errors} error(s) — see above.`);
}

main()
  .then(() => sequelize.close())
  .catch(async (e) => { console.error("Failed:", e.message); await sequelize.close().catch(() => {}); process.exitCode = 1; });
