/**
 * deleteLead.js — permanently delete a lead and its conversation.
 * Removes messages + ai_replies, then the lead row itself. No undo.
 *
 *   node script/deleteLead.js <id>          dry run — shows what would go
 *   node script/deleteLead.js <id> apply    delete it
 */
const sequelize = require("../src/config/database");

(async () => {
  const id = parseInt(process.argv[2]);
  const apply = (process.argv[3] || "").toLowerCase() === "apply";
  if (!id) { console.log("Usage: node script/deleteLead.js <id> [apply]"); process.exit(1); }
  try {
    const [[lead]] = await sequelize.query(
      "SELECT id, phone, name, stage, merged_into_lead_id FROM leads WHERE id = :id",
      { replacements: { id } });
    if (!lead) { console.log(`Lead ${id} not found.`); return; }

    const [[{ msgs }]] = await sequelize.query(
      "SELECT COUNT(*) AS msgs FROM messages WHERE lead_id = :id", { replacements: { id } });
    const [[{ reps }]] = await sequelize.query(
      "SELECT COUNT(*) AS reps FROM ai_replies WHERE lead_id = :id", { replacements: { id } });

    console.log(`\nLead #${lead.id}  phone="${lead.phone}"  stage=${lead.stage}`);
    console.log(`Will delete: ${msgs} message(s), ${reps} ai_reply row(s), and the lead itself.`);

    if (!apply) { console.log(`\nDry run. To delete:  node script/deleteLead.js ${id} apply`); return; }

    const t = await sequelize.transaction();
    try {
      await sequelize.query("DELETE FROM ai_replies WHERE lead_id = :id", { replacements: { id }, transaction: t });
      await sequelize.query("DELETE FROM messages   WHERE lead_id = :id", { replacements: { id }, transaction: t });
      await sequelize.query("DELETE FROM leads      WHERE id = :id",      { replacements: { id }, transaction: t });
      await t.commit();
      console.log(`\n✅ Lead ${id} deleted permanently.`);
    } catch (e) { await t.rollback(); throw e; }
  } catch (e) {
    console.log("Error:", e.message);
  } finally { await sequelize.close(); }
})();
