/**
 * setFizzaHandled.js — hand a lead over to Fizza (or take it back) without
 * having to send them a message first.
 *
 *   node script/setFizzaHandled.js <id>       show current
 *   node script/setFizzaHandled.js <id> on    Fizza auto-replies to this lead
 *   node script/setFizzaHandled.js <id> off   back to rep drafts only
 */
const sequelize = require("../src/config/database");

(async () => {
  const id = parseInt(process.argv[2]);
  const arg = (process.argv[3] || "").toLowerCase();
  if (!id) { console.log("Usage: node script/setFizzaHandled.js <id> [on|off]"); process.exit(1); }
  try {
    const [[lead]] = await sequelize.query(
      "SELECT id, phone, stage, fizza_handled FROM leads WHERE id = :id", { replacements: { id } });
    if (!lead) { console.log(`Lead ${id} not found.`); return; }
    console.log(`\nLead #${lead.id} ${lead.phone} stage=${lead.stage} fizza_handled=${lead.fizza_handled}`);

    if (arg !== "on" && arg !== "off") { console.log(`\nTo enable:  node script/setFizzaHandled.js ${id} on`); return; }
    const v = arg === "on" ? 1 : 0;
    await sequelize.query("UPDATE leads SET fizza_handled = :v WHERE id = :id", { replacements: { v, id } });
    console.log(`\n✅ fizza_handled: ${lead.fizza_handled} -> ${v}`);
    if (v === 1 && lead.stage === "user") console.log("   ⚠ stage is still 'user', so Fizza will skip this lead anyway.");
  } catch (e) {
    console.log("Error:", e.message);
  } finally { await sequelize.close(); }
})();
