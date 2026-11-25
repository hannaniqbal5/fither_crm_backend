/**
 * mergeLead.js — fold a duplicate lead into the real one.
 * Moves messages + ai_replies across, then marks the duplicate as merged
 * (it stays in the DB but disappears from lists).
 *
 *   node script/mergeLead.js <fromId> <toId>          dry run
 *   node script/mergeLead.js <fromId> <toId> apply    do it
 */
const sequelize = require("../src/config/database");

(async () => {
  const fromId = parseInt(process.argv[2]);
  const toId   = parseInt(process.argv[3]);
  const apply  = (process.argv[4] || "").toLowerCase() === "apply";
  if (!fromId || !toId || fromId === toId) {
    console.log("Usage: node script/mergeLead.js <fromId> <toId> [apply]"); process.exit(1);
  }
  try {
    const [rows] = await sequelize.query(
      `SELECT id, phone, stage, fizza_handled, subscription_status, merged_into_lead_id,
              (SELECT COUNT(*) FROM messages m WHERE m.lead_id = leads.id) AS msgs
         FROM leads WHERE id IN (:a, :b)`,
      { replacements: { a: fromId, b: toId } });
    console.log("");
    rows.forEach(r => console.log(
      `  id=${r.id} phone="${r.phone}" stage=${r.stage} subscription=${r.subscription_status} fizza_handled=${r.fizza_handled} msgs=${r.msgs} merged_into=${r.merged_into_lead_id}`));
    if (rows.length < 2) { console.log("\nOne of those leads doesn't exist."); return; }

    if (!apply) { console.log(`\nDry run. To merge ${fromId} -> ${toId}:  node script/mergeLead.js ${fromId} ${toId} apply`); return; }

    const t = await sequelize.transaction();
    try {
      await sequelize.query("UPDATE messages   SET lead_id = :to WHERE lead_id = :from",
        { replacements: { to: toId, from: fromId }, transaction: t });
      await sequelize.query("UPDATE ai_replies SET lead_id = :to WHERE lead_id = :from",
        { replacements: { to: toId, from: fromId }, transaction: t });
      // keep the handoff flag if either side had it
      await sequelize.query(
        `UPDATE leads SET fizza_handled = 1 WHERE id = :to AND EXISTS
           (SELECT 1 FROM (SELECT fizza_handled f FROM leads WHERE id = :from) x WHERE x.f = 1)`,
        { replacements: { to: toId, from: fromId }, transaction: t });
      await sequelize.query("UPDATE leads SET merged_into_lead_id = :to WHERE id = :from",
        { replacements: { to: toId, from: fromId }, transaction: t });
      await t.commit();
      console.log(`\n✅ Merged lead ${fromId} into ${toId}. The duplicate is now hidden.`);
    } catch (e) { await t.rollback(); throw e; }
  } catch (e) {
    console.log("Error:", e.message);
  } finally { await sequelize.close(); }
})();
