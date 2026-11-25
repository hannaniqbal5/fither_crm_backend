/**
 * setLeadStage.js — change a lead's stage.
 * stage is ENUM: visitor | lead | user | churned
 * Fizza only sells to NON-'user' leads, so a wrongly-'user' row goes silent.
 *
 *   node script/setLeadStage.js <id>              show current
 *   node script/setLeadStage.js <id> lead         set to lead
 */
const sequelize = require("../src/config/database");
const VALID = ["visitor", "lead", "user", "churned"];

(async () => {
  const id = parseInt(process.argv[2]);
  const stage = (process.argv[3] || "").toLowerCase();
  if (!id) { console.log("Usage: node script/setLeadStage.js <id> [visitor|lead|user|churned]"); process.exit(1); }
  try {
    const [[before]] = await sequelize.query(
      "SELECT id, phone, stage, subscription_status, fizza_handled FROM leads WHERE id = :id",
      { replacements: { id } });
    if (!before) { console.log(`Lead ${id} not found.`); return; }
    console.log(`\nLead #${before.id} ${before.phone}`);
    console.log(`  stage=${before.stage}  subscription=${before.subscription_status}  fizza_handled=${before.fizza_handled}`);

    if (!stage) { console.log(`\nTo change:  node script/setLeadStage.js ${id} lead`); return; }
    if (!VALID.includes(stage)) { console.log(`\nInvalid stage. Use one of: ${VALID.join(", ")}`); return; }

    await sequelize.query("UPDATE leads SET stage = :s WHERE id = :id", { replacements: { s: stage, id } });
    console.log(`\n✅ stage: ${before.stage} -> ${stage}`);
    if (stage !== "user" && !before.fizza_handled) {
      console.log("   Note: fizza_handled is 0, so send her one message from Fizza Chats to hand the lead over.");
    }
  } catch (e) {
    console.log("Error:", e.message);
  } finally { await sequelize.close(); }
})();
