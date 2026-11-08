/**
 * importToCRM.js
 *
 * Reads exports/group_members.csv and imports each member into the CRM:
 *   - Creates person in leads table with stage = 'user'
 *   - Handles both resolved (phone) and unresolved (LID-only) members
 *   - Fires 'manual_reengagement' event for automation engine
 *   - Skips duplicates (by phone or JID)
 *
 * For LID-only members (no phone), the phone will auto-fill when they
 * message the business number — the remoteJidAlt fix handles this.
 *
 * Usage: node script/importToCRM.js
 */

const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const { People, Event, Pipeline, sequelize } = require("../models");

const CSV_FILE = path.resolve(__dirname, "../exports/group_members.csv");
const WHATSAPP_ACCOUNT_ID = 1;

async function main() {
  try {
    await sequelize.authenticate();
    console.log("✅ Database connected");
  } catch (err) {
    console.error("❌ Database connection failed:", err.message);
    process.exit(1);
  }

  if (!fs.existsSync(CSV_FILE)) {
    console.error(`❌ CSV not found: ${CSV_FILE}`);
    console.error("   Run exportGroupMembers.js first");
    process.exit(1);
  }

  const raw = fs.readFileSync(CSV_FILE, "utf-8");
  const lines = raw.trim().split("\n");
  const rows = lines.slice(1); // skip header

  console.log(`📋 Found ${rows.length} members in CSV\n`);

  let created = 0;
  let skipped = 0;
  let errors = 0;

  for (const row of rows) {
    // Parse CSV: phone,"name",admin,jid
    // phone can be empty for LID-only members
    let phone, name, jid;

    const match = row.match(/^([^,]*),"([^"]*)",([^,]+),(.+)$/);
    if (match) {
      [, phone, name, , jid] = match;
    } else {
      const parts = row.split(",");
      if (parts.length < 4) {
        console.warn(`  ⚠️ Skipping malformed row: ${row}`);
        errors++;
        continue;
      }
      [phone, name, , jid] = parts;
    }

    phone = (phone || "").trim() || null;
    name = (name || "").trim() || null;
    jid = (jid || "").trim();

    if (!jid) {
      console.warn(`  ⚠️ Skipping row with no JID: ${row}`);
      errors++;
      continue;
    }

    try {
      // Check by JID first (works for both LID and phone JIDs)
      const existingByJid = await People.findOne({
        where: { whatsapp_jid: jid },
      });

      if (existingByJid) {
        console.log(`  ⏭️  ${phone || jid} (${name || "no name"}) — already exists (id: ${existingByJid.id})`);
        skipped++;
        continue;
      }

      // Check by phone if we have one
      if (phone) {
        const existingByPhone = await People.findOne({
          where: { phone, whatsapp_account_id: WHATSAPP_ACCOUNT_ID },
        });

        if (existingByPhone) {
          // Update JID on existing record if missing
          if (!existingByPhone.whatsapp_jid) {
            await existingByPhone.update({ whatsapp_jid: jid });
            console.log(`  🔄 ${phone} (${name || "no name"}) — updated JID on existing (id: ${existingByPhone.id})`);
          } else {
            console.log(`  ⏭️  ${phone} (${name || "no name"}) — already exists by phone (id: ${existingByPhone.id})`);
          }
          skipped++;
          continue;
        }
      }

      // Create person
      const person = await People.create({
        phone,
        name,
        whatsapp_jid: jid,
        stage: "user",
        status: "converted",
        language: "ur",
        whatsapp_account_id: WHATSAPP_ACCOUNT_ID,
        source: "whatsapp",
        last_activity_at: new Date(),
        last_message_at: null,
      });

      // Create pipeline row
      await Pipeline.create({
        pipeline_id: uuidv4(),
        lead_id: person.id,
        stage: "converted",
        assigned_agent_id: null,
        stage_entered_at: new Date(),
      });

      // Fire re-engagement event
      await Event.create({
        event_id: uuidv4(),
        lead_id: person.id,
        event_type: "manual_reengagement",
        payload: JSON.stringify({
          source: "group_import",
          group: "March Fither(sania2k25)",
          phone: phone || jid,
        }),
        processed: 0,
      });

      const label = phone ? `${phone} (${name || "no name"})` : `${jid} (${name || "no name"}) [LID-only]`;
      console.log(`  ✅ ${label} — created (id: ${person.id})`);
      created++;
    } catch (err) {
      console.error(`  ❌ ${phone || jid} — error: ${err.message}`);
      errors++;
    }
  }

  console.log(`\n========== IMPORT COMPLETE ==========`);
  console.log(`  ✅ Created: ${created}`);
  console.log(`  ⏭️  Skipped: ${skipped}`);
  console.log(`  ❌ Errors:  ${errors}`);
  console.log(`  📊 Total:   ${rows.length}`);

  if (created > 0) {
    console.log(`\n💡 ${created} 'manual_reengagement' events queued.`);
    console.log(`   Start the server — automation engine will pick them up.`);
    console.log(`\n📌 LID-only members (no phone) will auto-resolve when they message you.`);
  }

  await sequelize.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Import failed:", err.message);
  process.exit(1);
});
